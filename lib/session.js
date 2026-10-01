const { currentCredentialEpoch } = require('./stores');

const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SHORT_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours, for shared/kiosk screens

// The session middleware (see server.js) uses `rolling: true`, which
// re-arms cookie.maxAge on every request. That's the point for
// "remembered" sessions, but it quietly defeats the "short" kiosk session:
// the dashboard polls the API every few seconds on its own, so a screen
// left open would never actually go 8 hours without "activity" and would
// never log out. To keep the short session's promise, non-remembered
// logins also get an absolute wall-clock deadline that requireAuth
// enforces regardless of how recently the cookie was touched.
function applySessionLength(req, remember) {
  if (remember === false) {
    req.session.cookie.maxAge = SHORT_SESSION_MS;
    req.session.absoluteExpiresAt = Date.now() + SHORT_SESSION_MS;
  } else {
    req.session.cookie.maxAge = REMEMBER_SESSION_MS;
    delete req.session.absoluteExpiresAt;
  }
}

function isSessionExpired(req) {
  return !!(req.session && req.session.absoluteExpiresAt && Date.now() > req.session.absoluteExpiresAt);
}

// A session that predates the last password change/recovery carries a
// credential epoch older than the current one -- treat it the same as an
// expired session so a compromised session can't outlive a password reset.
function isSessionInvalid(req) {
  if (isSessionExpired(req)) return true;
  return !!(req.session && req.session.authenticated && req.session.credentialEpoch !== currentCredentialEpoch());
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    if (isSessionInvalid(req)) {
      return req.session.destroy(() => {
        res.clearCookie('pinnule.sid');
        res.status(401).json({ error: 'session expired' });
      });
    }
    return next();
  }
  res.status(401).json({ error: 'not authenticated' });
}

module.exports = {
  applySessionLength,
  isSessionExpired,
  isSessionInvalid,
  requireAuth,
};
