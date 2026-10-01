// ---------- polling ----------

let pollTimer = null;

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
