const express = require('express');

const {
  docker, SELF_ID, SELF_NAME,
  isValidContainerId, isSafeAppUrl, pickAppPort, cpuPercentFromStats, demuxLogBuffer,
  getContainerMeta, inspectCache,
} = require('../lib/docker');
const {
  getUrlOverride, hasUrlOverride, setUrlOverride, deleteUrlOverride,
  isHidden, hideContainer, unhideContainer,
} = require('../lib/stores');
const { requireAuth } = require('../lib/session');

const router = express.Router();

// ---- containers: auto-detected from the Docker socket, no config needed ----

router.get('/', requireAuth, async (req, res) => {
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
      const hasOverride = hasUrlOverride(name);
      const appUrl = hasOverride ? getUrlOverride(name) : labelUrl;
      const icon = labels['pinnule.icon'] || null;
      // cosmetic only -- name stays the real container name throughout (API
      // calls, url-override/hidden storage keys, editingName tracking all
      // still use it), this only changes what's shown to the user
      const displayName = labels['pinnule.name'] || name;

      return {
        id: c.Id.slice(0, 12),
        name,
        displayName,
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
        hidden: isHidden(name),
      };
    }));

    enriched.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- container controls ----

router.post('/:id/start', requireAuth, async (req, res) => {
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

router.post('/:id/stop', requireAuth, async (req, res) => {
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

router.post('/:id/restart', requireAuth, async (req, res) => {
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

const LOG_TAIL_LINES = 500;

router.get('/:id/logs', requireAuth, async (req, res) => {
  if (!isValidContainerId(req.params.id)) {
    return res.status(400).json({ error: 'invalid container id' });
  }
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    const rawLogs = await container.logs({
      stdout: true,
      stderr: true,
      tail: LOG_TAIL_LINES,
      timestamps: true,
    });
    const text = info.Config && info.Config.Tty
      ? rawLogs.toString('utf8')
      : demuxLogBuffer(rawLogs);
    res.json({ logs: text });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: 'container not found' });
    }
    res.status(500).json({ error: `could not fetch logs: ${err.message}` });
  }
});

// ---- custom app URLs (keyed by container name, persisted to disk) ----

router.put('/:name/url', requireAuth, (req, res) => {
  const name = req.params.name;
  const url = (req.body && typeof req.body.url === 'string') ? req.body.url.trim() : '';
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!isSafeAppUrl(url)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }
  try {
    setUrlOverride(name, url);
  } catch (err) {
    return res.status(500).json({ error: `could not save: ${err.message}` });
  }
  res.json({ ok: true, name, url });
});

router.delete('/:name/url', requireAuth, (req, res) => {
  const name = req.params.name;
  try {
    deleteUrlOverride(name);
  } catch (err) {
    return res.status(500).json({ error: `could not save: ${err.message}` });
  }
  res.json({ ok: true, name });
});

// ---- hidden containers (keyed by name, same persistence pattern as URL
// overrides, so a hide preference survives container rebuilds/redeploys) ----

router.put('/:name/hide', requireAuth, (req, res) => {
  const name = req.params.name;
  try {
    hideContainer(name);
  } catch (err) {
    return res.status(500).json({ error: `could not save: ${err.message}` });
  }
  res.json({ ok: true, name });
});

router.delete('/:name/hide', requireAuth, (req, res) => {
  const name = req.params.name;
  try {
    unhideContainer(name);
  } catch (err) {
    return res.status(500).json({ error: `could not save: ${err.message}` });
  }
  res.json({ ok: true, name });
});

module.exports = router;
