// ---------- polling ----------

let pollTimer = null;

async function pollOnce() {
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

    renderPanel(sys);
    renderPanelContainers(containers);
    if (editingName === null) {
      renderContainers(containers);
    } else {
      // don't blow away an in-progress edit's focus/cursor on refresh
      lastContainers = containers;
    }
    panelSetLink(true);
    clearError();
  } catch (err) {
    panelSetLink(false);
    showError('lost connection to dashboard server \u2014 retrying\u2026');
  }
}

function showError(msg) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.className = 'error-banner';
    document.getElementById('hp').after(banner);
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

// ---------- boot ----------
// The dashboard only starts polling once auth.js confirms the user is
// logged in — it calls window.pinnuleStart() after that check succeeds.

let appStarted = false;

function startApp() {
  // auth.js calls this again after a re-login, so only wire things up once
  if (!appStarted) {
    initSettingsUI();
    panelInit();
    appStarted = true;
  }
  restartPolling();
}

function stopApp() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

window.pinnuleStart = startApp;
window.pinnuleStop = stopApp;
