const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/app/data';

// ---- persisted URL overrides (server-side, so they survive across browsers/devices) ----

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

// never reassigned (only ever mutated via [] = / delete below), so it's
// safe to close over directly -- every function below shares this exact
// object, including across other modules that call these functions
let urlOverrides = loadUrlOverrides();

function getUrlOverride(name) {
  return urlOverrides[name];
}

function hasUrlOverride(name) {
  return Object.prototype.hasOwnProperty.call(urlOverrides, name);
}

function setUrlOverride(name, url) {
  urlOverrides[name] = url;
  saveUrlOverrides(urlOverrides); // throws on failure -- caller's responsibility to catch
}

function deleteUrlOverride(name) {
  delete urlOverrides[name];
  saveUrlOverrides(urlOverrides); // throws on failure -- caller's responsibility to catch
}

// ---- hidden containers (same persistence pattern, so a hide preference
// survives container rebuilds/redeploys) ----

const HIDDEN_FILE = path.join(DATA_DIR, 'hidden-containers.json');

function loadHiddenContainers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveHiddenContainers(hidden) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HIDDEN_FILE, JSON.stringify(hidden, null, 2));
}

let hiddenContainers = loadHiddenContainers();

function isHidden(name) {
  return hiddenContainers.includes(name);
}

function hideContainer(name) {
  if (!hiddenContainers.includes(name)) {
    hiddenContainers.push(name);
    try {
      saveHiddenContainers(hiddenContainers);
    } catch (err) {
      hiddenContainers = hiddenContainers.filter(n => n !== name);
      throw err;
    }
  }
}

function unhideContainer(name) {
  const wasHidden = hiddenContainers.includes(name);
  hiddenContainers = hiddenContainers.filter(n => n !== name);
  try {
    saveHiddenContainers(hiddenContainers);
  } catch (err) {
    if (wasHidden) hiddenContainers.push(name);
    throw err;
  }
}

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

function saveAuthToDisk(authObj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authObj, null, 2), { mode: 0o600 });
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

// returns the live internal reference (not a copy) -- callers that need to
// change a field (recover, change-password, regenerate-code) mutate it
// directly, e.g. `getAuth().passwordHash = newHash`, then call persistAuth()
// with that same object to write it to disk. This mirrors exactly how the
// pre-refactor code mutated the shared `auth` variable's fields in place.
function getAuth() {
  return auth;
}

// updates the in-memory reference AND writes to disk; throws on save
// failure without changing the in-memory reference, so a failed save never
// leaves the app believing something is persisted when it isn't
function persistAuth(authObj) {
  saveAuthToDisk(authObj); // throws first, before the reference below ever changes
  auth = authObj;
}

// setup-failure rollback only: undoes an in-memory auth that was set before
// its save was known to have failed
function clearAuth() {
  auth = null;
}

// sessions carry the credential epoch that was current when they were
// issued. Bumping it on password change/recovery invalidates every other
// session transparently -- requireAuth just stops accepting the old
// epoch -- without needing to enumerate or touch the session store itself.
function currentCredentialEpoch() {
  return (auth && auth.credentialEpoch) || 1;
}

module.exports = {
  getUrlOverride, hasUrlOverride, setUrlOverride, deleteUrlOverride,
  isHidden, hideContainer, unhideContainer,
  getAuth, persistAuth, clearAuth, currentCredentialEpoch,
  SESSION_SECRET,
};
