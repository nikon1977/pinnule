const os = require('os');
const path = require('path');
const express = require('express');
const Docker = require('dockerode');
const si = require('systeminformation');

const PORT = process.env.PORT || 4000;
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/containers', async (req, res) => {
  try {
    const list = await docker.listContainers({ all: true });

    const enriched = await Promise.all(list.map(async (c) => {
      const name = (c.Names && c.Names[0] || c.Id.slice(0, 12)).replace(/^\//, '');
      let cpuPct = null, memUsed = null, memLimit = null;
      let restartCount = 0, startedAt = null, labels = c.Labels || {};

      try {
        const inspect = await docker.getContainer(c.Id).inspect();
        restartCount = inspect.RestartCount || 0;
        startedAt = inspect.State && inspect.State.StartedAt;
        labels = inspect.Config && inspect.Config.Labels || labels;
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
      const appUrl = labels['homelab.dashboard.url'] || autoUrl;
      const icon = labels['homelab.dashboard.icon'] || null;

      return {
        id: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports,
        appUrl,
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

app.get('/api/system', async (req, res) => {
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

app.post('/api/containers/:id/start', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).start();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/stop', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`pinnule listening on :${PORT}`);
});
