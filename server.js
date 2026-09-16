const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Docker = require('dockerode');
const si = require('systeminformation');

const PORT = process.env.PORT || 4000;
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
const SESSION_SECRET = loadOrCreateSessionSecret();

// very small brute-force guard for login and account-recovery attempts,
// keyed by "type:ip". in-memory only: resets on restart, which is fine for
// its purpose.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const attemptTracker = new Map();
const DUMMY_HASH = '$2a$12$./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy'; // fixed 60-char bcrypt-shaped hash used to equalize compare() timing when the real target doesn't exist

function tooManyAttempts(type, ip) {
  const key = `${type}:${ip}`;
  const now = Date.now();
  const entry = attemptTracker.get(key);
  if (!entry || now - entry.firstAttempt > RATE_WINDOW_MS) return false;
  return entry.count >= RATE_MAX_ATTEMPTS;
}

function recordAttempt(type, ip, succeeded) {
  const key = `${type}:${ip}`;
  const now = Date.now();
  if (succeeded) {
    attemptTracker.delete(key);
    return;
  }
  const entry = attemptTracker.get(key);
  if (!entry || now - entry.firstAttempt > RATE_WINDOW_MS) {
    attemptTracker.set(key, { count: 1, firstAttempt: now });
  } else {
    entry.count += 1;
  }
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

const app = express();
app.set('trust proxy', 1); // so secure cookies work correctly if run behind a reverse proxy
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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    if (isSessionExpired(req)) {
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
  if (isSessionExpired(req)) {
    return req.session.destroy(() => {
      res.clearCookie('pinnule.sid');
      res.json({ setupRequired: !auth, authenticated: false, username: auth ? auth.username : null });
    });
  }
  res.json({
    setupRequired: !auth,
    authenticated: !!(req.session && req.session.authenticated),
    username: auth ? auth.username : null,
  });
});

app.post('/api/auth/setup', async (req, res) => {
  if (auth) {
    return res.status(409).json({ error: 'setup already completed' });
  }
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
    applySessionLength(req, remember);
    res.json({ ok: true, username: auth.username, recoveryCode });
  });
});

app.post('/api/auth/login', async (req, res) => {
  if (!auth) {
    return res.status(409).json({ error: 'setup not completed' });
  }
  const ip = req.ip;
  if (tooManyAttempts('login', ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const { username, password, remember } = req.body || {};
  const providedUsername = typeof username === 'string' ? username.trim() : '';
  const providedPassword = typeof password === 'string' ? password : '';

  const usernameMatches = providedUsername === auth.username;
  // always run bcrypt.compare, even on a username mismatch, against a fixed
  // dummy hash, so response timing doesn't reveal whether the username exists
  const hashToCheck = usernameMatches ? auth.passwordHash : DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(providedPassword, hashToCheck).catch(() => false);

  if (!usernameMatches || !passwordMatches) {
    recordAttempt('login', ip, false);
    return res.status(401).json({ error: 'invalid username or password' });
  }

  recordAttempt('login', ip, true);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'could not start session' });
    req.session.authenticated = true;
    req.session.username = auth.username;
    applySessionLength(req, remember);
    res.json({ ok: true, username: auth.username });
  });
});

app.post('/api/auth/recover', async (req, res) => {
  if (!auth) {
    return res.status(409).json({ error: 'setup not completed' });
  }
  const ip = req.ip;
  if (tooManyAttempts('recover', ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const { username, recoveryCode, newPassword, confirmNewPassword, remember } = req.body || {};
  const providedUsername = typeof username === 'string' ? username.trim() : '';
  const providedCode = typeof recoveryCode === 'string' ? recoveryCode.trim().toUpperCase() : '';

  const usernameMatches = providedUsername === auth.username;
  const hashToCheck = (usernameMatches && auth.recoveryCodeHash) ? auth.recoveryCodeHash : DUMMY_HASH;
  const codeMatches = await bcrypt.compare(providedCode, hashToCheck).catch(() => false);

  if (!usernameMatches || !codeMatches) {
    recordAttempt('recover', ip, false);
    return res.status(401).json({ error: 'invalid username or recovery code' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'new password must be at least 8 characters' });
  }
  if (newPassword !== confirmNewPassword) {
    return res.status(400).json({ error: 'new passwords do not match' });
  }

  recordAttempt('recover', ip, true);
  auth.passwordHash = await bcrypt.hash(newPassword, 12);
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

  auth.passwordHash = await bcrypt.hash(newPassword, 12);
  try {
    saveAuth(auth);
  } catch (err) {
    return res.status(500).json({ error: `could not save new password: ${err.message}` });
  }
  res.json({ ok: true });
});

app.post('/api/auth/recovery-code/regenerate', requireAuth, async (req, res) => {
  const { currentPassword } = req.body || {};
  const currentMatches = await bcrypt.compare(
    typeof currentPassword === 'string' ? currentPassword : '',
    auth.passwordHash
  ).catch(() => false);

  if (!currentMatches) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }

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
      const autoUrl = ports.length ? `http://${req.hostname}:${ports[0].public}` : null;
      const labelUrl = labels['pinnule.url'] || autoUrl;
      const hasOverride = Object.prototype.hasOwnProperty.call(urlOverrides, name);
      const appUrl = hasOverride ? urlOverrides[name] : labelUrl;
      const icon = labels['pinnule.icon'] || null;

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
        restartCount,
        startedAt,
        created: c.Created,
        cpuPct, memUsed, memLimit,
      };
    }));

    enriched.sort((a, b) => a.name.localeCompare(b.name));
    res.json(enriched);
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

app.post('/api/containers/:id/start', requireAuth, async (req, res) => {
  try {
    await docker.getContainer(req.params.id).start();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/stop', requireAuth, async (req, res) => {
  try {
    await docker.getContainer(req.params.id).stop();
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

app.listen(PORT, () => {
  console.log(`pinnule listening on :${PORT}`);
});
