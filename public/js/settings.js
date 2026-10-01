// ---------- settings: persisted in the browser, plus the drawer that edits them ----------

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
