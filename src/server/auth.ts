// Password hashing, stateless session cookies and login rate limiting. Pure functions; no I/O.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// __Host- makes the browser enforce Secure, Path=/ and no Domain, and keeps other services on this host from setting it.
export const SESSION_COOKIE = '__Host-petcam_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

// ---- password hashing: scrypt$<N>$<r>$<p>$<saltB64>$<hashB64> ----

export interface ScryptParams { N: number; r: number; p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 32;
const KEY_BYTES = 32;
/** Node's default maxmem (32 MiB) is too small for N=2^15, r=8, so it throws. */
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// 128 * N * r bytes of scratch space; N*r <= 2^18 keeps that at 32 MiB, safely under SCRYPT_MAXMEM.
const MAX_N_TIMES_R = 2 ** 18;

function scryptAsync(password: string, salt: Buffer, keylen: number, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEY_BYTES, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** Returns false (never throws) for a wrong password or a malformed/unsafe stored hash. */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Bound the parameters so a corrupt config can't make us allocate gigabytes.
  if (!isPowerOfTwo(N) || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16 || N * r > MAX_N_TIMES_R) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** PETCAM_PASSWORD path: compare SHA-256 digests so lengths never leak. */
export function plainPasswordMatches(candidate: string, actual: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

// ---- sessions: petcam_session=<expSec>.<base64url HMAC(key, "petcam:" + expSec)> ----

/** Key = HMAC-SHA256(sessionSecret, "v1:" + verifier). Changing the password changes the verifier and revokes all sessions. */
export function deriveSessionKey(sessionSecretB64: string, verifier: string): Buffer {
  return createHmac('sha256', Buffer.from(sessionSecretB64, 'base64')).update(`v1:${verifier}`).digest();
}

/** MAC over the exact expiry string, so what is verified is what was signed. */
export function signSessionExp(key: Buffer, expSec: string): string {
  return createHmac('sha256', key).update(`petcam:${expSec}`).digest('base64url');
}

export function issueSession(key: Buffer, nowSec: number): string {
  const exp = String(nowSec + SESSION_MAX_AGE_SEC);
  return `${exp}.${signSessionExp(key, exp)}`;
}

const TOKEN_RE = /^(\d{1,10})\.([A-Za-z0-9_-]{43})$/;
const CLOCK_SLACK_SEC = 60;

export function verifySession(key: Buffer, token: string, nowSec: number): boolean {
  const m = TOKEN_RE.exec(token);
  if (!m) return false;
  const [, exp, given] = m as unknown as [string, string, string];
  const a = Buffer.from(given);
  const b = Buffer.from(signSessionExp(key, exp));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expSec = Number(exp);
  return expSec > nowSec && expSec <= nowSec + SESSION_MAX_AGE_SEC + CLOCK_SLACK_SEC;
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const kv = part.trim();
    if (kv.startsWith(`${SESSION_COOKIE}=`)) return kv.slice(SESSION_COOKIE.length + 1);
  }
  return null;
}

// ---- login rate limiter ----

export interface RateLimiterOptions {
  /** Attempts per IP per window. */
  maxFailures: number;
  windowMs: number;
  maxEntries: number;
  /** More than this many failures (all IPs) within the window delays every login by globalDelayMs. */
  globalFailureThreshold: number;
  globalDelayMs: number;
  now?: () => number;
}
export type Attempt = { ok: true; finish(success: boolean): void } | { ok: false; retryAfterSec: number };

/**
 * An attempt is counted when it *begins* (before the slow password hash), and only one may be in flight per IP,
 * so parallel requests can't each get a free guess. A success clears the IP's count.
 */
export function createRateLimiter(opts: RateLimiterOptions) {
  const now = opts.now ?? Date.now;
  // Map iteration order = insertion order, so the first key is the oldest entry.
  const entries = new Map<string, { count: number; windowStart: number; inflight: boolean }>();
  // Timestamps of the most recent (threshold + 1) failures: "more than threshold within the window"
  // holds exactly when the oldest of these is still inside the window.
  const recentFailures: number[] = [];

  return {
    begin(ip: string): Attempt {
      let e = entries.get(ip);
      if (e && !e.inflight && now() - e.windowStart >= opts.windowMs) {
        entries.delete(ip);
        e = undefined;
      }
      if (e?.inflight) return { ok: false, retryAfterSec: 1 };
      if (e && e.count >= opts.maxFailures) {
        return { ok: false, retryAfterSec: Math.ceil((e.windowStart + opts.windowMs - now()) / 1000) };
      }
      if (!e) {
        if (entries.size >= opts.maxEntries) entries.delete(entries.keys().next().value as string);
        e = { count: 0, windowStart: now(), inflight: false };
        entries.set(ip, e);
      }
      e.count += 1;
      e.inflight = true;
      const entry = e;
      let done = false;
      return {
        ok: true,
        finish(success) {
          if (done) return;
          done = true;
          entry.inflight = false;
          if (success) {
            if (entries.get(ip) === entry) entries.delete(ip);
            return;
          }
          recentFailures.push(now());
          if (recentFailures.length > opts.globalFailureThreshold + 1) recentFailures.shift();
        },
      };
    },
    /** 0, or the delay to apply to this login because failures are piling up across IPs. */
    globalDelayMs(): number {
      const full = recentFailures.length === opts.globalFailureThreshold + 1;
      return full && now() - recentFailures[0]! < opts.windowMs ? opts.globalDelayMs : 0;
    },
    size: () => entries.size,
  };
}

// ---- redirect target sanitising (no open redirect) ----

export { sanitizeNext } from '../shared/next';
