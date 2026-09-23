const SETTINGS_KEY = 'pinnule-settings';

const defaultSettings = {
  interval: 5000,
  metrics: { cpu: true, memory: true, disk: true, network: true, temp: true, uptime: true },
  showStopped: true,
  showHidden: false,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(defaultSettings);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(defaultSettings), ...parsed, metrics: { ...defaultSettings.metrics, ...(parsed.metrics || {}) } };
  } catch (e) {
    return structuredClone(defaultSettings);
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let settings = loadSettings();
let pollTimer = null;
let lastContainers = [];
let editingName = null;

// rolling sample history for the hardware sparklines — in-memory only,
// resets on page load, independent of which panels are currently enabled
// so a re-enabled panel isn't stuck starting from empty
const HISTORY_MAX = 60;
const history = { cpu: [], memory: [], netRx: [], netTx: [] };

function pushHistory(key, value) {
  const arr = history[key];
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

// ---------- helpers ----------

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '\u2014';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec == null || Number.isNaN(bytesPerSec)) return '\u2014';
  return `${fmtBytes(bytesPerSec)}/s`;
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

function meterClass(pct) {
  if (pct == null) return '';
  if (pct >= 85) return 'bad';
  if (pct >= 60) return 'warn';
  return '';
}

function dotClass(state) {
  if (state === 'running') return 'dot--live';
  if (state === 'restarting') return 'dot--transitioning';
  if (state === 'paused') return 'dot--paused';
  return 'dot--stopped';
}

// ---------- rendering: hardware strip ----------

function sparklineSvg(series, { width = 100, height = 24, min = null, max = null } = {}) {
  const usable = series.filter(s => s.values.length >= 2);
  if (!usable.length) return '';
  const allValues = usable.flatMap(s => s.values);
  const lo = min != null ? min : Math.min(...allValues, 0);
  const hi = max != null ? max : Math.max(...allValues, lo + 1);
  const range = (hi - lo) || 1;

  const toPoints = (values) => {
    const stepX = width / Math.max(values.length - 1, 1);
    return values.map((v, i) => {
      const x = i * stepX;
      const y = height - Math.max(0, Math.min(1, (v - lo) / range)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };

  const polylines = usable
    .map(s => `<polyline points="${toPoints(s.values)}" class="${s.className || ''}"></polyline>`)
    .join('');

  return `<svg class="hw-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${polylines}</svg>`;
}

// tracks the ordered list of panel keys from the last render, so we can
// tell "same panels, just new numbers" (patch in place) from "the set of
// panels actually changed" (rebuild) -- e.g. a setting was toggled, or a
// drive was mounted/unmounted
let lastHwPanelKeys = null;

function computeHwPanelKeys(data) {
  const keys = [];
  if (settings.metrics.cpu && data.cpu) keys.push('cpu');
  if (settings.metrics.memory && data.memory) keys.push('memory');
  if (settings.metrics.disk) {
    if (data.disks && data.disks.length) data.disks.forEach(d => keys.push('disk:' + d.mount));
    else keys.push('disk:none');
  }
  if (settings.metrics.network) keys.push('network');
  if (settings.metrics.temp) keys.push('temp');
  if (settings.metrics.uptime) keys.push('uptime');
  return keys;
}

function hwPanelHtml(key, data) {
  if (key === 'cpu') {
    const pct = data.cpu.loadPct;
    return `
      <div class="hw-panel" data-panel-key="cpu">
        <div class="hw-label"><span>CPU</span><span>${data.cpu.cores} cores</span></div>
        <div class="hw-value">${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small></div>
        <div class="hw-meter"><div class="hw-meter-fill ${meterClass(pct)}" style="width:${Math.min(pct || 0, 100)}%"></div></div>
        <div class="hw-spark-wrap">${sparklineSvg([{ values: history.cpu, className: 'spark-primary' }], { min: 0, max: 100 })}</div>
      </div>`;
  }
  if (key === 'memory') {
    const pct = data.memory.usedPct;
    return `
      <div class="hw-panel" data-panel-key="memory">
        <div class="hw-label"><span>MEM</span></div>
        <div class="hw-value">${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small></div>
        <div class="hw-meter"><div class="hw-meter-fill ${meterClass(pct)}" style="width:${Math.min(pct || 0, 100)}%"></div></div>
        <div class="hw-spark-wrap">${sparklineSvg([{ values: history.memory, className: 'spark-primary' }], { min: 0, max: 100 })}</div>
        <div class="hw-detail">${fmtBytes(data.memory.usedBytes)} / ${fmtBytes(data.memory.totalBytes)}</div>
      </div>`;
  }
  if (key === 'disk:none') {
    return `
      <div class="hw-panel" data-panel-key="disk:none">
        <div class="hw-label"><span>DISK</span></div>
        <div class="hw-detail">no drives detected</div>
      </div>`;
  }
  if (key.startsWith('disk:')) {
    const d = data.disks.find(d => 'disk:' + d.mount === key);
    const pct = d.usedPct;
    return `
      <div class="hw-panel" data-panel-key="${escapeHtml(key)}">
        <div class="hw-label"><span>DISK</span><span>${escapeHtml(d.mount)}</span></div>
        <div class="hw-value">${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small></div>
        <div class="hw-meter"><div class="hw-meter-fill ${meterClass(pct)}" style="width:${Math.min(pct || 0, 100)}%"></div></div>
        <div class="hw-detail">${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)}</div>
      </div>`;
  }
  if (key === 'network') {
    const net = data.network;
    return `
      <div class="hw-panel" data-panel-key="network">
        <div class="hw-label"><span>NET</span>${net ? `<span>${escapeHtml(net.iface)}</span>` : ''}</div>
        <div class="hw-value" style="font-size:14px;">
          \u2193 ${net ? fmtRate(net.rxSec) : '\u2014'}<br>
          \u2191 ${net ? fmtRate(net.txSec) : '\u2014'}
        </div>
        <div class="hw-spark-wrap">${sparklineSvg([
          { values: history.netRx, className: 'spark-primary' },
          { values: history.netTx, className: 'spark-secondary' },
        ])}</div>
      </div>`;
  }
  if (key === 'temp') {
    const c = data.temp ? data.temp.c : null;
    return `
      <div class="hw-panel" data-panel-key="temp">
        <div class="hw-label"><span>TEMP</span></div>
        <div class="hw-value">${c != null ? c.toFixed(0) : 'n/a'}${c != null ? '<small>\u00b0C</small>' : ''}</div>
        <div class="hw-detail" ${c == null ? '' : 'hidden'}>not exposed by host</div>
      </div>`;
  }
  if (key === 'uptime') {
    return `
      <div class="hw-panel" data-panel-key="uptime">
        <div class="hw-label"><span>UPTIME</span></div>
        <div class="hw-value" style="font-size:16px;">${fmtUptime(data.uptimeSec)}</div>
      </div>`;
  }
  return '';
}

function patchHwPanel(el, key, data) {
  if (key === 'cpu' || key === 'memory') {
    const pct = key === 'cpu' ? data.cpu.loadPct : data.memory.usedPct;
    el.querySelector('.hw-value').innerHTML = `${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small>`;
    const fill = el.querySelector('.hw-meter-fill');
    fill.className = `hw-meter-fill ${meterClass(pct)}`;
    fill.style.width = `${Math.min(pct || 0, 100)}%`;
    const spark = key === 'cpu'
      ? sparklineSvg([{ values: history.cpu, className: 'spark-primary' }], { min: 0, max: 100 })
      : sparklineSvg([{ values: history.memory, className: 'spark-primary' }], { min: 0, max: 100 });
    el.querySelector('.hw-spark-wrap').innerHTML = spark;
    if (key === 'memory') {
      el.querySelector('.hw-detail').textContent = `${fmtBytes(data.memory.usedBytes)} / ${fmtBytes(data.memory.totalBytes)}`;
    }
    return;
  }
  if (key.startsWith('disk:') && key !== 'disk:none') {
    const d = data.disks.find(d => 'disk:' + d.mount === key);
    if (!d) return; // shouldn't happen -- same key means same mount was found when building the key list
    const pct = d.usedPct;
    el.querySelector('.hw-value').innerHTML = `${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small>`;
    const fill = el.querySelector('.hw-meter-fill');
    fill.className = `hw-meter-fill ${meterClass(pct)}`;
    fill.style.width = `${Math.min(pct || 0, 100)}%`;
    el.querySelector('.hw-detail').textContent = `${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)}`;
    return;
  }
  if (key === 'network') {
    const net = data.network;
    const label = el.querySelector('.hw-label');
    label.innerHTML = `<span>NET</span>${net ? `<span>${escapeHtml(net.iface)}</span>` : ''}`;
    el.querySelector('.hw-value').innerHTML =
      `\u2193 ${net ? fmtRate(net.rxSec) : '\u2014'}<br>\u2191 ${net ? fmtRate(net.txSec) : '\u2014'}`;
    el.querySelector('.hw-spark-wrap').innerHTML = sparklineSvg([
      { values: history.netRx, className: 'spark-primary' },
      { values: history.netTx, className: 'spark-secondary' },
    ]);
    return;
  }
  if (key === 'temp') {
    const c = data.temp ? data.temp.c : null;
    el.querySelector('.hw-value').innerHTML = `${c != null ? c.toFixed(0) : 'n/a'}${c != null ? '<small>\u00b0C</small>' : ''}`;
    el.querySelector('.hw-detail').hidden = c != null;
    return;
  }
  if (key === 'uptime') {
    el.querySelector('.hw-value').textContent = fmtUptime(data.uptimeSec);
  }
}

function renderHardware(data) {
  const el = document.getElementById('hw-strip');
  if (!data) {
    lastHwPanelKeys = null;
    el.innerHTML = '<div class="hw-empty">hardware stats unavailable</div>';
    return;
  }

  // record history regardless of which panels are currently shown, so
  // toggling a panel back on doesn't start its sparkline from empty
  if (data.cpu && data.cpu.loadPct != null) pushHistory('cpu', data.cpu.loadPct);
  if (data.memory && data.memory.usedPct != null) pushHistory('memory', data.memory.usedPct);
  if (data.network) {
    pushHistory('netRx', data.network.rxSec || 0);
    pushHistory('netTx', data.network.txSec || 0);
  }

  const keys = computeHwPanelKeys(data);

  if (!keys.length) {
    lastHwPanelKeys = keys;
    el.innerHTML = '<div class="hw-empty">all panels hidden \u2014 enable some in settings</div>';
    return;
  }

  const sameShape = lastHwPanelKeys &&
    lastHwPanelKeys.length === keys.length &&
    lastHwPanelKeys.every((k, i) => k === keys[i]);

  if (!sameShape) {
    el.innerHTML = keys.map(k => hwPanelHtml(k, data)).join('');
    lastHwPanelKeys = keys;
    return;
  }

  keys.forEach(key => {
    const panelEl = el.querySelector(`[data-panel-key="${CSS.escape(key)}"]`);
    if (panelEl) patchHwPanel(panelEl, key, data);
  });
}


// ---------- rendering: containers ----------

function containerCardHtml(c) {
  const cpuPct = c.cpuPct;
  const memPct = (c.memUsed != null && c.memLimit) ? (c.memUsed / c.memLimit) * 100 : null;

  const statsBlock = c.state === 'running' ? `
    <div class="c-stats">
      <div class="c-stat">
        <div class="c-stat-label">CPU</div>
        <div class="c-stat-value">${cpuPct != null ? cpuPct.toFixed(1) + '%' : '\u2014'}</div>
        <div class="c-stat-meter"><div class="c-stat-meter-fill" style="width:${Math.min(cpuPct || 0, 100)}%"></div></div>
      </div>
      <div class="c-stat">
        <div class="c-stat-label">MEM</div>
        <div class="c-stat-value">${c.memUsed != null ? fmtBytes(c.memUsed) : '\u2014'}</div>
        <div class="c-stat-meter"><div class="c-stat-meter-fill" style="width:${Math.min(memPct || 0, 100)}%"></div></div>
      </div>
    </div>` : '';

  let actionBtns = '';
  if (c.state === 'running') {
    actionBtns = `
      <div class="c-actions">
        <button class="c-btn c-btn--restart" data-action="restart" data-id="${c.id}" data-name="${c.name}">restart</button>
        <button class="c-btn c-btn--stop" data-action="stop" data-id="${c.id}" data-name="${c.name}">stop</button>
      </div>`;
  } else if (c.state === 'exited' || c.state === 'created' || c.state === 'dead') {
    actionBtns = `<button class="c-btn c-btn--start" data-action="start" data-id="${c.id}" data-name="${c.name}">start</button>`;
  } else {
    actionBtns = `<span class="c-btn c-btn--disabled">${c.state}\u2026</span>`;
  }

  const autoUrl = c.autoUrl != null ? c.autoUrl : c.appUrl;
  const hasOverride = !!c.urlOverridden;
  const appUrl = c.appUrl;
  const iconUrl = appIcon(c.name, c.icon);

  let nameHtml;
  if (editingName === c.name) {
    nameHtml = `
      <form class="c-edit-form" data-name="${escapeHtml(c.name)}">
        <input class="c-url-input" type="text" name="url"
          value="${escapeHtml(appUrl || '')}"
          placeholder="${escapeHtml(autoUrl || 'http://host:port')}"
          autocomplete="off" spellcheck="false">
        <button type="submit" class="c-edit-icon-btn c-edit-save" title="save" aria-label="save">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </button>
        <button type="button" class="c-edit-icon-btn c-edit-cancel" data-action="cancel-url" title="cancel" aria-label="cancel">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        ${hasOverride ? `<button type="button" class="c-edit-icon-btn c-edit-reset" data-action="reset-url" data-name="${escapeHtml(c.name)}" title="reset to auto-detected" aria-label="reset to auto-detected">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        </button>` : ''}
      </form>`;
  } else {
    const safeAppUrl = isSafeUrl(appUrl) ? appUrl : null;
    const link = safeAppUrl
      ? `<a class="c-name-link" href="${escapeHtml(safeAppUrl)}" target="_blank" rel="noopener" title="open ${escapeHtml(c.name)}"><img class="c-icon" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')"><span>${escapeHtml(c.name)}</span></a>`
      : `<span class="c-name-link"><img class="c-icon" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')"><span>${escapeHtml(c.name)}</span></span>`;
    const hideBtn = c.hidden
      ? `<button type="button" class="c-edit-icon-btn c-hide-trigger" data-action="unhide" data-name="${escapeHtml(c.name)}" title="unhide" aria-label="unhide">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        </button>`
      : `<button type="button" class="c-edit-icon-btn c-hide-trigger" data-action="hide" data-name="${escapeHtml(c.name)}" title="hide from dashboard" aria-label="hide from dashboard">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
        </button>`;
    nameHtml = `
      <span class="c-name">
        ${link}
        <button type="button" class="c-edit-icon-btn c-edit-trigger" data-action="edit-url" data-name="${escapeHtml(c.name)}" title="edit link${hasOverride ? ' (custom)' : ''}" aria-label="edit link">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
        </button>
        ${hideBtn}
      </span>`;
  }

  const runtime = c.state === 'running' ? fmtStartedAt(c.startedAt) : null;
  const metaBlock = `
    <div class="c-meta">
      <span title="container uptime">${runtime ? `up ${runtime}` : `created ${new Date(c.created * 1000).toLocaleDateString()}`}</span>
      <span title="restart count">restarts ${c.restartCount ?? 0}</span>
    </div>`;

  const cardClasses = [
    c.state !== 'running' ? 'is-stopped' : '',
    c.hidden ? 'is-hidden' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="c-card ${cardClasses}" data-card-key="${escapeHtml('container:' + c.id)}">
      <div class="c-card-head">
        <span class="dot ${dotClass(c.state)}"></span>
        ${nameHtml}
      </div>
      <div class="c-image" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</div>
      <div class="c-status">${escapeHtml(c.status)}</div>
      ${metaBlock}
      ${statsBlock}
      <div class="c-card-foot">${actionBtns}</div>
    </div>`;
}

function cardKey(c) {
  return 'container:' + c.id;
}

// captures everything about a card that determines its DOM *shape* --
// which elements exist, not just what they say. If this is unchanged since
// the last render, the card can be patched in place (same nodes, new
// values); if it changed, that one card gets rebuilt (not the whole grid).
function cardSignature(c) {
  return `${c.state}|${editingName === c.name}|${isSafeUrl(c.appUrl)}|${!!c.hidden}`;
}

function patchStatsBlock(el, cpuPct, memUsed, memLimit) {
  const memPct = (memUsed != null && memLimit) ? (memUsed / memLimit) * 100 : null;
  const stats = el.querySelectorAll('.c-stat');
  if (stats[0]) {
    stats[0].querySelector('.c-stat-value').textContent = cpuPct != null ? cpuPct.toFixed(1) + '%' : '\u2014';
    stats[0].querySelector('.c-stat-meter-fill').style.width = `${Math.min(cpuPct || 0, 100)}%`;
  }
  if (stats[1]) {
    stats[1].querySelector('.c-stat-value').textContent = memUsed != null ? fmtBytes(memUsed) : '\u2014';
    stats[1].querySelector('.c-stat-meter-fill').style.width = `${Math.min(memPct || 0, 100)}%`;
  }
}

function patchLinkAndIcon(el, name, appUrl, icon) {
  const link = el.querySelector('.c-name-link');
  if (!link) return;
  const safeAppUrl = isSafeUrl(appUrl) ? appUrl : null;
  if (safeAppUrl && link.tagName === 'A') {
    link.href = safeAppUrl;
    link.title = `open ${name}`;
  }
  const img = link.querySelector('.c-icon');
  const newIconUrl = appIcon(name, icon);
  if (img && img.src !== newIconUrl) img.src = newIconUrl;
  const nameSpan = link.querySelector('span');
  if (nameSpan) nameSpan.textContent = name;
}

// editing-mode cards are never passed here -- pollOnce skips renderContainers
// entirely while editingName is set, so there's nothing to patch mid-edit
function patchContainerCard(el, c) {
  el.querySelector('.c-status').textContent = c.status;
  const runtime = c.state === 'running' ? fmtStartedAt(c.startedAt) : null;
  const metaSpans = el.querySelectorAll('.c-meta span');
  if (metaSpans[0]) metaSpans[0].textContent = runtime ? `up ${runtime}` : `created ${new Date(c.created * 1000).toLocaleDateString()}`;
  if (metaSpans[1]) metaSpans[1].textContent = `restarts ${c.restartCount ?? 0}`;
  const imgLine = el.querySelector('.c-image');
  imgLine.textContent = c.image;
  imgLine.title = c.image;

  if (c.state === 'running') patchStatsBlock(el, c.cpuPct, c.memUsed, c.memLimit);
  patchLinkAndIcon(el, c.name, c.appUrl, c.icon);

  const editTrigger = el.querySelector('.c-edit-trigger');
  if (editTrigger) editTrigger.title = `edit link${c.urlOverridden ? ' (custom)' : ''}`;

  const hideTrigger = el.querySelector('.c-hide-trigger');
  if (hideTrigger) hideTrigger.title = c.hidden ? 'unhide' : 'hide from dashboard';
}

// tracks the last render's ordered card keys and each card's structural
// signature, so a poll with unchanged data (by far the common case) patches
// existing DOM nodes in place instead of tearing down and rebuilding the
// whole grid -- keeps CSS transitions, icon images, and hover state intact
// instead of the visible "flash" a full innerHTML replace causes every time.
let lastCardKeys = null;
let lastCardSignatures = new Map();

function renderContainers(list) {
  lastContainers = list;
  const grid = document.getElementById('container-grid');
  const countEl = document.getElementById('container-count');

  const byState = settings.showStopped ? list : list.filter(c => c.state === 'running');
  const visible = settings.showHidden ? byState : byState.filter(c => !c.hidden);
  const totalContainers = list.length;
  const runningContainers = list.filter(c => c.state === 'running').length;
  countEl.textContent = `${totalContainers} container${totalContainers === 1 ? '' : 's'} detected \u2014 ${runningContainers} running`;

  if (!visible.length) {
    grid.innerHTML = '<div class="empty-state">no containers to show. check docker.sock is mounted, or enable \u201cshow stopped\u201d / \u201cshow hidden\u201d in settings.</div>';
    lastCardKeys = null;
    lastCardSignatures = new Map();
    return;
  }

  const keys = visible.map(cardKey);
  const sameShape = lastCardKeys &&
    lastCardKeys.length === keys.length &&
    lastCardKeys.every((k, i) => k === keys[i]);

  if (!sameShape) {
    grid.innerHTML = visible.map(containerCardHtml).join('');
    lastCardKeys = keys;
    lastCardSignatures = new Map(visible.map(c => [cardKey(c), cardSignature(c)]));
    return;
  }

  visible.forEach(c => {
    const key = cardKey(c);
    const sig = cardSignature(c);
    const el = grid.querySelector(`[data-card-key="${CSS.escape(key)}"]`);
    if (!el) return; // shouldn't happen given sameShape, but don't crash the poll loop if it does
    if (lastCardSignatures.get(key) !== sig) {
      el.outerHTML = containerCardHtml(c);
      lastCardSignatures.set(key, sig);
    } else {
      patchContainerCard(el, c);
    }
  });
}

// ---------- container controls ----------

async function controlContainer(id, action, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === 'start' ? 'starting\u2026' : action === 'restart' ? 'restarting\u2026' : 'stopping\u2026';
  try {
    const res = await fetch(`/api/containers/${id}/${action}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${action} failed`);
    }
    await pollOnce();
  } catch (err) {
    btn.textContent = original;
    btn.disabled = false;
    showError(`could not ${action} container: ${err.message}`);
  }
}

document.getElementById('container-grid').addEventListener('click', (e) => {
  const startStopBtn = e.target.closest('.c-btn[data-action]');
  if (startStopBtn) {
    const { action, id, name } = startStopBtn.dataset;
    if ((action === 'stop' || action === 'restart') && !confirm(`${action === 'stop' ? 'Stop' : 'Restart'} ${name}?`)) return;
    controlContainer(id, action, startStopBtn);
    return;
  }

  const hideBtn = e.target.closest('[data-action="hide"], [data-action="unhide"]');
  if (hideBtn) {
    const { action, name } = hideBtn.dataset;
    if (action === 'hide') hideContainer(name);
    else unhideContainer(name);
    return;
  }

  const editBtn = e.target.closest('[data-action="edit-url"]');
  if (editBtn) {
    editingName = editBtn.dataset.name;
    renderContainers(lastContainers);
    focusUrlInput();
    return;
  }

  const cancelBtn = e.target.closest('[data-action="cancel-url"]');
  if (cancelBtn) {
    editingName = null;
    renderContainers(lastContainers);
    return;
  }

  const resetBtn = e.target.closest('[data-action="reset-url"]');
  if (resetBtn) {
    const name = resetBtn.dataset.name;
    editingName = null;
    resetContainerUrl(name);
  }
});

document.getElementById('container-grid').addEventListener('submit', (e) => {
  const form = e.target.closest('.c-edit-form');
  if (!form) return;
  e.preventDefault();
  const name = form.dataset.name;
  const value = form.elements.url.value.trim();
  editingName = null;
  if (value) {
    saveContainerUrl(name, value);
  } else {
    resetContainerUrl(name);
  }
});

document.getElementById('container-grid').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.closest('.c-edit-form')) {
    editingName = null;
    renderContainers(lastContainers);
  }
});

async function saveContainerUrl(name, url) {
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(name)}/url`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'save failed');
    }
    await pollOnce();
  } catch (err) {
    showError(`could not save link: ${err.message}`);
    renderContainers(lastContainers);
  }
}

async function resetContainerUrl(name) {
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(name)}/url`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'reset failed');
    }
    await pollOnce();
  } catch (err) {
    showError(`could not reset link: ${err.message}`);
    renderContainers(lastContainers);
  }
}

async function hideContainer(name) {
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(name)}/hide`, { method: 'PUT' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'hide failed');
    }
    await pollOnce();
  } catch (err) {
    showError(`could not hide ${name}: ${err.message}`);
  }
}

async function unhideContainer(name) {
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(name)}/hide`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'unhide failed');
    }
    await pollOnce();
  } catch (err) {
    showError(`could not unhide ${name}: ${err.message}`);
  }
}

function focusUrlInput() {
  requestAnimationFrame(() => {
    const input = document.querySelector('.c-edit-form .c-url-input');
    if (input) {
      input.focus();
      input.select();
    }
  });
}

// ---------- polling ----------

async function pollOnce() {
  const dot = document.getElementById('conn-dot');
  try {
    const [sysRes, containersRes] = await Promise.all([
      fetch('/api/system'),
      fetch('/api/containers'),
    ]);
    if (sysRes.status === 401 || containersRes.status === 401) {
      if (window.pinnuleAuth) window.pinnuleAuth.handleSessionExpired();
      return;
    }
    if (!sysRes.ok || !containersRes.ok) throw new Error('request failed');

    const sys = await sysRes.json();
    const containers = await containersRes.json();

    renderHardware(sys);
    if (editingName === null) {
      renderContainers(containers);
    } else {
      // don't blow away an in-progress edit's focus/cursor on refresh
      lastContainers = containers;
    }
    dot.className = 'dot dot--live';
    clearError();
  } catch (err) {
    dot.className = 'dot dot--stopped';
    showError('lost connection to dashboard server \u2014 retrying\u2026');
  }
}

function showError(msg) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.className = 'error-banner';
    document.querySelector('main').prepend(banner);
  }
  banner.textContent = msg;
}

function clearError() {
  const banner = document.getElementById('error-banner');
  if (banner) banner.remove();
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, settings.interval);
}

function tickClock() {
  document.getElementById('host-time').textContent = new Date().toLocaleTimeString();
}

// ---------- settings UI wiring ----------

function initSettingsUI() {
  const panel = document.getElementById('settings-panel');
  const toggleBtn = document.getElementById('settings-toggle');
  const closeBtn = document.getElementById('settings-close');
  const intervalSelect = document.getElementById('opt-interval');
  const stoppedCheckbox = document.getElementById('opt-show-stopped');
  const hiddenCheckbox = document.getElementById('opt-show-hidden');
  const metricCheckboxes = document.querySelectorAll('input[data-metric]');

  // The "current password" reauth fields look like an ordinary login field
  // to the browser, so it'll happily autofill a saved password into them —
  // which would let anyone with the tab open (kiosk screen, borrowed
  // device) submit a password change without ever knowing the real
  // password themselves. Keep them readonly until a human deliberately
  // clicks in, and wipe both security forms every time the panel opens or
  // closes so nothing lingers for the next person to find pre-filled.
  const reauthInputs = document.querySelectorAll('#cp-current, #rc-current');
  reauthInputs.forEach(input => {
    input.addEventListener('focus', () => input.removeAttribute('readonly'));
  });

  function resetReauthForms() {
    document.getElementById('change-password-form').reset();
    document.getElementById('regen-code-form').reset();
    document.getElementById('cp-status').hidden = true;
    document.getElementById('rc-status').hidden = true;
    document.getElementById('rc-code-display').hidden = true;
    document.getElementById('rc-code-display').textContent = '';
    reauthInputs.forEach(input => input.setAttribute('readonly', ''));
  }

  intervalSelect.value = String(settings.interval);
  stoppedCheckbox.checked = settings.showStopped;
  hiddenCheckbox.checked = settings.showHidden;
  metricCheckboxes.forEach(cb => { cb.checked = !!settings.metrics[cb.dataset.metric]; });

  toggleBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    resetReauthForms();
  });
  closeBtn.addEventListener('click', () => {
    panel.hidden = true;
    resetReauthForms();
  });

  intervalSelect.addEventListener('change', () => {
    settings.interval = Number(intervalSelect.value);
    saveSettings(settings);
    restartPolling();
  });

  stoppedCheckbox.addEventListener('change', () => {
    settings.showStopped = stoppedCheckbox.checked;
    saveSettings(settings);
    pollOnce();
  });

  hiddenCheckbox.addEventListener('change', () => {
    settings.showHidden = hiddenCheckbox.checked;
    saveSettings(settings);
    pollOnce();
  });

  metricCheckboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      settings.metrics[cb.dataset.metric] = cb.checked;
      saveSettings(settings);
      pollOnce();
    });
  });
}

// ---------- boot ----------
// The dashboard only starts polling once auth.js confirms the user is
// logged in — it calls window.pinnuleStart() after that check succeeds.

function startApp() {
  initSettingsUI();
  tickClock();
  setInterval(tickClock, 1000);
  restartPolling();
}

function stopApp() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

window.pinnuleStart = startApp;
window.pinnuleStop = stopApp;
