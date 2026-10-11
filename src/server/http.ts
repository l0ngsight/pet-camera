// HTTP routing, security headers, login/session API and in-memory static files. No request path ever reaches fs.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { parseRole, WS_PATH, type Role } from '../shared/protocol';
import {
  clearSessionCookie,
  createRateLimiter,
  issueSession,
  readSessionToken,
  sessionCookieHeader,
  verifySession,
} from './auth';
import type { Config } from './config';
import type { Logger } from './log';

const CSP =
  "default-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const MAX_LOGIN_BODY = 1024;

export interface StaticFile { body: Buffer; type: string; etag: string }
export interface Assets {
  pages: Partial<Record<'login' | 'viewer' | 'station', StaticFile>>;
  /** Keyed by request path, e.g. `/assets/viewer.js`. Built once at startup. */
  files: Map<string, StaticFile>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function toStatic(path: string): Promise<StaticFile> {
  const body = await readFile(path);
  return {
    body,
    type: TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
  };
}

/** Reads `<publicDir>/pages/{login,viewer,station}.html` and `<publicDir>/assets/*` into memory. */
export async function loadAssets(publicDir: string, log: Logger = () => {}): Promise<Assets> {
  const assets: Assets = { pages: {}, files: new Map() };
  for (const name of ['login', 'viewer', 'station'] as const) {
    try {
      assets.pages[name] = await toStatic(join(publicDir, 'pages', `${name}.html`));
    } catch {
      log('warn', 'page missing (run `npm run build`)', { page: name });
    }
  }
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(join(publicDir, 'assets'), { withFileTypes: true });
  } catch {
    log('warn', 'assets directory missing (run `npm run build`)');
  }
  for (const e of entries) {
    if (e.isFile()) assets.files.set(`/assets/${e.name}`, await toStatic(join(publicDir, 'assets', e.name)));
  }
  return assets;
}

export type UpgradeDecision = { ok: true; role: Role } | { ok: false; status: 400 | 401 | 403 | 404 };

export interface HttpDeps {
  config: Config;
  assets: Assets;
  log: Logger;
  /** PEM of the public local CA served at /ca.crt; undefined when a user-supplied certificate is used. */
  caPem?: string | undefined;
  now?: () => number;
  /**
   * The client's address, used for the loopback-only station and for rate limiting. Defaults to the socket's
   * remote address. Never derive it from headers in production (no proxy, so X-Forwarded-For is ignored).
   */
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  /** Sleeps for the global login delay; injectable so tests don't wait 2 s. */
  loginDelay?: (ms: number) => Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (addr: string | undefined): boolean => addr !== undefined && LOOPBACK.has(addr);

export function createHttpHandlers({ config, assets, log, caPem, now = Date.now, remoteAddress, loginDelay }: HttpDeps) {
  const limiter = createRateLimiter({
    maxFailures: 5,
    windowMs: 15 * 60_000,
    maxEntries: 1000,
    globalFailureThreshold: 20,
    globalDelayMs: 2000,
    now,
  });
  const nowSec = () => Math.floor(now() / 1000);
  const remote = remoteAddress ?? ((req: IncomingMessage) => req.socket.remoteAddress);
  const sleep = loginDelay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const caBody = caPem === undefined ? undefined : Buffer.from(caPem);

  /** Exact match, port included. Browsers always send Origin on non-GET requests and on WebSocket handshakes. */
  function originMatches(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return host !== undefined && req.headers.origin === `https://${host}`;
  }

  function hasSession(req: IncomingMessage): boolean {
    const token = readSessionToken(req.headers.cookie);
    return token !== null && verifySession(config.sessionKey, token, nowSec());
  }

  function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  function sendJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string | string[]> = {}): void {
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  }

  function sendStatic(req: IncomingMessage, res: ServerResponse, file: StaticFile, cache: string): void {
    const headers = { 'Content-Type': file.type, 'Cache-Control': cache, ETag: file.etag };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, { 'Cache-Control': cache, ETag: file.etag });
      res.end();
      return;
    }
    send(res, 200, file.body, headers);
  }

  function methodNotAllowed(res: ServerResponse, allow: string): void {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allow });
  }

  /** Reads at most MAX_LOGIN_BODY bytes; resolves null if the body is larger. */
  function readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_LOGIN_BODY) return resolve(null);
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_LOGIN_BODY) {
          chunks.length = 0;
          req.removeAllListeners('data');
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'unsupported_media_type' });
    }
    const raw = await readBody(req);
    const badRequest = () => {
      // Don't keep reading an oversized or garbage upload.
      res.once('finish', () => req.destroy());
      sendJson(res, 400, { error: 'bad_request' }, { Connection: 'close' });
    };
    if (!raw) return badRequest();
    let password: unknown;
    try {
      const body: unknown = JSON.parse(raw.toString('utf8'));
      password = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)['password'] : undefined;
    } catch {
      return badRequest();
    }
    if (typeof password !== 'string') return badRequest();

    // The attempt is counted *before* the slow hash, and only one may be in flight per address,
    // so parallel requests can't each get a free guess.
    const ip = remote(req) ?? 'unknown';
    const attempt = limiter.begin(ip);
    if (!attempt.ok) {
      log('warn', 'login rate limited', { ip });
      return sendJson(res, 429, { error: 'rate_limited', retryAfterSec: attempt.retryAfterSec }, { 'Retry-After': String(attempt.retryAfterSec) });
    }
    let ok = false;
    try {
      const delayMs = limiter.globalDelayMs();
      if (delayMs > 0) {
        log('warn', 'many failed logins; delaying logins', { delayMs });
        await sleep(delayMs);
      }
      ok = await config.verifyPassword(password);
    } finally {
      attempt.finish(ok);
    }
    if (!ok) {
      log('warn', 'login failed', { ip });
      return sendJson(res, 401, { error: 'invalid_password' });
    }
    log('info', 'login ok', { ip });
    res.writeHead(204, { 'Set-Cookie': sessionCookieHeader(issueSession(config.sessionKey, nowSec())) });
    res.end();
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    switch (path) {
      case '/healthz':
        return isRead ? send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' }) : methodNotAllowed(res, 'GET, HEAD');
      case '/login':
      case '/':
      case '/station': {
        if (!isRead) return methodNotAllowed(res, 'GET, HEAD');
        if (path === '/station' && !isLoopback(remote(req))) {
          log('warn', 'station page refused: not loopback', { ip: remote(req) });
          return send(res, 403, `Open https://localhost:${req.socket.localPort}/station on the laptop itself`, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
        }
        if (path !== '/login' && !hasSession(req)) {
          return send(res, 302, '', { Location: `/login?next=${path}`, 'Cache-Control': 'no-store' });
        }
        const page = assets.pages[path === '/login' ? 'login' : path === '/' ? 'viewer' : 'station'];
        if (!page) return send(res, 503, 'page not built: run `npm run build`', { 'Content-Type': 'text/plain; charset=utf-8' });
        return sendStatic(req, res, page, 'no-store');
      }
      case '/ca.crt':
        if (!isRead) return methodNotAllowed(res, 'GET, HEAD');
        if (!caBody) return sendJson(res, 404, { error: 'not_found' });
        return send(res, 200, caBody, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="petcam-ca.crt"',
          'Cache-Control': 'no-cache',
        });
      case '/api/login':
        return method === 'POST' ? handleLogin(req, res) : methodNotAllowed(res, 'POST');
      case '/api/session':
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        if (!hasSession(req)) return sendJson(res, 401, { error: 'unauthorized' });
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookieHeader(issueSession(config.sessionKey, nowSec())) });
      case '/api/logout':
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        res.writeHead(204, { 'Set-Cookie': clearSessionCookie() });
        return void res.end();
    }

    if (path.startsWith('/assets/')) {
      const file = assets.files.get(path); // exact key lookup: traversal sequences simply don't match
      if (!file) return sendJson(res, 404, { error: 'not_found' });
      if (!isRead) return methodNotAllowed(res, 'GET, HEAD');
      return sendStatic(req, res, file, 'no-cache');
    }
    sendJson(res, 404, { error: 'not_found' });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), screen-wake-lock=(self)');

    const url = req.url ?? '';
    if (!url.startsWith('/')) return void sendJson(res, 404, { error: 'not_found' });
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    if (path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originMatches(req)) {
      log('warn', 'bad origin', { path, origin: req.headers.origin });
      return void sendJson(res, 403, { error: 'bad_origin' });
    }

    route(req, res, path).catch((err: unknown) => {
      log('error', 'request failed', { path, err: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  }

  /**
   * Decides whether a WS upgrade may proceed: path, then loopback for the station role, then cookie,
   * then Origin (CSWSH defence), then role validity. The role is only acted on once the client is authenticated.
   */
  function authorizeUpgrade(req: IncomingMessage): UpgradeDecision {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'https://placeholder.invalid');
    } catch {
      return { ok: false, status: 404 };
    }
    if (url.pathname !== WS_PATH) return { ok: false, status: 404 };
    const role = parseRole(url.searchParams.get('role'));
    if (role === 'station' && !isLoopback(remote(req))) return { ok: false, status: 403 };
    if (!hasSession(req)) return { ok: false, status: 401 };
    if (!originMatches(req)) return { ok: false, status: 403 };
    return role ? { ok: true, role } : { ok: false, status: 400 };
  }

  return { handleRequest, authorizeUpgrade };
}
