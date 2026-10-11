// Signaling contract shared by server and clients. See docs/ARCHITECTURE.md §7.
// Owner of changes: architect (types) / backend (validators). Keep erasable TS only (no enums).

export type Role = 'station' | 'viewer';

/** SDP as produced by RTCPeerConnection.localDescription (only offer/answer are used). */
export interface Sdp {
  type: 'offer' | 'answer';
  sdp: string;
}

/** Subset of RTCIceCandidateInit we relay. */
export interface Candidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

// ---- Messages relayed between peers (server validates, re-serializes, forwards) ----
export interface OfferMsg { type: 'offer'; sdp: Sdp }            // viewer -> station
export interface AnswerMsg { type: 'answer'; sdp: Sdp }          // station -> viewer
export interface CandidateMsg { type: 'candidate'; candidate: Candidate } // both ways
export interface TalkMsg { type: 'talk'; audio: boolean; video: boolean } // viewer -> station

// ---- Liveness (not relayed) ----
export interface PingMsg { type: 'ping' } // server -> client, every PING_INTERVAL_MS
export interface PongMsg { type: 'pong' } // client -> server, reply to ping

// ---- Server -> client only ----
/** Sent right after connect and whenever the counterpart appears/disappears. */
export interface PeerMsg { type: 'peer'; present: boolean }

export type ViewerToServer = OfferMsg | CandidateMsg | TalkMsg | PongMsg;
export type StationToServer = AnswerMsg | CandidateMsg | PongMsg;
export type ClientToServer = ViewerToServer | StationToServer;

export type ServerToViewer = PeerMsg | PingMsg | AnswerMsg | CandidateMsg;
export type ServerToStation = PeerMsg | PingMsg | OfferMsg | CandidateMsg | TalkMsg;
export type ServerToClient = ServerToViewer | ServerToStation;

// ---- Constants ----
export const WS_PATH = '/ws'; // wss://host:port/ws?role=station|viewer
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_SDP_CHARS = 32 * 1024;
export const MAX_CANDIDATE_CHARS = 1024;
export const PING_INTERVAL_MS = 15_000;
/** Server terminates a socket with no pong for this long; client reconnects if no ping for this long. */
export const LIVENESS_TIMEOUT_MS = 40_000;

/** WebSocket close codes used by the server. Clients MUST NOT auto-reconnect on REPLACED or UNAUTHORIZED. */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down -> client reconnects
  PROTOCOL_ERROR: 4400, // malformed/unknown/disallowed message -> client reconnects with backoff
  UNAUTHORIZED: 4401, // password changed or sessions revoked -> client goes to /login?next=… (no backoff loop)
  REPLACED: 4409, // a newer connection with the same role took over -> client stops, shows "Reconnect" button
  LIVENESS: 4408, // no pong in time -> (client usually never sees this)
} as const;

// ---- Validators (Ben). Shared so the server can enforce and tests can import them. ----

export type ParseResult =
  | { ok: true; msg: ClientToServer }
  | { ok: false; reason: 'too_large' | 'bad_json' | 'bad_message' | 'not_allowed' };

const ALLOWED_TYPES: Record<Role, ReadonlySet<string>> = {
  viewer: new Set(['offer', 'candidate', 'talk', 'pong']),
  station: new Set(['answer', 'candidate', 'pong']),
};

const MAX_SDP_MID_CHARS = 256;
const MAX_MLINE_INDEX = 65535;

export function parseRole(value: unknown): Role | null {
  return value === 'station' || value === 'viewer' ? value : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSdp(v: unknown, expected: Sdp['type']): Sdp | null {
  if (!isRecord(v) || v['type'] !== expected) return null;
  const sdp = v['sdp'];
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_CHARS) return null;
  return { type: expected, sdp };
}

function parseCandidate(v: unknown): Candidate | null {
  if (!isRecord(v)) return null;
  const candidate = v['candidate'];
  if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_CHARS) return null;
  const mid = v['sdpMid'] ?? null;
  if (mid !== null && (typeof mid !== 'string' || mid.length > MAX_SDP_MID_CHARS)) return null;
  const idx = v['sdpMLineIndex'] ?? null;
  if (idx !== null && !(Number.isInteger(idx) && (idx as number) >= 0 && (idx as number) <= MAX_MLINE_INDEX)) {
    return null;
  }
  return { candidate, sdpMid: mid, sdpMLineIndex: idx as number | null };
}

/**
 * Validates one inbound WS frame from a client of `role` and returns a freshly built message
 * containing only known fields — callers must relay `msg`, never the raw frame.
 * Size is checked on bytes for buffers and on chars for strings (chars <= bytes; `ws` maxPayload is the hard cap).
 */
export function parseClientMessage(role: Role, raw: string | Uint8Array): ParseResult {
  const size = typeof raw === 'string' ? raw.length : raw.byteLength;
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: 'too_large' };

  let data: unknown;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  if (!isRecord(data) || typeof data['type'] !== 'string') return { ok: false, reason: 'bad_message' };

  const type = data['type'];
  if (!['offer', 'answer', 'candidate', 'talk', 'pong'].includes(type)) return { ok: false, reason: 'bad_message' };
  if (!ALLOWED_TYPES[role].has(type)) return { ok: false, reason: 'not_allowed' };

  switch (type) {
    case 'pong':
      return { ok: true, msg: { type: 'pong' } };
    case 'offer': {
      const sdp = parseSdp(data['sdp'], 'offer');
      return sdp ? { ok: true, msg: { type: 'offer', sdp } } : { ok: false, reason: 'bad_message' };
    }
    case 'answer': {
      const sdp = parseSdp(data['sdp'], 'answer');
      return sdp ? { ok: true, msg: { type: 'answer', sdp } } : { ok: false, reason: 'bad_message' };
    }
    case 'candidate': {
      const candidate = parseCandidate(data['candidate']);
      return candidate ? { ok: true, msg: { type: 'candidate', candidate } } : { ok: false, reason: 'bad_message' };
    }
    default: {
      const { audio, video } = data;
      if (typeof audio !== 'boolean' || typeof video !== 'boolean') return { ok: false, reason: 'bad_message' };
      return { ok: true, msg: { type: 'talk', audio, video } };
    }
  }
}
