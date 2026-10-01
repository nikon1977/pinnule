const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { getAuth, persistAuth, clearAuth, currentCredentialEpoch } = require('../lib/stores');
const { reserveAttempt, clearAttempts } = require('../lib/rate-limit');
const { applySessionLength, isSessionInvalid, requireAuth } = require('../lib/session');

const PACKAGE_VERSION = require('../package.json').version;

const DUMMY_HASH = '$2a$12$./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy'; // fixed 60-char bcrypt-shaped hash used to equalize compare() timing when the real target doesn't exist

// recovery codes: shown once at setup (and once each time they're used /
// regenerated), stored only as a bcrypt hash — same treatment as the
// password itself.
const RECOVERY_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L, easier to transcribe by hand
function generateRecoveryCode() {
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += RECOVERY_CODE_CHARSET[crypto.randomInt(RECOVERY_CODE_CHARSET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

// Setup does two awaited bcrypt.hash() calls before persisting -- a second
// concurrent request could pass the `if (auth)` check while the first is
// still mid-hash, and whichever saves last would silently win. This flag is
// set/checked synchronously (no `await` between the check and the set), so
// it closes that gap the same way reserveAttempt() does for rate limiting.
let setupInProgress = false;

// Same class of race as setupInProgress above, in /api/auth/recover instead:
// two concurrent recovery attempts using the same still-valid recovery code
// could both pass the bcrypt.compare check before either rotates it, then
// both proceed to set a new password + recovery code -- whichever saves
// last silently wins, and the other request's caller is shown a recovery
// code that's already stale.
let recoverInProgress = false;

const router = express.Router();

router.get('/status', (req, res) => {
  const auth = getAuth();
  if (isSessionInvalid(req)) {
    return req.session.destroy(() => {
      res.clearCookie('pinnule.sid');
      res.json({ setupRequired: !auth, authenticated: false, username: auth ? auth.username : null, version: PACKAGE_VERSION });
    });
  }
  res.json({
    setupRequired: !auth,
    authenticated: !!(req.session && req.session.authenticated),
    username: auth ? auth.username : null,
    version: PACKAGE_VERSION,
  });
});

router.post('/setup', async (req, res) => {
  if (getAuth() || setupInProgress) {
    return res.status(409).json({ error: 'setup already completed' });
  }
  setupInProgress = true;
  try {
    const { username, password, confirmPassword, remember } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'username is required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'passwords do not match' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(recoveryCode, 12);
    const newAuth = {
      username: username.trim(),
      passwordHash,
      recoveryCodeHash,
      credentialEpoch: 1,
      createdAt: new Date().toISOString(),
    };
    try {
      persistAuth(newAuth);
    } catch (err) {
      clearAuth();
      return res.status(500).json({ error: `could not save credentials: ${err.message}` });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'could not start session' });
      req.session.authenticated = true;
      req.session.username = newAuth.username;
      req.session.credentialEpoch = currentCredentialEpoch();
      applySessionLength(req, remember);
      res.json({ ok: true, username: newAuth.username, recoveryCode });
    });
  } finally {
    // harmless to release even after success: `auth` being set now blocks
    // any further attempt on its own, via the check at the top of this route
    setupInProgress = false;
  }
});

router.post('/login', async (req, res) => {
  const auth = getAuth();
  if (!auth) {
    return res.status(409).json({ error: 'setup not completed' });
  }
  const ip = req.ip;
  if (!reserveAttempt('login', ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const { username, password, remember } = req.body || {};
  const providedUsername = typeof username === 'string' ? username.trim() : '';
  const providedPassword = typeof password === 'string' ? password : '';

  const usernameMatches = providedUsername === auth.username;
  // always run bcrypt.compare, even on a username mismatch, against a fixed
  // dummy hash, so response timing doesn't reveal whether the username exists
  const hashToCheck = usernameMatches ? auth.passwordHash : DUMMY_HASH;
  // captured before the async gap below: if a password change/recovery
  // completes while this bcrypt.compare is in flight, hashToCheck is now
  // stale even though the compare still reports a match against it, and
  // currentCredentialEpoch() would read the *new* epoch by the time we're
  // back here -- stamping a session that verified an old password with a
  // new epoch, defeating the whole point of that epoch existing
  const epochAtCheckStart = currentCredentialEpoch();
  const passwordMatches = await bcrypt.compare(providedPassword, hashToCheck).catch(() => false);

  if (!usernameMatches || !passwordMatches) {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  if (auth.passwordHash !== hashToCheck || currentCredentialEpoch() !== epochAtCheckStart) {
    // credentials changed mid-verification; what we just checked is stale
    return res.status(401).json({ error: 'credentials changed, please try again' });
  }

  clearAttempts('login', ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'could not start session' });
    req.session.authenticated = true;
    req.session.username = auth.username;
    req.session.credentialEpoch = currentCredentialEpoch();
    applySessionLength(req, remember);
    res.json({ ok: true, username: auth.username });
  });
});

router.post('/recover', async (req, res) => {
  if (!getAuth()) {
    return res.status(409).json({ error: 'setup not completed' });
  }
  const ip = req.ip;
  if (!reserveAttempt('recover', ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (recoverInProgress) {
    return res.status(409).json({ error: 'a recovery is already in progress, try again shortly' });
  }
  recoverInProgress = true;
  try {
    const auth = getAuth();
    const { username, recoveryCode, newPassword, confirmNewPassword, remember } = req.body || {};
    const providedUsername = typeof username === 'string' ? username.trim() : '';
    const providedCode = typeof recoveryCode === 'string' ? recoveryCode.trim().toUpperCase() : '';

    const usernameMatches = providedUsername === auth.username;
    const hashToCheck = (usernameMatches && auth.recoveryCodeHash) ? auth.recoveryCodeHash : DUMMY_HASH;
    const codeMatches = await bcrypt.compare(providedCode, hashToCheck).catch(() => false);

    if (!usernameMatches || !codeMatches) {
      return res.status(401).json({ error: 'invalid username or recovery code' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'new password must be at least 8 characters' });
    }
    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ error: 'new passwords do not match' });
    }

    clearAttempts('recover', ip);
    auth.passwordHash = await bcrypt.hash(newPassword, 12);
    // account recovery is exactly the "I think someone else has my
    // credentials" case, so this is the one place that must invalidate every
    // other session, not just this one
    auth.credentialEpoch = currentCredentialEpoch() + 1;
    // rotate the recovery code so the one just used can't be reused
    const newRecoveryCode = generateRecoveryCode();
    auth.recoveryCodeHash = await bcrypt.hash(newRecoveryCode, 12);
    try {
      persistAuth(auth);
    } catch (err) {
      return res.status(500).json({ error: `could not save new password: ${err.message}` });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'could not start session' });
      req.session.authenticated = true;
      req.session.username = auth.username;
      req.session.credentialEpoch = currentCredentialEpoch();
      applySessionLength(req, remember);
      res.json({ ok: true, username: auth.username, recoveryCode: newRecoveryCode });
    });
  } finally {
    recoverInProgress = false;
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pinnule.sid');
    res.json({ ok: true });
  });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const auth = getAuth();
  // keyed by session, not IP: the threat here is a stolen session cookie
  // used as an unlimited password-guessing oracle, not a network attacker
  if (!reserveAttempt('reauth', req.sessionID)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  const { currentPassword, newPassword, confirmNewPassword } = req.body || {};
  const currentMatches = await bcrypt.compare(
    typeof currentPassword === 'string' ? currentPassword : '',
    auth.passwordHash
  ).catch(() => false);

  if (!currentMatches) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'new password must be at least 8 characters' });
  }
  if (newPassword !== confirmNewPassword) {
    return res.status(400).json({ error: 'new passwords do not match' });
  }

  clearAttempts('reauth', req.sessionID);
  auth.passwordHash = await bcrypt.hash(newPassword, 12);
  auth.credentialEpoch = currentCredentialEpoch() + 1;
  try {
    persistAuth(auth);
  } catch (err) {
    return res.status(500).json({ error: `could not save new password: ${err.message}` });
  }
  req.session.credentialEpoch = currentCredentialEpoch(); // keep this session valid; every other one is now stale
  res.json({ ok: true });
});

router.post('/recovery-code/regenerate', requireAuth, async (req, res) => {
  const auth = getAuth();
  if (!reserveAttempt('reauth', req.sessionID)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  const { currentPassword } = req.body || {};
  const currentMatches = await bcrypt.compare(
    typeof currentPassword === 'string' ? currentPassword : '',
    auth.passwordHash
  ).catch(() => false);

  if (!currentMatches) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }

  clearAttempts('reauth', req.sessionID);
  const recoveryCode = generateRecoveryCode();
  auth.recoveryCodeHash = await bcrypt.hash(recoveryCode, 12);
  try {
    persistAuth(auth);
  } catch (err) {
    return res.status(500).json({ error: `could not save new recovery code: ${err.message}` });
  }
  res.json({ ok: true, recoveryCode });
});

module.exports = router;
