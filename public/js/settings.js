// ---------- settings: persisted in the browser, plus the drawer that edits them ----------

const SETTINGS_KEY = 'pinnule-settings';

const defaultSettings = {
  interval: 5000,
  showStopped: true,
  showHidden: false,
};

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    delete parsed.metrics; // per-panel toggles from before the fixed host panel
    return { ...defaultSettings, ...parsed };
  } catch (e) {
    return { ...defaultSettings };
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const settings = loadSettings();

// ---------- settings UI wiring ----------

// The "current password" reauth fields look like an ordinary login field
// to the browser, so it'll happily autofill a saved password into them —
// which would let anyone with the tab open (kiosk screen, borrowed
// device) submit a password change without ever knowing the real
// password themselves. Keep them readonly until a human deliberately
// clicks in, and wipe both security forms every time the drawer opens or
// closes, or the login screen shows, so nothing lingers for the next
// person to find pre-filled.
const REAUTH_INPUTS = '#cp-current, #rc-current';

function resetReauthForms() {
  document.getElementById('change-password-form').reset();
  document.getElementById('regen-code-form').reset();
  document.getElementById('cp-status').hidden = true;
  document.getElementById('rc-status').hidden = true;
  document.getElementById('rc-code-display').hidden = true;
  document.getElementById('rc-code-display').textContent = '';
  document.querySelectorAll(REAUTH_INPUTS).forEach(input => input.setAttribute('readonly', ''));
}

// also called by auth.js whenever the login screen shows -- the logout
// button sits outside the drawer, so the drawer can still be open
function closeSettingsPanel() {
  document.getElementById('settings-panel').hidden = true;
  resetReauthForms();
}

function initSettingsUI() {
  const panel = document.getElementById('settings-panel');
  const toggleBtn = document.getElementById('settings-toggle');
  const closeBtn = document.getElementById('settings-close');
  const intervalSelect = document.getElementById('opt-interval');
  const stoppedCheckbox = document.getElementById('opt-show-stopped');
  const hiddenCheckbox = document.getElementById('opt-show-hidden');

  document.querySelectorAll(REAUTH_INPUTS).forEach(input => {
    input.addEventListener('focus', () => input.removeAttribute('readonly'));
  });

  intervalSelect.value = String(settings.interval);
  stoppedCheckbox.checked = settings.showStopped;
  hiddenCheckbox.checked = settings.showHidden;

  toggleBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    resetReauthForms();
  });
  closeBtn.addEventListener('click', closeSettingsPanel);

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
}
