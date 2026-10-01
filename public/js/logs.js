// ---------- logs overlay ----------
// grows from the clicked card's on-screen position to fill the viewport,
// and shrinks back to that same spot on close. Both directions are done by
// transitioning explicit pixel top/left/width/height (defined on the base
// .logs-overlay class) rather than a transform -- simpler to reason about
// for an occasional modal open/close, not a per-frame animation where a
// transform's GPU compositing would actually matter.

let activeLogsOverlay = null; // { overlay, id, originRect } while one is open; null otherwise

function openLogsOverlay(id, name, cardEl) {
  if (activeLogsOverlay || !cardEl) return;

  const rect = cardEl.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'logs-overlay';
  overlay.style.top = rect.top + 'px';
  overlay.style.left = rect.left + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  overlay.innerHTML = `
    <div class="logs-overlay-head">
      <span class="logs-overlay-title">${escapeHtml(name)} \u2014 logs</span>
      <div class="logs-overlay-btns">
        <button type="button" class="logs-overlay-btn" data-logs-action="refresh" title="refresh" aria-label="refresh">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        </button>
        <button type="button" class="logs-overlay-btn" data-logs-action="close" title="close" aria-label="close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>
    <pre class="logs-overlay-content">loading\u2026</pre>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  activeLogsOverlay = { overlay, id, originRect: rect };

  // two rAFs so the browser fully paints the card-sized starting state
  // before switching to the expanded one -- a single rAF is sometimes not
  // enough for the transition to actually be picked up rather than skipped
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('logs-overlay--expanded');
      overlay.style.top = '';
      overlay.style.left = '';
      overlay.style.width = '';
      overlay.style.height = '';
    });
  });

  overlay.querySelector('[data-logs-action="close"]').addEventListener('click', closeLogsOverlay);
  overlay.querySelector('[data-logs-action="refresh"]').addEventListener('click', () => loadLogsInto(id, overlay));

  loadLogsInto(id, overlay);
}

function closeLogsOverlay() {
  if (!activeLogsOverlay) return;
  const { overlay, originRect } = activeLogsOverlay;
  document.body.style.overflow = '';
  overlay.classList.remove('logs-overlay--expanded');
  overlay.style.top = originRect.top + 'px';
  overlay.style.left = originRect.left + 'px';
  overlay.style.width = originRect.width + 'px';
  overlay.style.height = originRect.height + 'px';
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  activeLogsOverlay = null;
}

async function loadLogsInto(id, overlay) {
  const content = overlay.querySelector('.logs-overlay-content');
  content.textContent = 'loading\u2026';
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(id)}/logs`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'could not load logs');
    }
    const data = await res.json();
    // textContent, not innerHTML -- a container's own log output is
    // untrusted text and must never be parsed as markup
    content.textContent = data.logs && data.logs.length ? data.logs : '(no logs yet)';
    content.scrollTop = content.scrollHeight;
  } catch (err) {
    content.textContent = `could not load logs: ${err.message}`;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeLogsOverlay) closeLogsOverlay();
});
