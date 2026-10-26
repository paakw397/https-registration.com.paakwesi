const signupView = document.querySelector('#signup-view');
const ownerView = document.querySelector('#owner-view');
const isOwnerPage = window.location.pathname === '/owner';

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle('error', isError);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}

if (!isOwnerPage) {
  signupView.hidden = false;
  document.querySelector('#signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.querySelector('#signup-message');
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showMessage(message, 'Saving your registration…');
    try {
      const result = await requestJson('/api/register', {
        method: 'POST',
        body: JSON.stringify({ ...values, consent: document.querySelector('#consent').checked }),
      });
      form.reset();
      showMessage(message, result.message);
    } catch (error) {
      showMessage(message, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
} else {
  ownerView.hidden = false;
  const loginPanel = document.querySelector('#login-panel');
  const rosterPanel = document.querySelector('#roster-panel');
  const loginMessage = document.querySelector('#login-message');
  const rosterMessage = document.querySelector('#roster-message');

  function renderRegistrations(entries) {
    const rows = document.querySelector('#registration-rows');
    rows.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('tr');
      const registeredAt = new Date(entry.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      for (const value of [entry.name, entry.email, entry.phone, registeredAt]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    document.querySelector('#registration-count').textContent = String(entries.length);
    document.querySelector('#empty-state').hidden = entries.length > 0;
  }

  async function loadRegistrations() {
    try {
      const result = await requestJson('/api/owner/registrations');
      renderRegistrations(result.registrations);
      showMessage(rosterMessage, '');
    } catch (error) {
      if (error.message === 'Owner sign-in required.') {
        rosterPanel.hidden = true;
        loginPanel.hidden = false;
      } else showMessage(rosterMessage, error.message, true);
    }
  }

  async function initializeOwnerView() {
    try {
      await requestJson('/api/owner/session');
      loginPanel.hidden = true;
      rosterPanel.hidden = false;
      await loadRegistrations();
    } catch {
      loginPanel.hidden = false;
      rosterPanel.hidden = true;
    }
  }

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showMessage(loginMessage, 'Checking password…');
    try {
      await requestJson('/api/owner/login', {
        method: 'POST',
        body: JSON.stringify({ password: new FormData(form).get('password') }),
      });
      form.reset();
      await initializeOwnerView();
    } catch (error) {
      showMessage(loginMessage, error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#logout-button').addEventListener('click', async () => {
    try { await requestJson('/api/owner/logout', { method: 'POST', body: '{}' }); } catch {}
    rosterPanel.hidden = true;
    loginPanel.hidden = false;
  });

  initializeOwnerView();
  window.setInterval(() => {
    if (!rosterPanel.hidden) loadRegistrations();
  }, 30_000);
}