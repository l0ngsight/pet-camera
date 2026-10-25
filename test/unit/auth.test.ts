import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SCRYPT_MAXMEM,
  SESSION_MAX_AGE_SEC,
  clearSessionCookie,
  createRateLimiter,
  deriveSessionKey,
  hashPassword,
  issueSession,
  plainPasswordMatches,
  readSessionToken,
  sanitizeNext,
  sessionCookieHeader,
  signSessionExp,
  verifyPasswordHash,
  verifySession,
} from '../../src/server/auth';

// Low-cost scrypt params keep the suite fast; production default is N=2^15.
const FAST = { N: 1024, r: 8, p: 1 };

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse', FAST);
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPasswordHash('correct horse', stored)).toBe(true);
    expect(await verifyPasswordHash('correct horsf', stored)).toBe(false);
    expect(await verifyPasswordHash('', stored)).toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
  });

  it('defaults to N=2^15, r=8, p=1 and a 32-byte salt', async () => {
    const stored = await hashPassword('pw-default');
    const [, n, r, p, salt] = stored.split('$');
    expect([n, r, p]).toEqual(['32768', '8', '1']);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(32);
    expect(await verifyPasswordHash('pw-default', stored)).toBe(true);
  });

  it('caps scrypt memory at 64 MiB and still handles the default parameters', async () => {
    expect(SCRYPT_MAXMEM).toBe(64 * 1024 * 1024);
    const heavy = `scrypt$${2 ** 16}$8$1$${Buffer.alloc(32, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;
    expect(await verifyPasswordHash('x', heavy)).toBe(false); // refused, not computed
  });

  it('returns false (not throw) on malformed stored hashes', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2', 'bcrypt$1024$8$1$aa$bb', 'scrypt$abc$8$1$aa$bb', 'scrypt$1000$8$1$aa$bb',
      `scrypt$${2 ** 25}$8$1$aa$bb`]) {
      expect(await verifyPasswordHash('x', bad)).toBe(false);
    }
  });
});

describe('plain password (PETCAM_PASSWORD)', () => {
  it('compares in constant-time form and handles different lengths', () => {
    expect(plainPasswordMatches('secret-pass', 'secret-pass')).toBe(true);
    expect(plainPasswordMatches('secret-pasZ', 'secret-pass')).toBe(false);
    expect(plainPasswordMatches('short', 'secret-pass')).toBe(false);
    expect(plainPasswordMatches('', 'secret-pass')).toBe(false);
  });
});

describe('session cookies', () => {
  const secret = Buffer.alloc(32, 7).toString('base64');
  const key = deriveSessionKey(secret, 'verifier-A');
  const now = 1_800_000_000;

  it('derives different keys per verifier and per secret', () => {
    expect(deriveSessionKey(secret, 'verifier-A').equals(key)).toBe(true);
    expect(deriveSessionKey(secret, 'verifier-B').equals(key)).toBe(false);
    expect(deriveSessionKey(Buffer.alloc(32, 8).toString('base64'), 'verifier-A').equals(key)).toBe(false);
  });

  it('round-trips a valid token', () => {
    const token = issueSession(key, now);
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(token.startsWith(`${now + SESSION_MAX_AGE_SEC}.`)).toBe(true);
    expect(verifySession(key, token, now)).toBe(true);
    expect(verifySession(key, token, now + SESSION_MAX_AGE_SEC - 1)).toBe(true);
  });

  it('rejects expired tokens', () => {
    const token = issueSession(key, now);
    expect(verifySession(key, token, now + SESSION_MAX_AGE_SEC)).toBe(false);
    expect(verifySession(key, token, now + SESSION_MAX_AGE_SEC + 1000)).toBe(false);
  });

  it('rejects tampered, foreign-key and malformed tokens', () => {
    const token = issueSession(key, now);
    const [exp, mac] = token.split('.') as [string, string];
    expect(verifySession(key, `${Number(exp) + 100}.${mac}`, now)).toBe(false); // extended expiry
    expect(verifySession(key, `${exp}.${mac.slice(0, -2)}AA`, now)).toBe(false);
    expect(verifySession(key, `${exp}.${mac}x`, now)).toBe(false);
    expect(verifySession(deriveSessionKey(secret, 'verifier-B'), token, now)).toBe(false); // password changed
    for (const bad of ['', '.', 'abc', 'a.b', `${exp}`, `${exp}.`, `.${mac}`, `-5.${mac}`, `1e9.${mac}`, `${exp}.${mac}.x`]) {
      expect(verifySession(key, bad, now)).toBe(false);
    }
  });

  it('uses the __Host- cookie prefix', () => {
    expect(SESSION_COOKIE).toBe('__Host-petcam_session');
  });

  it('parses exp strictly and bounds it to now..now+30d+60s', () => {
    const at = (exp: string) => `${exp}.${signSessionExp(key, exp)}`;
    expect(verifySession(key, at(String(now + 1)), now)).toBe(true);
    expect(verifySession(key, at(String(now)), now)).toBe(false); // expired
    expect(verifySession(key, at(String(now - 5)), now)).toBe(false);
    expect(verifySession(key, at(String(now + SESSION_MAX_AGE_SEC + 60)), now)).toBe(true);
    expect(verifySession(key, at(String(now + SESSION_MAX_AGE_SEC + 61)), now)).toBe(false); // too far in the future
    // correctly signed, but not a plain 1-10 digit integer
    for (const odd of ['12345678901', '+1900000000', '1900000000.0', '1.9e9', ' 1900000000', '0x7fffffff', '']) {
      expect(verifySession(key, at(odd), now)).toBe(false);
    }
  });

  it('builds hardened Set-Cookie headers', () => {
    const header = sessionCookieHeader('1.abc');
    expect(header).toBe(`${SESSION_COOKIE}=1.abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`);
    const cleared = clearSessionCookie();
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
  });

  it('reads the session token from a Cookie header', () => {
    expect(readSessionToken(`${SESSION_COOKIE}=1.abc`)).toBe('1.abc');
    expect(readSessionToken(`a=b; ${SESSION_COOKIE}=1.abc; c=d`)).toBe('1.abc');
    expect(readSessionToken('a=b')).toBeNull();
    expect(readSessionToken(undefined)).toBeNull();
    expect(readSessionToken(`x${SESSION_COOKIE}=1.abc`)).toBeNull();
  });
});

describe('rate limiter', () => {
  const make = (t: { now: number }, opts = {}) =>
    createRateLimiter({ maxFailures: 5, windowMs: 15 * 60_000, maxEntries: 1000, globalFailureThreshold: 20, globalDelayMs: 2000, now: () => t.now, ...opts });
  type Limiter = ReturnType<typeof make>;
  /** One full failed attempt. */
  const failOnce = (rl: Limiter, ip: string) => {
    const a = rl.begin(ip);
    if (a.ok) a.finish(false);
    return a;
  };

  it('allows 5 attempts then blocks with retryAfterSec until the window ends', () => {
    const t = { now: 1_000_000 };
    const rl = make(t);
    for (let i = 0; i < 5; i++) expect(failOnce(rl, '1.1.1.1').ok).toBe(true);
    expect(rl.begin('1.1.1.1')).toEqual({ ok: false, retryAfterSec: 900 });
    t.now += 600_000;
    expect(rl.begin('1.1.1.1')).toEqual({ ok: false, retryAfterSec: 300 });
    t.now += 300_000;
    expect(rl.begin('1.1.1.1').ok).toBe(true);
  });

  it('counts an attempt when it begins, before it finishes', () => {
    const t = { now: 0 };
    const rl = make(t);
    for (let i = 0; i < 4; i++) failOnce(rl, 'a');
    const fifth = rl.begin('a'); // in flight, not finished
    expect(fifth.ok).toBe(true);
    fifth.ok && fifth.finish(false);
    expect(rl.begin('a').ok).toBe(false); // the 5th already counted
  });

  it('allows one in-flight attempt per IP', () => {
    const t = { now: 0 };
    const rl = make(t);
    const first = rl.begin('a');
    expect(first.ok).toBe(true);
    expect(rl.begin('a')).toEqual({ ok: false, retryAfterSec: 1 });
    expect(rl.begin('b').ok).toBe(true); // other IPs unaffected
    first.ok && first.finish(false);
    expect(rl.begin('a').ok).toBe(true);
  });

  it('clears the count on success', () => {
    const t = { now: 0 };
    const rl = make(t);
    for (let i = 0; i < 4; i++) failOnce(rl, 'a');
    const ok = rl.begin('a');
    ok.ok && ok.finish(true);
    for (let i = 0; i < 5; i++) expect(failOnce(rl, 'a').ok).toBe(true);
    expect(rl.begin('a').ok).toBe(false);
  });

  it('tracks addresses independently', () => {
    const t = { now: 0 };
    const rl = make(t);
    for (let i = 0; i < 5; i++) failOnce(rl, 'b');
    expect(rl.begin('b').ok).toBe(false);
    expect(rl.begin('a').ok).toBe(true);
  });

  it('resets the count once the window has passed', () => {
    const t = { now: 0 };
    const rl = make(t);
    for (let i = 0; i < 4; i++) failOnce(rl, 'a');
    t.now += 15 * 60_000;
    for (let i = 0; i < 5; i++) expect(failOnce(rl, 'a').ok).toBe(true);
  });

  it('caps the map, evicting the oldest entry that is not locked out', () => {
    const t = { now: 0 };
    const rl = make(t, { maxEntries: 3 });
    for (let i = 0; i < 5; i++) failOnce(rl, 'locked');
    failOnce(rl, 'b');
    failOnce(rl, 'c');
    t.now += 1;
    failOnce(rl, 'd'); // evicts b, the oldest that is not locked out
    expect(rl.size()).toBe(3);
    expect(rl.begin('locked').ok).toBe(false);
    for (let i = 0; i < 4; i++) failOnce(rl, 'c');
    expect(rl.begin('c').ok).toBe(false); // c kept its earlier failure
    const b = rl.begin('b'); // evicted, so it starts afresh (and evicts d)
    expect(b.ok).toBe(true);
  });

  it('never resets a lockout by cycling through new addresses; refuses them when every slot is locked or in flight', () => {
    const t = { now: 0 };
    const rl = make(t, { maxEntries: 3 });
    for (const ip of ['a', 'b']) for (let i = 0; i < 5; i++) failOnce(rl, ip);
    const inflight = rl.begin('c');
    expect(inflight.ok).toBe(true);
    t.now += 60_000;
    expect(rl.begin('fresh')).toEqual({ ok: false, retryAfterSec: 840 });
    for (let i = 0; i < 100; i++) rl.begin(`x${i}`);
    expect(rl.begin('a').ok).toBe(false);
    expect(rl.size()).toBe(3);
    inflight.ok && inflight.finish(false);
    expect(rl.begin('fresh').ok).toBe(true); // c (1 failure, not locked) is now evictable
  });

  it('evicts a lockout whose window has passed', () => {
    const t = { now: 0 };
    const rl = make(t, { maxEntries: 2 });
    for (const ip of ['a', 'b']) for (let i = 0; i < 5; i++) failOnce(rl, ip);
    t.now += 15 * 60_000;
    expect(rl.begin('c').ok).toBe(true);
    expect(rl.size()).toBe(2);
  });

  it('adds a global delay once more than 20 failures (any IP) fall within the window', () => {
    const t = { now: 0 };
    const rl = make(t);
    for (let i = 0; i < 20; i++) failOnce(rl, `10.0.0.${i}`);
    expect(rl.globalDelayMs()).toBe(0);
    failOnce(rl, '10.0.1.1');
    expect(rl.globalDelayMs()).toBe(2000);
    t.now += 15 * 60_000;
    expect(rl.globalDelayMs()).toBe(0);
  });

  it('does not count successes toward the global budget', () => {
    const t = { now: 0 };
    const rl = make(t);
    for (let i = 0; i < 30; i++) { const a = rl.begin(`ip${i}`); a.ok && a.finish(true); }
    expect(rl.globalDelayMs()).toBe(0);
  });
});

describe('sanitizeNext', () => {
  it('allows exactly / and /station', () => {
    expect(sanitizeNext('/')).toBe('/');
    expect(sanitizeNext('/station')).toBe('/station');
  });
  it('falls back to / for everything else', () => {
    for (const bad of [null, undefined, '', '//evil.com', 'https://evil.com', '/station/', '/Station', '/login', '/\\evil.com',
      '/station?x=1', ' /station', '/%2e%2e/']) {
      expect(sanitizeNext(bad)).toBe('/');
    }
  });
});
