import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { getFreePort } from './support';

const password = process.env.PETCAM_PASSWORD ?? 'test-password-123';

function startServer(port: number, dataDir: string): ChildProcess {
  return spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/server/main.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PETCAM_PORT: String(port), PETCAM_HOST: '127.0.0.1', PETCAM_DATA_DIR: dataDir, PETCAM_PASSWORD: password },
    stdio: 'ignore',
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit').then(() => true);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); });
  const stopped = await Promise.race([exited, timedOut]);
  if (timeout) clearTimeout(timeout);
  if (!stopped) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

function serverResponds(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: 500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function waitForServer(child: ChildProcess, url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Test server exited before becoming ready');
    if (await serverResponds(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not become ready');
}

test('authenticated viewer reconnects automatically after a server restart', async ({ browser }) => {
  test.setTimeout(45_000);
  const port = await getFreePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'petcam-e2e-restart-'));
  const url = `https://127.0.0.1:${port}/`;
  let server = startServer(port, dataDir);
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;

  try {
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      let count = 0;
      Object.defineProperty(window, '__petcamWsOpenCount', { get: () => count });
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args) as WebSocket;
          socket.addEventListener('open', () => { count += 1; });
          return socket;
        },
      });
    });

    await waitForServer(server, new URL('/login', url).toString());
    const page = await context.newPage();
    await page.goto(url);
    if (new URL(page.url()).pathname === '/login') {
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(url);
    }
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'offline');
    await expect.poll(() => page.evaluate(() => (window as Window & { __petcamWsOpenCount: number }).__petcamWsOpenCount)).toBe(1);

    await stopServer(server);
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'connecting', { timeout: 5_000 });
    server = startServer(port, dataDir);
    await waitForServer(server, new URL('/login', url).toString());

    await expect.poll(
      () => page.evaluate(() => (window as Window & { __petcamWsOpenCount: number }).__petcamWsOpenCount),
      { timeout: 20_000 },
    ).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'offline');
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await stopServer(server);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }
});
