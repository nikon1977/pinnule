// ---------- formatting & display helpers ----------
// pure functions, no shared state -- safe to load first

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '\u2014';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

function fmtUptime(sec) {
  if (sec == null) return '\u2014';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtStartedAt(iso) {
  if (!iso) return '\u2014';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '\u2014';
  return fmtUptime(Math.max(0, (Date.now() - t) / 1000));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Server-side already restricts appUrl to http/https, but this is cheap
// insurance in case that ever changes: never render something like a
// javascript: URL as a clickable link, whatever produced it.
function isSafeUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function appIcon(name, explicit) {
  if (explicit) return explicit;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://cdn.jsdelivr.net/gh/selfhst/icons/png/${slug}.png`;
}

function dotClass(state) {
  if (state === 'running') return 'dot--live';
  if (state === 'restarting') return 'dot--transitioning';
  if (state === 'paused') return 'dot--paused';
  return 'dot--stopped';
}
