// ---------- auth overlay: first-time setup + login gate + recovery ----------

const pinnuleAuth = (() => {
  const overlay = document.getElementById('auth-overlay');
  const form = document.getElementById('auth-form');
  const subtitle = document.getElementById('auth-subtitle');
  const errorBox = document.getElementById('auth-error');
  const usernameInput = document.getElementById('auth-username');
  const codeField = document.getElementById('auth-code-field');
  const codeInput = document.getElementById('auth-code');
  const passwordLabel = document.getElementById('auth-password-label');
  const passwordInput = document.getElementById('auth-password');
  const confirmField = document.getElementById('auth-confirm-field');
  const confirmInput = document.getElementById('auth-confirm');
  const rememberInput = document.getElementById('auth-remember');
  const submitBtn = document.getElementById('auth-submit');
  const forgotLink = document.getElementById('auth-forgot-link');
  const backLink = document.getElementById('auth-back-link');
  const logoutBtn = document.getElementById('logout-btn');
  const versionEl = document.getElementById('app-version');

  const recoveryView = document.getElementById('auth-recovery-view');
  const recoveryCodeDisplay = document.getElementById('auth-recovery-code-display');
  const recoveryContinueBtn = document.getElementById('auth-recovery-continue');

  let mode = 'login'; // 'login' | 'setup' | 'recover'
  let pendingContinue = null;

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setMode(next, knownUsername) {
    mode = next;
    clearError();
    form.hidden = false;
    recoveryView.hidden = true;

    codeField.hidden = mode !== 'recover';
    codeInput.required = mode === 'recover';

    confirmField.hidden = mode === 'login';
    confirmInput.required = mode !== 'login';

    forgotLink.hidden = mode !== 'login';
    backLink.hidden = mode === 'login';

    if (mode === 'setup') {
      subtitle.textContent = 'first-time setup \u2014 create the admin account';
      submitBtn.textContent = 'create account';
      passwordLabel.textContent = 'password';
      passwordInput.setAttribute('autocomplete', 'new-password');
      usernameInput.value = '';
    } else if (mode === 'recover') {
      subtitle.textContent = 'reset your password with your recovery code';
      submitBtn.textContent = 'reset password';
      passwordLabel.textContent = 'new password';
      passwordInput.setAttribute('autocomplete', 'new-password');
    } else {
      subtitle.textContent = 'sign in';
      submitBtn.textContent = 'sign in';
      passwordLabel.textContent = 'password';
      passwordInput.setAttribute('autocomplete', 'current-password');
      if (knownUsername) usernameInput.value = knownUsername;
    }
    passwordInput.value = '';
    confirmInput.value = '';
    codeInput.value = '';
  }

  function openOverlay() {
    document.body.classList.add('auth-pending');
    overlay.hidden = false;
    logoutBtn.hidden = true;
    versionEl.hidden = true;
    if (window.pinnuleStop) window.pinnuleStop();
    requestAnimationFrame(() => usernameInput.focus());
  }

  function closeOverlay() {
    overlay.hidden = true;
    document.body.classList.remove('auth-pending');
    logoutBtn.hidden = false;
    versionEl.hidden = false;
  }

  function showRecoveryCode(code, onContinue) {
    form.hidden = true;
    recoveryView.hidden = false;
    recoveryCodeDisplay.textContent = code;
    pendingContinue = onContinue;
    // the password that got us here has already done its job server-side;
    // no reason for it to keep sitting in the DOM readable via devtools
    passwordInput.value = '';
    confirmInput.value = '';
    codeInput.value = '';
    requestAnimationFrame(() => recoveryContinueBtn.focus());
  }

  recoveryContinueBtn.addEventListener('click', () => {
    const cb = pendingContinue;
    pendingContinue = null;
    recoveryCodeDisplay.textContent = '';
    if (cb) cb();
  });

  async function checkStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.version) versionEl.textContent = 'v' + data.version;
      if (data.authenticated) {
        closeOverlay();
        if (window.pinnuleStart) window.pinnuleStart();
        return;
      }
      openOverlay();
      setMode(data.setupRequired ? 'setup' : 'login', data.username);
    } catch (err) {
      openOverlay();
      setMode('login');
      showError('could not reach the server \u2014 retrying\u2026');
      setTimeout(checkStatus, 3000);
    }
  }

  function handleSessionExpired() {
    if (window.pinnuleStop) window.pinnuleStop();
    openOverlay();
    checkStatus().then(() => showError('your session expired \u2014 please sign in again'));
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'request failed');
    return data;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmInput.value;
    const recoveryCode = codeInput.value.trim();
    const remember = rememberInput.checked;

    if (!username || !password) {
      showError('username and password are required');
      return;
    }
    if (mode === 'recover' && !recoveryCode) {
      showError('recovery code is required');
      return;
    }
    if (mode !== 'login' && password !== confirmPassword) {
      showError('passwords do not match');
      return;
    }
    if (mode !== 'login' && password.length < 8) {
      showError('password must be at least 8 characters');
      return;
    }

    submitBtn.disabled = true;
    try {
      if (mode === 'setup') {
        const data = await postJson('/api/auth/setup', { username, password, confirmPassword, remember });
        showRecoveryCode(data.recoveryCode, () => {
          closeOverlay();
          if (window.pinnuleStart) window.pinnuleStart();
        });
      } else if (mode === 'recover') {
        const data = await postJson('/api/auth/recover', {
          username, recoveryCode, newPassword: password, confirmNewPassword: confirmPassword, remember,
        });
        showRecoveryCode(data.recoveryCode, () => {
          closeOverlay();
          if (window.pinnuleStart) window.pinnuleStart();
        });
      } else {
        await postJson('/api/auth/login', { username, password, remember });
        passwordInput.value = '';
        closeOverlay();
        if (window.pinnuleStart) window.pinnuleStart();
      }
    } catch (err) {
      showError(err.message || 'something went wrong');
    } finally {
      submitBtn.disabled = false;
    }
  });

  forgotLink.addEventListener('click', () => {
    setMode('recover', usernameInput.value.trim());
  });

  backLink.addEventListener('click', () => {
    setMode('login', usernameInput.value.trim());
  });

  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) { /* proceed to show the login screen regardless */ }
    if (window.pinnuleStop) window.pinnuleStop();
    rcCodeDisplay.textContent = '';
    openOverlay();
    setMode('login');
  });

  // ---------- settings-panel security forms (change password / new recovery code) ----------

  const cpForm = document.getElementById('change-password-form');
  const cpStatus = document.getElementById('cp-status');
  if (cpForm) {
    cpForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('cp-current').value;
      const newPassword = document.getElementById('cp-new').value;
      const confirmNewPassword = document.getElementById('cp-confirm').value;
      cpStatus.hidden = true;
      cpStatus.className = 'mini-status';

      if (newPassword !== confirmNewPassword) {
        cpStatus.textContent = 'new passwords do not match';
        cpStatus.classList.add('err');
        cpStatus.hidden = false;
        return;
      }

      try {
        await postJson('/api/auth/change-password', { currentPassword, newPassword, confirmNewPassword });
        cpStatus.textContent = 'password changed';
        cpStatus.classList.add('ok');
        cpForm.reset();
      } catch (err) {
        cpStatus.textContent = err.message || 'could not change password';
        cpStatus.classList.add('err');
      }
      cpStatus.hidden = false;
    });
  }

  const rcForm = document.getElementById('regen-code-form');
  const rcStatus = document.getElementById('rc-status');
  const rcCodeDisplay = document.getElementById('rc-code-display');
  if (rcForm) {
    rcForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('rc-current').value;
      rcStatus.hidden = true;
      rcStatus.className = 'mini-status';
      rcCodeDisplay.hidden = true;
      rcCodeDisplay.textContent = '';

      try {
        const data = await postJson('/api/auth/recovery-code/regenerate', { currentPassword });
        rcStatus.textContent = 'new recovery code generated \u2014 save it now, it will not be shown again:';
        rcStatus.classList.add('ok');
        rcCodeDisplay.textContent = data.recoveryCode;
        rcCodeDisplay.hidden = false;
        rcForm.reset();
      } catch (err) {
        rcStatus.textContent = err.message || 'could not generate a new code';
        rcStatus.classList.add('err');
      }
      rcStatus.hidden = false;
    });
  }

  checkStatus();

  return { handleSessionExpired };
})();

window.pinnuleAuth = pinnuleAuth;
