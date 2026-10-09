const fs = require('fs');
const os = require('os');
const express = require('express');
const si = require('systeminformation');

const { requireAuth } = require('../lib/session');

const router = express.Router();

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

// ---- host identity: read once, it doesn't change while we're running ----
// Prefer the host's own files through the read-only /hostfs mount, so the
// panel shows the server's name and distro rather than the container's
// (alpine). Falls back to what Node sees when /hostfs isn't mounted.

function readFileTrim(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; }
}

const HOST_NAME = process.env.DISPLAY_HOSTNAME
  || readFileTrim('/hostfs/etc/hostname')
  || os.hostname();

const HOST_OS = process.env.DISPLAY_OS || (() => {
  const rel = readFileTrim('/hostfs/etc/os-release') || readFileTrim('/etc/os-release') || '';
  const m = rel.match(/^PRETTY_NAME="?([^"\n]*)"?/m);
  return m ? m[1] : `${os.type()} ${os.release()}`;
})();

function ipv4For(iface) {
  if (process.env.DISPLAY_IP) return process.env.DISPLAY_IP;
  const addrs = (os.networkInterfaces()[iface] || [])
    .filter(a => (a.family === 'IPv4' || a.family === 4) && !a.internal);
  return addrs.length ? addrs[0].address : null;
}

// systeminformation doesn't report fan speeds, so read hwmon directly:
// the first fan*_input that reports a non-zero rpm. Paths are looked up
// once; the values are re-read every request.
const FAN_PATHS = (() => {
  const out = [];
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const dir = `/sys/class/hwmon/${h}`;
      let files = [];
      try { files = fs.readdirSync(dir); } catch (e) { continue; }
      for (const f of files) if (/^fan\d+_input$/.test(f)) out.push(`${dir}/${f}`);
    }
  } catch (e) { /* no hwmon on this host */ }
  return out;
})();

function fanRpm() {
  for (const p of FAN_PATHS) {
    const v = Number(readFileTrim(p));
    if (v > 0) return v;
  }
  return null;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const [cpu, cpuData, cpuSpeed, mem, allDisks, temp, defaultIface] = await Promise.all([
      si.currentLoad(),
      si.cpu(),
      si.cpuCurrentSpeed(),
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
      host: {
        name: HOST_NAME,
        os: HOST_OS,
        ip: defaultIface ? ipv4For(defaultIface) : null,
        load: os.loadavg(),
      },
      cpu: {
        loadPct: cpu.currentLoad,
        cores: cpuData.cores,
        model: `${cpuData.manufacturer} ${cpuData.brand}`.trim(),
        speedGHz: (cpuSpeed && cpuSpeed.avg) || cpuData.speed || null,
      },
      memory: {
        totalBytes: mem.total,
        usedBytes: mem.active,
        usedPct: mem.total ? (mem.active / mem.total) * 100 : null,
      },
      disks,
      temp: {
        c: (temp && typeof temp.main === 'number' && temp.main > 0) ? temp.main : null,
        fanRpm: fanRpm(),
      },
      uptimeSec: os.uptime(),
      network: net,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
