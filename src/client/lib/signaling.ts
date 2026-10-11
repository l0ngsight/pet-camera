import type { ClientToServer, Role, ServerToStation, ServerToViewer } from '../../shared/protocol.js';
import { LIVENESS_TIMEOUT_MS, WS_PATH } from '../../shared/protocol.js';

export type SignalState = 'connecting' | 'connected' | 'replaced' | 'unauthorized';
type ServerMessages<R extends Role> = R extends 'station' ? ServerToStation : ServerToViewer;

export interface SignalingHandlers<R extends Role> {
  onMessage(message: ServerMessages<R>): void;
  onState(state: SignalState, message?: string): void;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

/** Auth-aware WebSocket client with in-page retry and server ping/pong liveness. */
export class SignalingClient<R extends Role> {
  private socket: WebSocket | null = null;
  private timer: number | undefined;
  private stopped = true;
  private attempts = 0;
  private lastPingAt = 0;
  private livenessTimer = 0;

  private readonly role: R;
  private readonly handlers: SignalingHandlers<R>;

  constructor(role: R, handlers: SignalingHandlers<R>) {
    this.role = role;
    this.handlers = handlers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.livenessTimer) this.startLivenessTimer();
    void this.connect();
  }

  reconnect(): void {
    if (this.stopped) this.stopped = false;
    this.attempts = 0;
    if (!this.livenessTimer) this.startLivenessTimer();
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    } else {
      void this.connect();
    }
  }

  send(message: ClientToServer): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    window.clearInterval(this.livenessTimer);
    this.livenessTimer = 0;
    this.socket?.close(1000, 'page stopped');
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onState('connecting');
    try {
      const session = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (session.status === 401) {
        this.handlers.onState('unauthorized');
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname === '/station' ? '/station' : '/')}`);
        return;
      }
      if (!session.ok) throw new Error(`Session check failed (${session.status})`);
    } catch (error) {
      if (this.stopped) return;
      this.handlers.onState('connecting', 'Network unavailable. Retrying…');
      this.scheduleReconnect();
      return;
    }

    if (this.stopped) return;
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}${WS_PATH}?role=${this.role}`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.attempts = 0;
      this.lastPingAt = Date.now();
      this.handlers.onState('connected');
    });
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (socket !== this.socket || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as ServerMessages<R>;
        if (message.type === 'ping') {
          this.lastPingAt = Date.now();
          this.send({ type: 'pong' });
          return;
        }
        this.handlers.onMessage(message);
      } catch {
        // Ignore malformed server frames; the server validates client frames.
      }
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (this.stopped) return;
      if (event.code === 4409) {
        this.handlers.onState('replaced', 'Opened elsewhere. Reconnect to take over.');
        return;
      }
      if (event.code === 4401) {
        this.handlers.onState('unauthorized', 'Your session expired. Sign in again.');
        this.redirectToLogin();
        return;
      }
      this.handlers.onState('connecting', 'Connection lost. Reconnecting…');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => socket.close());
  }

  private redirectToLogin(): void {
    this.stopped = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    window.clearInterval(this.livenessTimer);
    this.livenessTimer = 0;
    const next = window.location.pathname === '/station' ? '/station' : '/';
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== undefined) return;
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 10_000;
    this.attempts += 1;
    const jitteredDelay = delay * (0.8 + Math.random() * 0.4);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, jitteredDelay);
  }

  private checkLiveness(): void {
    if (this.stopped || !this.socket || this.socket.readyState !== WebSocket.OPEN || !this.lastPingAt) return;
    if (Date.now() - this.lastPingAt > LIVENESS_TIMEOUT_MS) this.socket.close();
  }

  private startLivenessTimer(): void {
    this.livenessTimer = window.setInterval(() => this.checkLiveness(), 5_000);
  }
}
