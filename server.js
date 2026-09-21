const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Docker = require('dockerode');
const si = require('systeminformation');

const PORT = process.env.PORT || 4000;
// per-container CPU% (below) matches `docker stats`' convention: percent of
// ONE core, so a single busy container can legitimately show >100%. That's
// fine and expected for one container, but summing several of them for a
// group card crosses 100% far more easily and just reads as broken. This
// is used to convert a group's *summed* CPU% into percent of total host
// capacity instead, which is naturally bounded 0-100 -- os.cpus() is a
// synchronous, zero-latency call, so this costs nothing per request.
const HOST_CORES = os.cpus().length || 1;
const HTTPS_PORT = process.env.HTTPS_PORT || 4443;
const PACKAGE_VERSION = require('./package.json').version;
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ---- figure out our own container id, so we can hide ourselves from the list ----

function getSelfContainerId() {
  try {
    // works for both cgroup v1 (".../docker/<64-hex-id>") and v2
    // (e.g. "0::/system.slice/docker-<64-hex-id>.scope") layouts.
    const raw = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match = raw.match(/[0-9a-f]{64}/);
    if (match) return match[0];
  } catch (e) { /* not available outside Linux containers */ }
  return null;
}

const SELF_ID = getSelfContainerId();
const SELF_NAME = 'pinnule'; // matches container_name in docker-compose.yml, used as a fallback

// ---- persisted URL overrides (server-side, so they survive across browsers/devices) ----

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const OVERRIDES_FILE = path.join(DATA_DIR, 'url-overrides.json');

// ---- self-signed TLS certificate, generated once and kept in the data
// volume so it survives container restarts/recreations (otherwise a fresh
// cert on every restart would make the browser re-show the "not trusted"
// warning every time, even after you'd already told it to trust pinnule) ----

const TLS_DIR = path.join(DATA_DIR, 'tls');
const TLS_KEY_FILE = path.join(TLS_DIR, 'key.pem');
const TLS_CERT_FILE = path.join(TLS_DIR, 'cert.pem');

function ensureTlsCert() {
  if (fs.existsSync(TLS_KEY_FILE) && fs.existsSync(TLS_CERT_FILE)) {
    return { key: fs.readFileSync(TLS_KEY_FILE), cert: fs.readFileSync(TLS_CERT_FILE) };
  }
  fs.mkdirSync(TLS_DIR, { recursive: true });
  try {
    execSync(
      `openssl req -x509 -nodes -days 3650 -newkey rsa:2048 ` +
      `-keyout "${TLS_KEY_FILE}" -out "${TLS_CERT_FILE}" -subj "/CN=pinnule"`,
      { stdio: 'ignore' }
    );
  } catch (err) {
    console.error('Could not generate a self-signed TLS certificate (is openssl installed in the image?):', err.message);
    process.exit(1);
  }
  try { fs.chmodSync(TLS_KEY_FILE, 0o600); } catch (e) { /* best effort on some filesystems */ }
  return { key: fs.readFileSync(TLS_KEY_FILE), cert: fs.readFileSync(TLS_CERT_FILE) };
}

function loadUrlOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveUrlOverrides(overrides) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
}

let urlOverrides = loadUrlOverrides();

// ---- auth: single local account, credentials + session secret kept on the
// persisted data volume, never in source control or logs ----

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session-secret.txt');

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveAuth(auth) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (e) { /* best effort on some filesystems */ }
}

function loadOrCreateSessionSecret() {
  try {
    return fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
  } catch (e) {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_SECRET_FILE, secret, { mode: 0o600 });
    try { fs.chmodSync(SESSION_SECRET_FILE, 0o600); } catch (e2) { /* best effort */ }
    return secret;
  }
}

let auth = loadAuth();

// Setup does two awaited bcrypt.hash() calls before persisting -- a second
// concurrent request could pass the `if (auth)` check while the first is
// still mid-hash, and whichever saves last would silently win. This flag is
// set/checked synchronously (no `await` between the check and the set), so
// it closes that gap the same way reserveAttempt() does for rate limiting.
let setupInProgress = false;

// sessions carry the credential epoch that was current when they were
// issued. Bumping it on password change/recovery invalidates every other
// session transparently -- requireAuth just stops accepting the old
// epoch -- without needing to enumerate or touch the session store itself.
function currentCredentialEpoch() {
  return (auth && auth.credentialEpoch) || 1;
}
const SESSION_SECRET = loadOrCreateSessionSecret();

// very small brute-force guard for login and account-recovery attempts,
// keyed by "type:ip". in-memory only: resets on restart, which is fine for
// its purpose.
//
// reserveAttempt() checks the bucket AND increments it in one synchronous
// step -- no `await` in between -- so a burst of concurrent requests can't
// all read the same pre-increment count before any of them get recorded.
// The previous check-then-record-after-bcrypt shape had exactly that gap.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const attemptTracker = new Map();
const DUMMY_HASH = '$2a$12$./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy'; // fixed 60-char bcrypt-shaped hash used to equalize compare() timing when the real target doesn't exist

function reserveAttempt(type, ip) {
  const key = `${type}:${ip}`;
  const now = Date.now();
  const entry = attemptTracker.get(key);
  if (entry && now - entry.firstAttempt <= RATE_WINDOW_MS) {
    if (entry.count >= RATE_MAX_ATTEMPTS) return false;
    entry.count += 1;
    return true;
  }
  attemptTracker.set(key, { count: 1, firstAttempt: now });
  return true;
}

function clearAttempts(type, ip) {
  attemptTracker.delete(`${type}:${ip}`);
}

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

const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SHORT_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours, for shared/kiosk screens

// The session middleware below uses `rolling: true`, which re-arms
// cookie.maxAge on every request. That's the point for "remembered"
// sessions, but it quietly defeats the "short" kiosk session: the dashboard
// polls the API every few seconds on its own, so a screen left open would
// never actually go 8 hours without "activity" and would never log out.
// To keep the short session's promise, non-remembered logins also get an
// absolute wall-clock deadline that requireAuth enforces regardless of
// how recently the cookie was touched.
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

const app = express();
// No `trust proxy` here: the default deployment (network_mode: host, no
// reverse proxy in front) means there's no upstream to strip incoming
// X-Forwarded-For headers, so trusting them would let anyone spoof the IP
// the rate limiter keys on. Secure-cookie detection doesn't need it either
// now that pinnule serves HTTPS itself (req.secure reflects the real
// connection). If you do put pinnule behind a real reverse proxy later,
// trust proxy should be re-added scoped to that proxy's actual address.
app.use(express.json());

app.use(session({
  name: 'pinnule.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto', // only sent over https when the connection actually is https
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days, refreshed on activity
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// CSRF: sameSite:'lax' on the session cookie already blocks the most common
// cross-site POST vector in modern browsers, but it's the only control in
// place, and only on the routes that happen to rely on cookies at all. This
// checks Origin (falling back to Referer) against the request's own Host
// header for every state-changing request -- deployment-agnostic, since
// pinnule might be reached via different hostnames/IPs on the LAN, so there's
// no single "correct" origin to hardcode. Applies globally rather than
// per-route so it covers every current and future POST/PUT/DELETE endpoint,
// not just the container lifecycle ones.
function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const originHeader = req.headers.origin || req.headers.referer;
  if (!originHeader) {
    return res.status(403).json({ error: 'missing origin' });
  }
  let originHost;
  try {
    originHost = new URL(originHeader).host;
  } catch (e) {
    return res.status(403).json({ error: 'invalid origin' });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: 'cross-origin request blocked' });
  }
  next();
}
app.use(requireSameOrigin);

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

// ---- auth routes ----

app.get('/api/auth/status', (req, res) => {
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

app.post('/api/auth/setup', async (req, res) => {
  if (auth || setupInProgress) {
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
    auth = {
      username: username.trim(),
      passwordHash,
      recoveryCodeHash,
      credentialEpoch: 1,
      createdAt: new Date().toISOString(),
    };
    try {
      saveAuth(auth);
    } catch (err) {
      auth = null;
      return res.status(500).json({ error: `could not save credentials: ${err.message}` });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'could not start session' });
      req.session.authenticated = true;
      req.session.username = auth.username;
      req.session.credentialEpoch = currentCredentialEpoch();
      applySessionLength(req, remember);
      res.json({ ok: true, username: auth.username, recoveryCode });
    });
  } finally {
    // harmless to release even after success: `auth` being set now blocks
    // any further attempt on its own, via the check at the top of this route
    setupInProgress = false;
  }
});

app.post('/api/auth/login', async (req, res) => {
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

app.post('/api/auth/recover', async (req, res) => {
  if (!auth) {
    return res.status(409).json({ error: 'setup not completed' });
  }
  const ip = req.ip;
  if (!reserveAttempt('recover', ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

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
    saveAuth(auth);
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
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pinnule.sid');
    res.json({ ok: true });
  });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
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
    saveAuth(auth);
  } catch (err) {
    return res.status(500).json({ error: `could not save new password: ${err.message}` });
  }
  req.session.credentialEpoch = currentCredentialEpoch(); // keep this session valid; every other one is now stale
  res.json({ ok: true });
});

app.post('/api/auth/recovery-code/regenerate', requireAuth, async (req, res) => {
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
    saveAuth(auth);
  } catch (err) {
    return res.status(500).json({ error: `could not save new recovery code: ${err.message}` });
  }
  res.json({ ok: true, recoveryCode });
});

// ---- containers: auto-detected from the Docker socket, no config needed ----

function cpuPercentFromStats(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cores = stats.cpu_stats.cpu_usage.percpu_usage
      ? stats.cpu_stats.cpu_usage.percpu_usage.length
      : (stats.cpu_stats.online_cpus || 1);
    if (sysDelta > 0 && cpuDelta > 0) return (cpuDelta / sysDelta) * cores * 100;
  } catch (e) { /* stats shape varies briefly on container start/stop */ }
  return null;
}

// When a container publishes several ports, just taking whichever one
// Docker happened to list first often picks the wrong one (a metrics or
// API port ahead of the real web UI). Prefer a match against the
// container's private/internal port, since that's what the app itself is
// actually bound to, and only fall back to "first listed" when nothing
// here matches.
const PREFERRED_WEB_PORTS = [
  80, 443, 8080, 8443, 3000, 5000, 8081, 8888, 9000, 9090,
  8096, 8123, 32400, 5055, 19999, 8006, 81,
];

function pickAppPort(ports) {
  if (!ports.length) return null;
  for (const preferred of PREFERRED_WEB_PORTS) {
    const match = ports.find(p => p.private === preferred);
    if (match) return match;
  }
  return ports[0];
}

// Docker labels come from whatever image/compose file a container was
// started with -- not something pinnule controls -- so pinnule.url has to
// be treated as untrusted input. Only http/https can end up as a link.
function isSafeAppUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// inspect() returns labels/restart count/start time — data that barely
// changes between polls — but was being re-fetched from the Docker API for
// every container on every poll cycle. Cache it briefly per container id
// instead; entries for containers that disappear (removed/recreated) get
// pruned below so this can't grow unbounded over time.
const inspectCache = new Map(); // id -> { restartCount, startedAt, labels, fetchedAt }
const INSPECT_CACHE_TTL_MS = 30 * 1000;

async function getContainerMeta(id, fallbackLabels) {
  const cached = inspectCache.get(id);
  if (cached && (Date.now() - cached.fetchedAt) < INSPECT_CACHE_TTL_MS) return cached;
  const inspect = await docker.getContainer(id).inspect();
  const meta = {
    restartCount: inspect.RestartCount || 0,
    startedAt: inspect.State && inspect.State.StartedAt,
    labels: (inspect.Config && inspect.Config.Labels) || fallbackLabels || {},
    fetchedAt: Date.now(),
  };
  inspectCache.set(id, meta);
  return meta;
}

// Containers started by the same `docker compose` stack all carry the same
// com.docker.compose.project label automatically -- no extra config needed.
// Group them into one card instead of cluttering the grid with every
// service of a multi-container app (onlyoffice's five containers, a
// db+cache+app stack, etc). A project with only one member is left as a
// normal standalone container -- most single-service compose projects
// shouldn't be wrapped for no reason.
function groupByComposeProject(enriched) {
  const groups = new Map();
  const standalone = [];

  for (const item of enriched) {
    if (!item.composeProject) {
      standalone.push(item);
      continue;
    }
    if (!groups.has(item.composeProject)) groups.set(item.composeProject, []);
    groups.get(item.composeProject).push(item);
  }

  const result = standalone.map(item => ({ kind: 'container', ...item }));

  for (const [project, members] of groups) {
    if (members.length === 1) {
      result.push({ kind: 'container', ...members[0] });
      continue;
    }

    const runningCount = members.filter(m => m.state === 'running').length;
    const totalCount = members.length;
    // pick one member to represent the group's link/icon: prefer an
    // explicit override, then whichever auto-detected a working URL at all
    // (the actual web UI, typically -- a db or search container usually
    // won't have published ports pinnule would pick up), else just the first
    const primary =
      members.find(m => m.urlOverridden) ||
      members.find(m => m.appUrl) ||
      members[0];
    const anyStats = members.some(m => m.cpuPct != null);
    const cpuPctSummed = anyStats ? members.reduce((sum, m) => sum + (m.cpuPct || 0), 0) : null;
    // each member's cpuPct is "% of one core" (docker stats convention);
    // summed across N containers that's no longer intuitive to read the
    // same way -- convert to "% of total host capacity" instead, which is
    // what a "how much of my machine is this whole stack using" figure
    // should actually mean. Math.min as a safety net for the sampling-
    // timing jitter between each container's own stats snapshot.
    const cpuPct = cpuPctSummed != null ? Math.min(cpuPctSummed / HOST_CORES, 100) : null;
    const memUsed = anyStats ? members.reduce((sum, m) => sum + (m.memUsed || 0), 0) : null;
    // memory *limit* isn't additive across containers on the same host when
    // none of them have an explicit per-container limit set (the common
    // case) -- they'd all just report the host's total RAM, and summing
    // that five times would be nonsense. Max is the sane aggregate either way.
    const memLimit = Math.max(0, ...members.map(m => m.memLimit || 0)) || null;
    const startedAt = members.map(m => m.startedAt).filter(Boolean).sort()[0] || null;
    const createdValues = members.map(m => m.created).filter(v => v != null);
    // com.docker.compose.project is usually just whatever directory the
    // compose file lives in (e.g. "docker-communityserver"), not a name
    // anyone chose on purpose -- a pinnule.name label on any member of the
    // stack overrides the display name without needing to rename the
    // actual compose project
    const displayName = (members.find(m => m.nameOverride) || {}).nameOverride || project;

    result.push({
      kind: 'group',
      name: displayName,
      memberIds: members.map(m => m.id),
      memberNames: members.map(m => m.name),
      runningCount,
      totalCount,
      appUrl: primary.appUrl,
      autoUrl: primary.autoUrl,
      urlOverridden: primary.urlOverridden,
      icon: primary.icon,
      cpuPct, memUsed, memLimit,
      restartCount: members.reduce((sum, m) => sum + (m.restartCount || 0), 0),
      startedAt,
      created: createdValues.length ? Math.min(...createdValues) : null,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

app.get('/api/containers', requireAuth, async (req, res) => {
  try {
    const list = await docker.listContainers({ all: true });
    const others = list.filter(c => {
      if (SELF_ID) return c.Id !== SELF_ID;
      const name = (c.Names && c.Names[0] || '').replace(/^\//, '');
      return name !== SELF_NAME;
    });

    const currentIds = new Set(others.map(c => c.Id));
    for (const id of inspectCache.keys()) {
      if (!currentIds.has(id)) inspectCache.delete(id);
    }

    const enriched = await Promise.all(others.map(async (c) => {
      const name = (c.Names && c.Names[0] || c.Id.slice(0, 12)).replace(/^\//, '');
      let cpuPct = null, memUsed = null, memLimit = null;
      let restartCount = 0, startedAt = null, labels = c.Labels || {};

      try {
        const meta = await getContainerMeta(c.Id, c.Labels);
        restartCount = meta.restartCount;
        startedAt = meta.startedAt;
        labels = meta.labels;
      } catch (e) { /* container may disappear during polling */ }

      if (c.State === 'running') {
        try {
          const stats = await docker.getContainer(c.Id).stats({ stream: false });
          cpuPct = cpuPercentFromStats(stats);
          const cache = (stats.memory_stats.stats && stats.memory_stats.stats.cache) || 0;
          memUsed = stats.memory_stats.usage - cache;
          memLimit = stats.memory_stats.limit;
        } catch (e) { /* container may have stopped mid-poll */ }
      }

      const ports = (c.Ports || []).filter(p => p.PublicPort).map(p => ({
        public: p.PublicPort, private: p.PrivatePort, protocol: p.Type || 'tcp'
      }));
      const appPort = pickAppPort(ports);
      const autoUrl = appPort ? `http://${req.hostname}:${appPort.public}` : null;
      const rawLabelUrl = labels['pinnule.url'];
      const labelUrl = (rawLabelUrl && isSafeAppUrl(rawLabelUrl)) ? rawLabelUrl : autoUrl;
      const hasOverride = Object.prototype.hasOwnProperty.call(urlOverrides, name);
      const appUrl = hasOverride ? urlOverrides[name] : labelUrl;
      const icon = labels['pinnule.icon'] || null;
      const nameOverride = labels['pinnule.name'] || null;
      const composeProject = labels['com.docker.compose.project'] || null;

      return {
        id: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports,
        appUrl,
        autoUrl: labelUrl,
        urlOverridden: hasOverride,
        icon,
        nameOverride,
        restartCount,
        startedAt,
        created: c.Created,
        cpuPct, memUsed, memLimit,
        composeProject,
      };
    }));

    res.json(groupByComposeProject(enriched));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- host hardware stats ----

const EXCLUDED_FS_TYPES = new Set([
  'tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs',
  'cgroup', 'cgroup2', 'devpts', 'mqueue', 'shm', 'ramfs', 'aufs',
]);

function collectHostDisks(allDisks) {
  const seen = new Map();
  for (const d of allDisks) {
    if (!d.mount || !d.mount.startsWith('/hostfs')) continue;
    if (EXCLUDED_FS_TYPES.has((d.type || '').toLowerCase())) continue;
    if (!d.size || d.size <= 0) continue;
    const mount = d.mount === '/hostfs' ? '/' : d.mount.slice('/hostfs'.length);
    const isRoot = mount === '/';
    const isUnderMnt = mount.startsWith('/mnt/');
    if (!isRoot && !isUnderMnt) continue; // only the main disk and anything under /mnt/
    if (seen.has(mount)) continue; // dedupe repeated bind-mount entries
    seen.set(mount, {
      mount,
      fsType: d.type,
      totalBytes: d.size,
      usedBytes: d.used,
      usedPct: d.use,
    });
  }
  return [...seen.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

app.get('/api/system', requireAuth, async (req, res) => {
  try {
    const [cpu, cpuData, mem, allDisks, temp, defaultIface] = await Promise.all([
      si.currentLoad(),
      si.cpu(),
      si.mem(),
      si.fsSize(),
      si.cpuTemperature(),
      si.networkInterfaceDefault(),
    ]);

    let net = null;
    try {
      const ns = await si.networkStats(defaultIface);
      if (ns && ns[0]) net = { iface: ns[0].iface, rxSec: ns[0].rx_sec, txSec: ns[0].tx_sec };
    } catch (e) { /* interface may not be resolvable, e.g. bridge-only networking */ }

    const disks = collectHostDisks(allDisks);

    res.json({
      cpu: {
        loadPct: cpu.currentLoad,
        cores: cpuData.cores,
        model: `${cpuData.manufacturer} ${cpuData.brand}`.trim(),
      },
      memory: {
        totalBytes: mem.total,
        usedBytes: mem.active,
        usedPct: mem.total ? (mem.active / mem.total) * 100 : null,
      },
      disks,
      temp: { c: (temp && typeof temp.main === 'number' && temp.main > 0) ? temp.main : null },
      uptimeSec: os.uptime(),
      network: net,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- container controls ----

// container IDs the app itself hands out are always a 12-char hex prefix
// (see c.Id.slice(0, 12) below), but accept up to a full 64-char id too.
// Rejecting anything else here means a crafted :id containing URL-structural
// characters (?, /, #...) never reaches dockerode's own request building.
function isValidContainerId(id) {
  return typeof id === 'string' && /^[a-f0-9]{12,64}$/i.test(id);
}

app.post('/api/containers/:id/start', requireAuth, async (req, res) => {
  if (!isValidContainerId(req.params.id)) {
    return res.status(400).json({ error: 'invalid container id' });
  }
  try {
    await docker.getContainer(req.params.id).start();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/stop', requireAuth, async (req, res) => {
  if (!isValidContainerId(req.params.id)) {
    return res.status(400).json({ error: 'invalid container id' });
  }
  try {
    await docker.getContainer(req.params.id).stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/restart', requireAuth, async (req, res) => {
  if (!isValidContainerId(req.params.id)) {
    return res.status(400).json({ error: 'invalid container id' });
  }
  try {
    await docker.getContainer(req.params.id).restart();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- custom app URLs (keyed by container name, persisted to disk) ----

app.put('/api/containers/:name/url', requireAuth, (req, res) => {
  const name = req.params.name;
  const url = (req.body && typeof req.body.url === 'string') ? req.body.url.trim() : '';
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!isSafeAppUrl(url)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }
  urlOverrides[name] = url;
  try {
    saveUrlOverrides(urlOverrides);
  } catch (err) {
    return res.status(500).json({ error: `could not save: ${err.message}` });
  }
  res.json({ ok: true, name, url });
});

app.delete('/api/containers/:name/url', requireAuth, (req, res) => {
  const name = req.params.name;
  delete urlOverrides[name];
  try {
    saveUrlOverrides(urlOverrides);
  } catch (err) {
    return res.status(500).json({ error: `could not save: ${err.message}` });
  }
  res.json({ ok: true, name });
});

const tlsOptions = ensureTlsCert();

https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
  console.log(`pinnule listening on :${HTTPS_PORT} (https, self-signed cert)`);
});

// plain HTTP no longer serves the app directly -- it only redirects to the
// HTTPS port, so the login password is never sent in cleartext, while old
// bookmarks/links to the http port still land somewhere useful
http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
  res.end();
}).listen(PORT, () => {
  console.log(`pinnule redirecting :${PORT} -> :${HTTPS_PORT} (http)`);
});
