const net = require('net');
const os = require('os');
const si = require('systeminformation');

// ---- the server's own address, for the host panel and container links ----

// first non-internal IPv4 address on an interface; DISPLAY_IP overrides it
function ipv4For(iface) {
  if (process.env.DISPLAY_IP) return process.env.DISPLAY_IP;
  const addrs = (os.networkInterfaces()[iface] || [])
    .filter(a => (a.family === 'IPv4' || a.family === 4) && !a.internal);
  return addrs.length ? addrs[0].address : null;
}

// the server's LAN address on its default interface (needs network_mode:
// host, as in the bundled compose file -- in bridge mode this would be the
// container's own address, so set APP_HOST there instead)
async function serverIp() {
  const iface = await si.networkInterfaceDefault().catch(() => null);
  return iface ? ipv4For(iface) : null;
}

// Host to put in auto-detected container links. Opened by IP address, the
// links use that same address. Opened by a name such as a reverse-proxy
// hostname, the links would point at the proxy, which only forwards
// pinnule itself -- so use the server's own address instead. APP_HOST
// overrides both, for a hostname that reaches the server directly.
async function linkHost(requestHostname) {
  if (process.env.APP_HOST) return process.env.APP_HOST;
  if (net.isIP(requestHostname)) return requestHostname;
  return (await serverIp()) || requestHostname;
}

module.exports = { ipv4For, linkHost };
