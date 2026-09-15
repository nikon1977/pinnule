// ---------- auth overlay: first-time setup + login gate ----------

const pinnuleAuth = (() => {
  const overlay = document.getElementById('auth-overlay');
  const form = document.getElementById('auth-form');
  const subtitle = document.getElementById('auth-subtitle');
  const errorBox = document.getElementById('auth-error');
  const usernameInput = document.getElementById('auth-username');
  const passwordInput = document.getElementById('auth-password');
  const confirmField = document.getElementById('auth-confirm-field');
  const confirmInput = document.getElementById('auth-confirm');
  const submitBtn = document.getElementById('auth-submit');
  const logoutBtn = document.getElementById('logout-btn');

  let mode = 'login'; // 'login' | 'setup'

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
    if (mode === 'setup') {
      subtitle.textContent = 'first-time setup \u2014 create the admin account';
      submitBtn.textContent = 'create account';
      confirmField.hidden = false;
      confirmInput.required = true;
      passwordInput.setAttribute('autocomplete', 'new-password');
      usernameInput.value = '';
    } else {
      subtitle.textContent = 'sign in';
      submitBtn.textContent = 'sign in';
      confirmField.hidden = true;
      confirmInput.required = false;
      passwordInput.setAttribute('autocomplete', 'current-password');
      if (knownUsername) usernameInput.value = knownUsername;
    }
    passwordInput.value = '';
    confirmInput.value = '';
  }

  function openOverlay() {
    document.body.classList.add('auth-pending');
    overlay.hidden = false;
    logoutBtn.hidden = true;
    if (window.pinnuleStop) window.pinnuleStop();
    requestAnimationFrame(() => usernameInput.focus());
  }

  function closeOverlay() {
    overlay.hidden = true;
    document.body.classList.remove('auth-pending');
    logoutBtn.hidden = false;
  }

  async function checkStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
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

  async function submitLogin(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'sign in failed');
    return data;
  }

  async function submitSetup(username, password, confirmPassword) {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, confirmPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'setup failed');
    return data;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmInput.value;

    if (!username || !password) {
      showError('username and password are required');
      return;
    }
    if (mode === 'setup' && password !== confirmPassword) {
      showError('passwords do not match');
      return;
    }
    if (mode === 'setup' && password.length < 8) {
      showError('password must be at least 8 characters');
      return;
    }

    submitBtn.disabled = true;
    try {
      if (mode === 'setup') {
        await submitSetup(username, password, confirmPassword);
      } else {
        await submitLogin(username, password);
      }
      closeOverlay();
      if (window.pinnuleStart) window.pinnuleStart();
    } catch (err) {
      showError(err.message || 'something went wrong');
    } finally {
      submitBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) { /* proceed to show the login screen regardless */ }
    if (window.pinnuleStop) window.pinnuleStop();
    openOverlay();
    setMode('login');
  });

  checkStatus();

  return { handleSessionExpired };
})();

window.pinnuleAuth = pinnuleAuth;
