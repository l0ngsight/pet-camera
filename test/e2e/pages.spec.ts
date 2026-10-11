import { expect, test } from '@playwright/test';
import WebSocket from 'ws';

const password = process.env.PETCAM_PASSWORD ?? 'test-password-123';
const port = new URL(process.env.PETCAM_TEST_URL ?? 'https://127.0.0.1:8443').port || '443';

test('login keeps the requested page and station starts from a user gesture', async ({ page }) => {
  await page.goto('/station');
  await expect(page).toHaveURL(/\/login\?next=(?:%2F|\/)station$/);
  await expect(page.locator('#login-form')).toHaveAttribute('method', 'post');
  await expect(page.locator('#station-hint')).toContainText(`Open the station on the laptop itself at https://localhost:${port}/station.`);
  await expect(page.getByRole('link', { name: 'Install this once on your phone so you never see a certificate warning' })).toHaveAttribute('href', '/ca.crt');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/station$/);

  await expect(page.getByRole('heading', { name: 'PetCam station' })).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('data-state', 'offline');
  await page.getByRole('button', { name: 'Start station' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-state', /connecting|offline|live/);
  await expect(page.getByRole('button', { name: 'Stop station' })).toBeVisible();
});

test('login keeps submit disabled until its script is ready', async ({ page }) => {
  let releaseScript!: () => void;
  let notifyScriptRequested!: () => void;
  const scriptBlocked = new Promise<void>((resolve) => { releaseScript = resolve; });
  const scriptRequested = new Promise<void>((resolve) => { notifyScriptRequested = resolve; });

  await page.route('**/assets/login.js', async (route) => {
    notifyScriptRequested();
    await scriptBlocked;
    await route.continue();
  });

  const navigation = page.goto('/login', { waitUntil: 'commit' });
  try {
    await scriptRequested;
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  } finally {
    releaseScript();
  }
  await navigation;
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('viewer offers an accessible offline state and keeps talk disabled until live', async ({ page }) => {
  await page.goto('/');
  if (new URL(page.url()).pathname === '/login') {
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  await expect(page.getByRole('heading', { name: 'Your station is offline' })).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('data-state', /connecting|offline|live|talking/);
  await expect(page.getByRole('button', { name: 'Talk', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Push to talk' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Talk', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Push to talk' })).toBeDisabled();
});

test('unauthenticated viewer pages, session preflight, and WS upgrade are rejected', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\?next=(?:%2F|\/)$/);
    const session = await page.request.get('/api/session');
    expect(session.status()).toBe(401);
    const wsRejected = await page.evaluate(() => new Promise<boolean>((resolve) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/ws?role=viewer`);
      const timeout = window.setTimeout(() => resolve(false), 3_000);
      socket.addEventListener('open', () => { window.clearTimeout(timeout); socket.close(); resolve(false); }, { once: true });
      socket.addEventListener('error', () => { window.clearTimeout(timeout); resolve(true); }, { once: true });
    }));
    expect(wsRejected).toBe(true);

    const wsStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(new URL('/ws?role=viewer', process.env.PETCAM_TEST_URL ?? 'https://127.0.0.1:8443').toString().replace(/^https:/, 'wss:'), {
        origin: process.env.PETCAM_TEST_URL ?? 'https://127.0.0.1:8443',
        rejectUnauthorized: false,
      });
      const timeout = setTimeout(() => reject(new Error('Unauthenticated WebSocket upgrade timed out')), 3_000);
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timeout);
        resolve(response.statusCode ?? 0);
      });
      socket.once('open', () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error('Unauthenticated WebSocket upgrade unexpectedly opened'));
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    expect(wsStatus).toBe(401);
  } finally {
    await context.close();
  }
});
