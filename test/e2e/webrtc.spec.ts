import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';

const origin = process.env.PETCAM_TEST_URL ?? 'https://127.0.0.1:8443';
const password = process.env.PETCAM_PASSWORD ?? 'test-password-123';

async function signIn(page: Page, next: '/' | '/station'): Promise<void> {
  await page.goto(new URL(next, origin).toString());
  if (new URL(page.url()).pathname === '/login') {
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
}

async function createDeviceContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['camera', 'microphone'],
  });
  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    Object.defineProperty(window, '__petcamPeerConnections', { value: peers, configurable: false });
    const signalingMessages: unknown[] = [];
    Object.defineProperty(window, '__petcamSignalingMessages', { value: signalingMessages, configurable: false });
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try { signalingMessages.push(JSON.parse(event.data) as unknown); } catch { /* Ignore non-JSON frames. */ }
        });
        return socket;
      },
    });
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args) {
        const connection = Reflect.construct(target, args) as RTCPeerConnection;
        peers.push(connection);
        return connection;
      },
    });
  });
  return context;
}

async function receivedStat(page: Page, kind: 'audio' | 'video', field: 'bytesReceived' | 'framesDecoded' | 'packetsReceived'): Promise<number> {
  return page.evaluate(async ({ kind, field }) => {
    const peers = (window as Window & { __petcamPeerConnections?: RTCPeerConnection[] }).__petcamPeerConnections ?? [];
    const values = await Promise.all(peers.map((peer) => peer.getStats()));
    let total = 0;
    for (const report of values) {
      report.forEach((stat) => {
        if (stat.type === 'inbound-rtp' && stat.kind === kind) {
          const value = stat[field];
          if (typeof value === 'number') total += value;
        }
      });
    }
    return total;
  }, { kind, field });
}

async function expectReceivedMedia(page: Page, kind: 'audio' | 'video', field: 'bytesReceived' | 'framesDecoded' | 'packetsReceived'): Promise<void> {
  await expect.poll(() => receivedStat(page, kind, field), { timeout: 10_000 }).toBeGreaterThan(0);
}

test('station video reaches the viewer and Talk toggles the return stream', async ({ browser }) => {
  test.setTimeout(45_000);
  const stationContext = await createDeviceContext(browser);
  const viewerContext = await createDeviceContext(browser);
  try {
    const station = await stationContext.newPage();
    await signIn(station, '/station');
    await expect(station.getByRole('heading', { name: 'PetCam station' })).toBeVisible();
    await station.getByRole('button', { name: 'Start station' }).click();
    await expect(station.getByRole('button', { name: 'Stop station' })).toBeVisible();

    const viewer = await viewerContext.newPage();
    await signIn(viewer, '/');
    await expect(viewer.locator('#app')).toHaveAttribute('data-state', 'live', { timeout: 20_000 });
    await expectReceivedMedia(viewer, 'video', 'framesDecoded');
    await expect(viewer.getByRole('button', { name: 'Tap for sound' })).toBeVisible();

    await viewer.getByRole('button', { name: 'Talk', exact: true }).click();
    await expect(station.locator('#app')).toHaveAttribute('data-state', 'talking', { timeout: 10_000 });
    await expect(station.locator('#talk-banner')).toContainText('Your person is talking');
    await expectReceivedMedia(station, 'video', 'framesDecoded');

    await viewer.getByRole('button', { name: 'Stop talking' }).click();
    await expect(station.locator('#app')).toHaveAttribute('data-state', 'live', { timeout: 10_000 });

    const pushToTalk = viewer.getByRole('button', { name: 'Push to talk' });
    await pushToTalk.hover();
    await viewer.mouse.down();
    await expect(station.locator('#app')).toHaveAttribute('data-state', 'talking', { timeout: 10_000 });
    await expectReceivedMedia(station, 'audio', 'bytesReceived');
    await expectReceivedMedia(station, 'audio', 'packetsReceived');
    const receivedBytesWhileHeld = await receivedStat(station, 'audio', 'bytesReceived');
    const receivedPacketsWhileHeld = await receivedStat(station, 'audio', 'packetsReceived');
    await expect.poll(() => receivedStat(station, 'audio', 'bytesReceived'), { timeout: 5_000 }).toBeGreaterThan(receivedBytesWhileHeld);
    await expect.poll(() => receivedStat(station, 'audio', 'packetsReceived'), { timeout: 5_000 }).toBeGreaterThan(receivedPacketsWhileHeld);
    await viewer.mouse.up();
    await expect(station.locator('#app')).toHaveAttribute('data-state', 'live', { timeout: 10_000 });
    await expect.poll(() => station.evaluate(() => {
      const messages = (window as Window & { __petcamSignalingMessages?: unknown[] }).__petcamSignalingMessages ?? [];
      return messages.some((message) => typeof message === 'object' && message !== null
        && 'type' in message && message.type === 'talk' && 'audio' in message && message.audio === false);
    }), { timeout: 5_000 }).toBe(true);
  } finally {
    await Promise.all([stationContext.close(), viewerContext.close()]);
  }
});

test('a second viewer replaces the first and the first can reconnect on request', async ({ browser }) => {
  const stationContext = await createDeviceContext(browser);
  const firstContext = await createDeviceContext(browser);
  const secondContext = await createDeviceContext(browser);
  try {
    const station = await stationContext.newPage();
    await signIn(station, '/station');
    await station.getByRole('button', { name: 'Start station' }).click();

    const first = await firstContext.newPage();
    await signIn(first, '/');
    await expect(first.locator('#app')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
    await expect.poll(() => station.evaluate(() => (window as Window & { __petcamPeerConnections: RTCPeerConnection[] }).__petcamPeerConnections.length)).toBe(1);

    const second = await secondContext.newPage();
    await signIn(second, '/');

    await expect(first.getByRole('heading', { name: 'Opened elsewhere' })).toBeVisible({ timeout: 10_000 });
    await expect(first.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect(second.locator('#app')).toHaveAttribute('data-state', /connecting|offline|live/);
    await expect.poll(() => station.evaluate(() => (window as Window & { __petcamPeerConnections: RTCPeerConnection[] }).__petcamPeerConnections.length)).toBeGreaterThanOrEqual(2);
  } finally {
    await Promise.all([stationContext.close(), firstContext.close(), secondContext.close()]);
  }
});
