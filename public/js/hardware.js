// ---------- rendering: hardware strip ----------

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
