const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');

const { ensureTlsCert } = require('./lib/tls');
const { SESSION_SECRET } = require('./lib/stores');

const authRoutes = require('./routes/auth');
const containerRoutes = require('./routes/containers');
const systemRoutes = require('./routes/system');

const PORT = process.env.PORT || 4000;
// for reverse-proxy setups (NPM, Traefik, Caddy, etc.) where the proxy
// itself terminates HTTPS and forwards plain HTTP internally -- the normal,
// standard pattern most self-hosted apps expect. Without this, pinnule's
// own redirect sends the browser to connect directly to HTTPS_PORT,
// bypassing the proxy entirely; if that port isn't reachable from wherever
// the browser actually is (which is often the point of running a proxy --
// keeping only its own ports open), the request just hangs with no error.
const DISABLE_HTTPS_REDIRECT = process.env.DISABLE_HTTPS_REDIRECT === 'true';
const HTTPS_PORT = process.env.HTTPS_PORT || 4443;

const app = express();
// No `trust proxy` here: the default deployment (network_mode: host, no
// reverse proxy in front) means there's no upstream to strip incoming
// X-Forwarded-For headers, so trusting them would let anyone spoof the IP
// the rate limiter keys on. Secure-cookie detection doesn't need it either
// now that pinnule serves HTTPS itself (req.secure reflects the real
// connection). If you do put pinnule behind a real reverse proxy later,
// trust proxy should be re-added scoped to that proxy's actual address.
app.use(express.json());

// explicit reference to the store, rather than letting express-session
// create its own implicit one, so the periodic prune below can reach it
const sessionStore = new session.MemoryStore();

app.use(session({
  name: 'pinnule.sid',
  store: sessionStore,
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

// MemoryStore only checks a session's expiry when something actually reads
// it (get/all/touch, verified against expressjs/session's own source) -- a
// session that simply lapses client-side (tab closed, cookie expired) with
// no further requests is never read again, so it just sits here forever.
// .all() checks every stored session's expiry internally and deletes any
// that have passed as a side effect of reading them, so periodically
// calling it (result unused) is the entire fix -- no separate expiry
// check needed on our end.
const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for sessions that live hours-to-weeks
setInterval(() => sessionStore.all(() => {}), SESSION_PRUNE_INTERVAL_MS);

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

app.use('/api/auth', authRoutes);
app.use('/api/containers', containerRoutes);
app.use('/api/system', systemRoutes);

const tlsOptions = ensureTlsCert();

https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
  console.log(`pinnule listening on :${HTTPS_PORT} (https, self-signed cert)`);
});

if (DISABLE_HTTPS_REDIRECT) {
  // reverse-proxy mode: serve the app directly over plain HTTP here, and
  // let the proxy in front of this be the one deciding what happens with
  // HTTPS at the edge -- HTTPS_PORT above still runs too, for anyone who
  // wants to reach pinnule directly alongside the proxied route
  http.createServer(app).listen(PORT, () => {
    console.log(`pinnule listening on :${PORT} (http, DISABLE_HTTPS_REDIRECT set -- for use behind a reverse proxy)`);
  });
} else {
  // plain HTTP doesn't serve the app directly -- it only redirects to the
  // HTTPS port, so the login password is never sent in cleartext, while old
  // bookmarks/links to the http port still land somewhere useful
  http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
    res.end();
  }).listen(PORT, () => {
    console.log(`pinnule redirecting :${PORT} -> :${HTTPS_PORT} (http)`);
  });
}
