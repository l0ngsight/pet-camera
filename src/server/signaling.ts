// Signaling hub: a socket-free state machine (roles, replacement, relay, validation, liveness).
// The ws adapter in http.ts/main.ts feeds it events and calls tick() on a timer.
import {
  CloseCode,
  LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseClientMessage,
  type Role,
  type ServerToClient,
} from '../shared/protocol';
import type { Logger } from './log';

/** The minimal socket surface the hub needs. */
export interface Conn {
  readonly role: Role;
  send(data: string): void;
  close(code: number, reason?: string): void;
  /** Hard-kill a socket that will not complete a close handshake. */
  terminate(): void;
}

export interface HubOptions {
  now?: () => number;
  log?: Logger;
  /** Max inbound messages per connection per window; beyond it the socket is closed with 4400. */
  maxMessages?: number;
  messageWindowMs?: number;
}

interface Entry {
  conn: Conn;
  lastSeen: number;
  lastPing: number;
  windowStart: number;
  windowCount: number;
}

const other = (role: Role): Role => (role === 'station' ? 'viewer' : 'station');

export function createHub(opts: HubOptions = {}) {
  const now = opts.now ?? Date.now;
  const log: Logger = opts.log ?? (() => {});
  const maxMessages = opts.maxMessages ?? 200;
  const messageWindowMs = opts.messageWindowMs ?? 10_000;
  const slots: Record<Role, Entry | undefined> = { station: undefined, viewer: undefined };

  const isCurrent = (conn: Conn) => slots[conn.role]?.conn === conn;

  function send(conn: Conn, msg: ServerToClient): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch (err) {
      log('warn', 'send failed, dropping connection', { role: conn.role, err: String(err) });
      conn.terminate();
      disconnect(conn);
    }
  }

  function sendPeer(role: Role, present: boolean): void {
    const e = slots[role];
    if (e) send(e.conn, { type: 'peer', present });
  }

  /** Removes `conn` from its slot (if still current) and tells the counterpart. Idempotent. */
  function disconnect(conn: Conn): void {
    if (!isCurrent(conn)) return;
    slots[conn.role] = undefined;
    log('info', 'ws disconnected', { role: conn.role });
    sendPeer(other(conn.role), false);
  }

  function connect(conn: Conn): void {
    const old = slots[conn.role];
    if (old) {
      // Detach first so the old socket's close event is a no-op, then close it.
      slots[conn.role] = undefined;
      log('info', 'ws replaced', { role: conn.role });
      old.conn.close(CloseCode.REPLACED, 'replaced');
    }
    const t = now();
    slots[conn.role] = { conn, lastSeen: t, lastPing: t, windowStart: t, windowCount: 0 };
    log('info', 'ws connected', { role: conn.role });
    // Counterpart sees the old peer leave and the new one arrive, so it rebuilds its session.
    if (old) sendPeer(other(conn.role), false);
    send(conn, { type: 'peer', present: slots[other(conn.role)] !== undefined });
    sendPeer(other(conn.role), true);
  }

  function reject(conn: Conn, reason: string): void {
    log('warn', 'ws protocol error', { role: conn.role, reason });
    conn.close(CloseCode.PROTOCOL_ERROR, reason);
    disconnect(conn);
  }

  function message(conn: Conn, raw: string | Uint8Array): void {
    const entry = slots[conn.role];
    if (!entry || entry.conn !== conn) return; // replaced or already dropped

    const t = now();
    if (t - entry.windowStart >= messageWindowMs) {
      entry.windowStart = t;
      entry.windowCount = 0;
    }
    if (++entry.windowCount > maxMessages) return reject(conn, 'rate_limited');

    const parsed = parseClientMessage(conn.role, raw);
    if (!parsed.ok) return reject(conn, parsed.reason);
    entry.lastSeen = t;

    const msg = parsed.msg;
    if (msg.type === 'pong') return;
    const target = slots[other(conn.role)];
    if (!target) return; // counterpart absent: drop silently
    send(target.conn, msg);
  }

  function tick(): void {
    const t = now();
    for (const role of ['station', 'viewer'] as const) {
      const e = slots[role];
      if (!e) continue;
      if (t - e.lastSeen > LIVENESS_TIMEOUT_MS) {
        log('warn', 'ws liveness timeout', { role });
        e.conn.close(CloseCode.LIVENESS, 'liveness');
        e.conn.terminate();
        disconnect(e.conn);
      } else if (t - e.lastPing >= PING_INTERVAL_MS) {
        e.lastPing = t;
        send(e.conn, { type: 'ping' });
      }
    }
  }

  function closeAll(code: number, reason: string): void {
    for (const role of ['station', 'viewer'] as const) {
      const e = slots[role];
      slots[role] = undefined; // detach first: the sockets' close events must not announce peer changes
      e?.conn.close(code, reason);
    }
  }

  const shutdown = () => closeAll(CloseCode.GOING_AWAY, 'server shutting down');
  /** Session key changed (password or secret rotated): nobody authenticated at upgrade time may stay connected. */
  const revokeAll = () => {
    log('warn', 'revoking all websocket connections');
    closeAll(CloseCode.UNAUTHORIZED, 'sessions revoked');
  };

  return { connect, message, disconnect, tick, shutdown, revokeAll };
}

export type Hub = ReturnType<typeof createHub>;
