// Composes the HTTPS server, the WS upgrade path and the signaling hub.
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CloseCode, MAX_MESSAGE_BYTES, PING_INTERVAL_MS, type Role } from '../shared/protocol';
import type { Config } from './config';
import { createHttpHandlers, loadAssets } from './http';
import type { Logger } from './log';
import { createHub, type Conn } from './signaling';

export interface ServerOptions {
  config: Config;
  tls: { cert: string; key: string; ca?: { pem: string } | undefined };
  /** dist/public: `pages/*.html` and `assets/*`. */
  publicDir: string;
  log: Logger;
  now?: () => number;
  /** How often the hub checks liveness. Must be well below PING_INTERVAL_MS. */
  tickMs?: number;
  /** Test seams, passed through to the HTTP handlers. */
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  loginDelay?: (ms: number) => Promise<void>;
}

export interface PetcamServer {
  start(): Promise<AddressInfo>;
  /** Idempotent. Closes sockets with 1001 and stops listening. */
  stop(): Promise<void>;
}

const REASONS: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createPetcamServer(opts: ServerOptions): PetcamServer {
  const { config, log } = opts;
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? Math.min(5_000, PING_INTERVAL_MS / 3);
  const hub = createHub({ now, log });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  let unsubscribeKeyChange: (() => void) | undefined;

  function attach(ws: WebSocket, role: Role): void {
    const conn: Conn = {
      role,
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      terminate: () => ws.terminate(),
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(CloseCode.PROTOCOL_ERROR, 'binary');
        hub.disconnect(conn);
        return;
      }
      hub.message(conn, data as Buffer);
    });
    ws.on('error', (err) => log('warn', 'ws error', { role, err: String(err) }));
    ws.on('close', () => hub.disconnect(conn));
    hub.connect(conn);
  }

  async function start(): Promise<AddressInfo> {
    const assets = await loadAssets(opts.publicDir, log);
    const http = createHttpHandlers({
      config,
      assets,
      log,
      now,
      caPem: opts.tls.ca?.pem,
      ...(opts.remoteAddress && { remoteAddress: opts.remoteAddress }),
      ...(opts.loginDelay && { loginDelay: opts.loginDelay }),
    });
    const srv = createServer({ cert: opts.tls.cert, key: opts.tls.key, minVersion: 'TLSv1.2' }, http.handleRequest);
    srv.requestTimeout = 30_000;
    srv.on('upgrade', (req, socket, head) => {
      if (stopping) return rejectUpgrade(socket, 503);
      const decision = http.authorizeUpgrade(req);
      if (!decision.ok) {
        log('warn', 'ws upgrade rejected', { status: decision.status });
        return rejectUpgrade(socket, decision.status);
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, decision.role));
    });
    srv.on('tlsClientError', () => {}); // browsers probing a self-signed cert is normal noise
    srv.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    server = srv;
    // A new password or session secret must not leave previously authenticated sockets connected.
    unsubscribeKeyChange = config.onKeyChange(() => hub.revokeAll());
    config.startWatching();
    timer = setInterval(() => hub.tick(), tickMs);
    timer.unref();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(config.port, config.host, () => {
        srv.off('error', reject);
        resolve();
      });
    });
    return srv.address() as AddressInfo;
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (timer) clearInterval(timer);
      unsubscribeKeyChange?.();
      config.stopWatching();
      hub.shutdown();
      // Give clients a moment to complete the close handshake, then cut the rest.
      const deadline = Date.now() + 1000;
      while (wss.clients.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      for (const ws of wss.clients) ws.terminate();
      if (!server) return;
      const srv = server;
      srv.closeIdleConnections();
      const force = setTimeout(() => srv.closeAllConnections(), 2000);
      await new Promise<void>((resolve) => (srv.listening ? srv.close(() => resolve()) : resolve()));
      clearTimeout(force);
    })();
    return stopping;
  }

  return { start, stop };
}
