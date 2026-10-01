// ---------- rendering: containers ----------

let lastContainers = [];
let editingName = null;

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
        <button class="c-btn c-btn--restart" data-action="restart" data-id="${c.id}" data-name="${escapeHtml(c.displayName)}">restart</button>
        <button class="c-btn c-btn--stop" data-action="stop" data-id="${c.id}" data-name="${escapeHtml(c.displayName)}">stop</button>
      </div>`;
  } else if (c.state === 'exited' || c.state === 'created' || c.state === 'dead') {
    actionBtns = `<button class="c-btn c-btn--start" data-action="start" data-id="${c.id}" data-name="${escapeHtml(c.displayName)}">start</button>`;
  } else {
    actionBtns = `<span class="c-btn c-btn--disabled">${c.state}\u2026</span>`;
  }
  // always present regardless of state -- you'll often want logs from a
  // container that just stopped or crashed, not only a running one
  const logsBtn = `<button class="c-btn c-btn--logs" data-action="logs" data-id="${c.id}" data-name="${escapeHtml(c.displayName)}">logs</button>`;

  const autoUrl = c.autoUrl != null ? c.autoUrl : c.appUrl;
  const hasOverride = !!c.urlOverridden;
  const appUrl = c.appUrl;
  const iconUrl = appIcon(c.displayName, c.icon);

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
      ? `<a class="c-name-link" href="${escapeHtml(safeAppUrl)}" target="_blank" rel="noopener" title="open ${escapeHtml(c.displayName)}"><img class="c-icon" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')"><span>${escapeHtml(c.displayName)}</span></a>`
      : `<span class="c-name-link"><img class="c-icon" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')"><span>${escapeHtml(c.displayName)}</span></span>`;
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
      <div class="c-card-foot">${actionBtns}${logsBtn}</div>
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
  patchLinkAndIcon(el, c.displayName, c.appUrl, c.icon);

  const editTrigger = el.querySelector('.c-edit-trigger');
  if (editTrigger) editTrigger.title = `edit link${c.urlOverridden ? ' (custom)' : ''}`;

  const hideTrigger = el.querySelector('.c-hide-trigger');
  if (hideTrigger) hideTrigger.title = c.hidden ? 'unhide' : 'hide from dashboard';

  el.querySelectorAll('.c-btn[data-action][data-name]').forEach(btn => { btn.dataset.name = c.displayName; });
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
  const logsBtn = e.target.closest('[data-action="logs"]');
  if (logsBtn) {
    const { id, name } = logsBtn.dataset;
    openLogsOverlay(id, name, logsBtn.closest('.c-card'));
    return;
  }

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
