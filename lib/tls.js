const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || '/app/data';

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

module.exports = { ensureTlsCert };
