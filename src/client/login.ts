const form = document.querySelector<HTMLFormElement>('#login-form');
const passwordInput = document.querySelector<HTMLInputElement>('#password');
const error = document.querySelector<HTMLElement>('#login-error');
const stationHint = document.querySelector<HTMLElement>('#station-hint');
const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');

if (stationHint && new URLSearchParams(window.location.search).get('next') === '/station') {
  const stationUrl = `https://localhost${window.location.port ? `:${window.location.port}` : ''}/station`;
  stationHint.textContent = `Open the station on the laptop itself at ${stationUrl}.`;
  stationHint.hidden = false;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!passwordInput || !error) return;
  if (submitButton) submitButton.disabled = true;
  error.textContent = '';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (response.ok) {
      const requested = new URLSearchParams(window.location.search).get('next');
      const next = requested === '/station' ? '/station' : '/';
      window.location.assign(next);
      return;
    }
    error.textContent = response.status === 429
      ? 'Too many attempts. Please wait a little and try again.'
      : response.status === 401
        ? 'That password didn’t match. Try again.'
        : 'Unable to sign in right now. Please try again.';
  } catch {
    error.textContent = 'Can’t reach PetCam. Check your connection and try again.';
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

if (submitButton) submitButton.disabled = false;
