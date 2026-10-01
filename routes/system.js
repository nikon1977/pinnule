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

router.get('/', requireAuth, async (req, res) => {
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

module.exports = router;
