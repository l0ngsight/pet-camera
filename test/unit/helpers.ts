// Shared helpers for API-level tests: a real HTTPS server on a random port, a tiny https client and WS helpers.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type Config } from '../../src/server/config';
import { createPetcamServer, type PetcamServer } from '../../src/server/server';
import { loadTls, type TlsMaterial } from '../../src/server/tls';

export const PASSWORD = 'test-password-123';

let tlsCache: TlsMaterial | undefined;
let tlsDir: string | undefined;
export async function sharedTls(): Promise<TlsMaterial> {
  if (!tlsCache) {
    tlsDir = await mkdtemp(join(tmpdir(), 'petcam-test-tls-'));
    tlsCache = await loadTls({ dataDir: tlsDir, ips: [], hostname: 'localhost', log: () => {} });
  }
  return tlsCache;
}
export async function cleanupSharedTls(): Promise<void> {
  if (tlsDir) await rm(tlsDir, { recursive: true, force: true });
  tlsCache = undefined;
}

export interface TestServer {
  port: number;
  server: PetcamServer;
  config: Config;
  root: string;
  dataDir: string;
  /** Number of password verifications (i.e. scrypt runs for a hashed password) the server started. */
  verifyCalls(): number;
  /** Delays the server applied to logins because of the global failure budget. */
  appliedDelays: number[];
  tls: TlsMaterial;
  stop(): Promise<void>;
}

export interface TestServerOptions {
  /** Artificial latency inside password verification, to make concurrent attempts overlap. */
  verifyDelayMs?: number;
  /** Serve this TLS material instead of the shared local-CA one (e.g. one without a CA). */
  tls?: TlsMaterial;
}

/**
 * The server sees every client as `X-Test-Remote` if that header is set (tests can't change the socket's
 * real remote address); otherwise as its real one (127.0.0.1).
 */
export async function startTestServer(extraEnv: Record<string, string> = {}, o: TestServerOptions = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), 'petcam-test-'));
  try {
    return await startIn(root, extraEnv, o);
  } catch (err) {
    await rm(root, { recursive: true, force: true }); // a failed start must not leave TLS/config material behind
    throw err;
  }
}

async function startIn(root: string, extraEnv: Record<string, string>, o: TestServerOptions): Promise<TestServer> {
  const publicDir = join(root, 'public');
  await mkdir(join(publicDir, 'pages'), { recursive: true });
  await mkdir(join(publicDir, 'assets'), { recursive: true });
  await writeFile(join(publicDir, 'pages', 'login.html'), '<!doctype html><title>login</title>');
  await writeFile(join(publicDir, 'pages', 'viewer.html'), '<!doctype html><title>viewer</title>');
  await writeFile(join(publicDir, 'pages', 'station.html'), '<!doctype html><title>station</title>');
  await writeFile(join(publicDir, 'assets', 'viewer.js'), 'console.log("viewer")');
  await writeFile(join(publicDir, 'assets', 'styles.css'), 'body{}');
  await writeFile(join(root, 'secret.txt'), 'TOP SECRET'); // sits next to public/: must never be reachable
  const dataDir = join(root, 'data');
  const config = await loadConfig(
    { PETCAM_DATA_DIR: dataDir, PETCAM_PASSWORD: PASSWORD, PETCAM_PORT: '0', PETCAM_HOST: '127.0.0.1', ...extraEnv },
    { hashParams: { N: 1024, r: 8, p: 1 }, watchIntervalMs: 30 },
  );
  let calls = 0;
  const realVerify = config.verifyPassword.bind(config);
  config.verifyPassword = async (candidate) => {
    calls++;
    if (o.verifyDelayMs) await new Promise((r) => setTimeout(r, o.verifyDelayMs));
    return realVerify(candidate);
  };
  const appliedDelays: number[] = [];
  const tls = o.tls ?? (await sharedTls());
  const server = createPetcamServer({
    config,
    tls,
    publicDir,
    log: () => {},
    tickMs: 50,
    remoteAddress: (req) => (req.headers['x-test-remote'] as string | undefined) ?? req.socket.remoteAddress,
    loginDelay: async (ms) => { appliedDelays.push(ms); },
  });
  const { port } = await server.start();
  return {
    port, server, config, root, dataDir, tls, appliedDelays,
    verifyCalls: () => calls,
    stop: async () => { await server.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

export interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer; origin?: string | null } = {},
): Promise<Res> {
  // Browsers always send Origin on non-GET requests, so do the same unless a test says otherwise (origin: null).
  const headers = { ...opts.headers };
  if (method !== 'GET' && method !== 'HEAD' && opts.origin !== null && !('origin' in headers)) {
    headers['origin'] = opts.origin ?? `https://127.0.0.1:${port}`;
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, method, path, rejectUnauthorized: false, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  origin?: string | null,
): Promise<Res> {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const opts: Parameters<typeof request>[3] = { headers: { 'content-type': 'application/json', ...headers }, body: data };
  if (origin !== undefined) opts.origin = origin;
  return request(port, 'POST', path, opts);
}

/** Logs in and returns the `name=value` pair to send back in a Cookie header. */
export async function login(port: number, password = PASSWORD, headers: Record<string, string> = {}): Promise<string> {
  const res = await postJson(port, '/api/login', { password }, headers);
  if (res.status !== 204) throw new Error(`login failed: ${res.status} ${res.body}`);
  return cookiePair(res);
}

export function cookiePair(res: Res): string {
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  if (!first) throw new Error('no Set-Cookie');
  return first.split(';')[0]!;
}

export interface WsHandle {
  ws: WebSocket;
  messages: any[];
  closed: Promise<{ code: number; reason: string }>;
  next(predicate?: (m: any) => boolean, timeoutMs?: number): Promise<any>;
}

export function openWs(
  port: number,
  role: string,
  opts: { cookie?: string; origin?: string | null; path?: string; headers?: Record<string, string> } = {},
): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const origin = opts.origin === undefined ? `https://127.0.0.1:${port}` : opts.origin;
    if (origin) headers['Origin'] = origin;
    const ws = new WebSocket(`wss://127.0.0.1:${port}${opts.path ?? '/ws'}?role=${role}`, { rejectUnauthorized: false, headers });
    const messages: any[] = [];
    const waiters: Array<() => void> = [];
    ws.on('message', (d) => { messages.push(JSON.parse(d.toString())); waiters.splice(0).forEach((w) => w()); });
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    const handle: WsHandle = {
      ws, messages, closed,
      async next(predicate = () => true, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const i = messages.findIndex(predicate);
          if (i >= 0) return messages.splice(i, 1)[0];
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`timed out waiting for message; queue=${JSON.stringify(messages)}`);
          await new Promise<void>((r) => { waiters.push(r); setTimeout(r, left); });
        }
      },
    };
    ws.once('open', () => resolve(handle));
    ws.once('unexpected-response', (_req, res) => { res.resume(); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    ws.once('error', (e) => reject(e));
  });
}
