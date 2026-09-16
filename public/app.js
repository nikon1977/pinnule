const SETTINGS_KEY = 'pinnule-settings';

const defaultSettings = {
  interval: 5000,
  metrics: { cpu: true, memory: true, disk: true, network: true, temp: true, uptime: true },
  showStopped: true,
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

function renderHardware(data) {
  const el = document.getElementById('hw-strip');
  if (!data) {
    el.innerHTML = '<div class="hw-empty">hardware stats unavailable</div>';
    return;
  }

  const panels = [];

  if (settings.metrics.cpu && data.cpu) {
    const pct = data.cpu.loadPct;
    panels.push(`
      <div class="hw-panel">
        <div class="hw-label"><span>CPU</span><span>${data.cpu.cores} cores</span></div>
        <div class="hw-value">${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small></div>
        <div class="hw-meter"><div class="hw-meter-fill ${meterClass(pct)}" style="width:${Math.min(pct || 0, 100)}%"></div></div>
      </div>`);
  }

  if (settings.metrics.memory && data.memory) {
    const pct = data.memory.usedPct;
    panels.push(`
      <div class="hw-panel">
        <div class="hw-label"><span>MEM</span></div>
        <div class="hw-value">${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small></div>
        <div class="hw-meter"><div class="hw-meter-fill ${meterClass(pct)}" style="width:${Math.min(pct || 0, 100)}%"></div></div>
        <div class="hw-detail">${fmtBytes(data.memory.usedBytes)} / ${fmtBytes(data.memory.totalBytes)}</div>
      </div>`);
  }

  if (settings.metrics.disk) {
    if (data.disks && data.disks.length) {
      data.disks.forEach(d => {
        const pct = d.usedPct;
        panels.push(`
          <div class="hw-panel">
            <div class="hw-label"><span>DISK</span><span>${d.mount}</span></div>
            <div class="hw-value">${pct != null ? pct.toFixed(1) : '\u2014'}<small>%</small></div>
            <div class="hw-meter"><div class="hw-meter-fill ${meterClass(pct)}" style="width:${Math.min(pct || 0, 100)}%"></div></div>
            <div class="hw-detail">${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)}</div>
          </div>`);
      });
    } else {
      panels.push(`
        <div class="hw-panel">
          <div class="hw-label"><span>DISK</span></div>
          <div class="hw-detail">no drives detected</div>
        </div>`);
    }
  }

  if (settings.metrics.network) {
    const net = data.network;
    panels.push(`
      <div class="hw-panel">
        <div class="hw-label"><span>NET</span>${net ? `<span>${net.iface}</span>` : ''}</div>
        <div class="hw-value" style="font-size:14px;">
          \u2193 ${net ? fmtRate(net.rxSec) : '\u2014'}<br>
          \u2191 ${net ? fmtRate(net.txSec) : '\u2014'}
        </div>
      </div>`);
  }

  if (settings.metrics.temp) {
    const c = data.temp ? data.temp.c : null;
    panels.push(`
      <div class="hw-panel">
        <div class="hw-label"><span>TEMP</span></div>
        <div class="hw-value">${c != null ? c.toFixed(0) : 'n/a'}${c != null ? '<small>\u00b0C</small>' : ''}</div>
        ${c == null ? '<div class="hw-detail">not exposed by host</div>' : ''}
      </div>`);
  }

  if (settings.metrics.uptime) {
    panels.push(`
      <div class="hw-panel">
        <div class="hw-label"><span>UPTIME</span></div>
        <div class="hw-value" style="font-size:16px;">${fmtUptime(data.uptimeSec)}</div>
      </div>`);
  }

  el.innerHTML = panels.length ? panels.join('') : '<div class="hw-empty">all panels hidden \u2014 enable some in settings</div>';
}

// ---------- rendering: containers ----------

function renderContainers(list) {
  lastContainers = list;
  const grid = document.getElementById('container-grid');
  const countEl = document.getElementById('container-count');

  const visible = settings.showStopped ? list : list.filter(c => c.state === 'running');
  const runningCount = list.filter(c => c.state === 'running').length;
  countEl.textContent = `${list.length} container${list.length === 1 ? '' : 's'} detected \u2014 ${runningCount} running`;

  if (!visible.length) {
    grid.innerHTML = '<div class="empty-state">no containers to show. check docker.sock is mounted, or enable "show stopped".</div>';
    return;
  }

  grid.innerHTML = visible.map(c => {
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

    let actionBtn = '';
    if (c.state === 'running') {
      actionBtn = `<button class="c-btn c-btn--stop" data-action="stop" data-id="${c.id}" data-name="${c.name}">stop</button>`;
    } else if (c.state === 'exited' || c.state === 'created' || c.state === 'dead') {
      actionBtn = `<button class="c-btn c-btn--start" data-action="start" data-id="${c.id}" data-name="${c.name}">start</button>`;
    } else {
      actionBtn = `<span class="c-btn c-btn--disabled">${c.state}\u2026</span>`;
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
      const link = appUrl
        ? `<a class="c-name-link" href="${escapeHtml(appUrl)}" target="_blank" rel="noopener" title="open ${escapeHtml(c.name)}"><img class="c-icon" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')"><span>${escapeHtml(c.name)}</span></a>`
        : `<span class="c-name-link"><img class="c-icon" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')"><span>${escapeHtml(c.name)}</span></span>`;
      nameHtml = `
        <span class="c-name">
          ${link}
          <button type="button" class="c-edit-icon-btn c-edit-trigger" data-action="edit-url" data-name="${escapeHtml(c.name)}" title="edit link${hasOverride ? ' (custom)' : ''}" aria-label="edit link">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
          </button>
        </span>`;
    }

    const runtime = c.state === 'running' ? fmtStartedAt(c.startedAt) : null;
    const metaBlock = `
      <div class="c-meta">
        <span title="container uptime">${runtime ? `up ${runtime}` : `created ${new Date(c.created * 1000).toLocaleDateString()}`}</span>
        <span title="restart count">restarts ${c.restartCount ?? 0}</span>
      </div>`;

    return `
      <div class="c-card ${c.state !== 'running' ? 'is-stopped' : ''}">
        <div class="c-card-head">
          <span class="dot ${dotClass(c.state)}"></span>
          ${nameHtml}
          ${actionBtn}
        </div>
        <div class="c-image" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</div>
        <div class="c-status">${escapeHtml(c.status)}</div>
        ${metaBlock}
        ${statsBlock}
      </div>`;
  }).join('');
}

// ---------- container controls ----------

async function controlContainer(id, action, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === 'start' ? 'starting\u2026' : 'stopping\u2026';
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
    if (action === 'stop' && !confirm(`Stop ${name}?`)) return;
    controlContainer(id, action, startStopBtn);
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
    reauthInputs.forEach(input => input.setAttribute('readonly', ''));
  }

  intervalSelect.value = String(settings.interval);
  stoppedCheckbox.checked = settings.showStopped;
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
