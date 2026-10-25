import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { SESSION_COOKIE } from '../../src/server/auth';
import { revokeSessions, setPassword } from '../../src/server/config';
import { rateLimitKey } from '../../src/server/http';
import { cleanupSharedTls, cookiePair, login, openWs, PASSWORD, postJson, request, startTestServer, type TestServer } from './helpers';

let srv: TestServer;
beforeEach(async () => { srv = await startTestServer(); });
afterEach(async () => { await srv.stop(); });
afterAll(cleanupSharedTls);

const get = (path: string, headers: Record<string, string> = {}) => request(srv.port, 'GET', path, { headers });

const REMOTE = { 'x-test-remote': '192.168.1.50' };
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('security headers', () => {
  it.each(['/login', '/healthz', '/nope', '/api/session', '/assets/viewer.js', '/'])('are set on %s', async (path) => {
    const res = await get(path);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toBe('camera=(self), microphone=(self), screen-wake-lock=(self)');
  });

  it('sets no-store on HTML and /api/*', async () => {
    expect((await get('/login')).headers['cache-control']).toBe('no-store');
    expect((await get('/api/session')).headers['cache-control']).toBe('no-store');
    expect((await get('/', { cookie: await login(srv.port) })).headers['cache-control']).toBe('no-store');
  });
});

describe('public routes', () => {
  it('GET /healthz -> 200 ok', async () => {
    const res = await get('/healthz');
    expect(res).toMatchObject({ status: 200, body: 'ok' });
  });

  it('GET /login serves the login page without auth', async () => {
    const res = await get('/login');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('<title>login</title>');
  });

  it('unknown paths -> 404', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/api/nope')).status).toBe(404);
  });

  it('wrong method on a known path -> 405 with Allow', async () => {
    const a = await request(srv.port, 'POST', '/login');
    expect(a.status).toBe(405);
    expect(a.headers['allow']).toBe('GET, HEAD');
    const b = await get('/api/login');
    expect(b.status).toBe(405);
    expect(b.headers['allow']).toBe('POST');
    expect((await request(srv.port, 'DELETE', '/api/session')).status).toBe(405);
  });
});

describe('pages require a session', () => {
  it('redirects to /login with a fixed next', async () => {
    const a = await get('/');
    expect(a.status).toBe(302);
    expect(a.headers['location']).toBe('/login?next=/');
    const b = await get('/station');
    expect(b.status).toBe(302);
    expect(b.headers['location']).toBe('/login?next=/station');
  });

  it('serves viewer and station with a valid cookie', async () => {
    const cookie = await login(srv.port);
    expect((await get('/', { cookie })).body).toContain('<title>viewer</title>');
    expect((await get('/station', { cookie })).body).toContain('<title>station</title>');
  });

  it('redirects on a tampered cookie', async () => {
    const cookie = await login(srv.port);
    const bad = cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await get('/', { cookie: bad })).status).toBe(302);
  });
});

describe('POST /api/login', () => {
  it('204 with a hardened session cookie on success', async () => {
    const res = await postJson(srv.port, '/api/login', { password: PASSWORD });
    expect(res.status).toBe(204);
    const set = [res.headers['set-cookie']].flat()[0]!;
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000$`));
  });

  it('401 invalid_password, with no cookie', async () => {
    const res = await postJson(srv.port, '/api/login', { password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_password' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('415 unless Content-Type is application/json', async () => {
    const res = await request(srv.port, 'POST', '/api/login', { headers: { 'content-type': 'text/plain' }, body: '{"password":"x"}' });
    expect(res.status).toBe(415);
    const none = await request(srv.port, 'POST', '/api/login', { body: '{"password":"x"}' });
    expect(none.status).toBe(415);
    const charset = await postJson(srv.port, '/api/login', { password: PASSWORD }, { 'content-type': 'application/json; charset=utf-8' });
    expect(charset.status).toBe(204);
  });

  it.each([
    ['not json', 'nope'],
    ['array', '[]'],
    ['missing password', '{}'],
    ['non-string password', '{"password":123}'],
    ['oversized body', JSON.stringify({ password: 'x'.repeat(2000) })],
  ])('400 bad_request for %s', async (_name, body) => {
    const res = await postJson(srv.port, '/api/login', body);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'bad_request' });
  });

  it('429 after 5 failures, even for the right password, and ignores X-Forwarded-For', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await postJson(srv.port, '/api/login', { password: 'wrong-password' }, { 'x-forwarded-for': `9.9.9.${i}` });
      expect(r.status).toBe(401);
    }
    const blocked = await postJson(srv.port, '/api/login', { password: PASSWORD }, { 'x-forwarded-for': '8.8.8.8' });
    expect(blocked.status).toBe(429);
    const body = JSON.parse(blocked.body);
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBe(String(body.retryAfterSec));
  });

  it('a successful login clears the failure count', async () => {
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 4; i++) await postJson(srv.port, '/api/login', { password: 'wrong-password' });
      expect((await postJson(srv.port, '/api/login', { password: PASSWORD })).status).toBe(204);
    }
  });
});

describe('sessions', () => {
  it('GET /api/session -> 401 without a cookie', async () => {
    const res = await get('/api/session');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('GET /api/session -> 200 and a refreshed cookie', async () => {
    const cookie = await login(srv.port);
    const res = await get('/api/session', { cookie });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(cookiePair(res)).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    // The refreshed cookie is itself valid.
    expect((await get('/api/session', { cookie: cookiePair(res) })).status).toBe(200);
  });

  it('POST /api/logout clears the cookie', async () => {
    const res = await request(srv.port, 'POST', '/api/logout');
    expect(res.status).toBe(204);
    expect([res.headers['set-cookie']].flat()[0]).toContain('Max-Age=0');
  });
});

describe('Origin check on non-GET requests', () => {
  it.each([
    ['missing', null],
    ['foreign', 'https://evil.example'],
    ['wrong port', 'https://127.0.0.1:1'],
    ['http scheme', 'http://127.0.0.1:__PORT__'],
    ['null origin', 'null'],
  ])('POST /api/login with a %s Origin -> 403 bad_origin', async (_n, origin) => {
    const o = origin?.replace('__PORT__', String(srv.port));
    const res = await postJson(srv.port, '/api/login', { password: PASSWORD }, {}, o ?? null);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'bad_origin' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is enforced on /api/logout and on every other non-GET request', async () => {
    expect((await request(srv.port, 'POST', '/api/logout', { origin: null })).status).toBe(403);
    expect((await request(srv.port, 'POST', '/api/logout', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await request(srv.port, 'POST', '/api/logout')).status).toBe(204);
    expect((await request(srv.port, 'DELETE', '/anything', { origin: null })).status).toBe(403);
    expect((await request(srv.port, 'PUT', '/login', { origin: null })).status).toBe(403);
  });

  it('does not apply to GET or HEAD', async () => {
    expect((await get('/login')).status).toBe(200);
    expect((await request(srv.port, 'HEAD', '/login')).status).toBe(200);
  });

  it('a wrong-password attempt with a bad Origin does not count toward the rate limit or verify anything', async () => {
    for (let i = 0; i < 10; i++) await postJson(srv.port, '/api/login', { password: 'wrong-password' }, {}, 'https://evil.example');
    expect(srv.verifyCalls()).toBe(0);
    expect((await postJson(srv.port, '/api/login', { password: PASSWORD })).status).toBe(204);
  });
});

describe('station is loopback-only', () => {
  it('GET /station from a non-loopback address -> 403 with a hint, even without a cookie', async () => {
    const res = await get('/station', REMOTE);
    expect(res.status).toBe(403);
    expect(res.body).toBe(`Open https://localhost:${srv.port}/station on the laptop itself`);
    const cookie = await login(srv.port);
    expect((await get('/station', { ...REMOTE, cookie })).status).toBe(403);
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('GET /station from %s is allowed (cookie still required)', async (addr) => {
    expect((await get('/station', { 'x-test-remote': addr })).status).toBe(302);
    const cookie = await login(srv.port);
    expect((await get('/station', { 'x-test-remote': addr, cookie })).status).toBe(200);
  });

  it.each(['::ffff:127.0.0.2', '127.0.0.2', '::2', '', 'localhost'])('does not treat %j as loopback', async (addr) => {
    expect((await get('/station', { 'x-test-remote': addr || ' ' })).status).toBe(403);
  });

  it('the viewer page and the API stay open to remote authenticated clients', async () => {
    const cookie = await login(srv.port, PASSWORD, REMOTE);
    expect((await get('/', { ...REMOTE, cookie })).status).toBe(200);
    expect((await get('/api/session', { ...REMOTE, cookie })).status).toBe(200);
  });

  it('role=station upgrades from a non-loopback address -> 403, role=viewer is fine', async () => {
    const cookie = await login(srv.port);
    await expect(openWs(srv.port, 'station', { cookie, headers: REMOTE })).rejects.toMatchObject({ status: 403 });
    await expect(openWs(srv.port, 'station', { headers: REMOTE })).rejects.toMatchObject({ status: 403 }); // before auth
    const v = await openWs(srv.port, 'viewer', { cookie, headers: REMOTE });
    v.ws.close();
    const s = await openWs(srv.port, 'station', { cookie });
    s.ws.close();
  });

  it('a remote client cannot displace the real station', async () => {
    const cookie = await login(srv.port);
    const station = await openWs(srv.port, 'station', { cookie });
    await expect(openWs(srv.port, 'station', { cookie, headers: REMOTE })).rejects.toMatchObject({ status: 403 });
    expect(station.ws.readyState).toBe(station.ws.OPEN);
    station.ws.close();
  });
});

describe('GET /ca.crt', () => {
  it('serves the public CA certificate as a download, without any key material', async () => {
    const res = await get('/ca.crt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect(res.headers['content-disposition']).toBe('attachment; filename="petcam-ca.crt"');
    expect(res.body).toBe(srv.tls.ca!.pem);
    expect(res.body).not.toContain('PRIVATE KEY');
    expect(new X509Certificate(res.body).subject).toContain('PetCam Local CA');
    expect((await request(srv.port, 'HEAD', '/ca.crt')).status).toBe(200);
  });

  it('is public (no cookie) and POST is 405', async () => {
    expect((await request(srv.port, 'POST', '/ca.crt')).status).toBe(405);
  });

  it('is 404 when a user-supplied certificate is used', async () => {
    const { ca: _ca, ...noCa } = srv.tls;
    const other = await startTestServer({}, { tls: noCa });
    try {
      expect((await request(other.port, 'GET', '/ca.crt')).status).toBe(404);
    } finally { await other.stop(); }
  });
});

describe('login brute-force defences', () => {
  it('20 concurrent wrong logins from one address run at most 5 password checks', async () => {
    const limited = await startTestServer({}, { verifyDelayMs: 30 });
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => postJson(limited.port, '/api/login', { password: 'wrong-password' })));
      expect(limited.verifyCalls()).toBeLessThanOrEqual(5);
      expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
      expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
      // the burst only used up the attempts that actually ran, so the owner can still log in afterwards
      expect((await postJson(limited.port, '/api/login', { password: PASSWORD })).status).toBe(204);
    } finally { await limited.stop(); }
  });

  it('allows one in-flight attempt per address; others get an immediate 429', async () => {
    const slow = await startTestServer({}, { verifyDelayMs: 100 });
    try {
      const [a, b] = await Promise.all([
        postJson(slow.port, '/api/login', { password: 'wrong-password' }),
        postJson(slow.port, '/api/login', { password: 'wrong-password' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([401, 429]);
      expect(slow.verifyCalls()).toBe(1);
      // a different address is not held up by it
      const [c, d] = await Promise.all([
        postJson(slow.port, '/api/login', { password: PASSWORD }, { 'x-test-remote': '10.0.0.1' }),
        postJson(slow.port, '/api/login', { password: PASSWORD }, { 'x-test-remote': '10.0.0.2' }),
      ]);
      expect([c.status, d.status]).toEqual([204, 204]);
    } finally { await slow.stop(); }
  });

  it('delays every login by 2 s (not a lockout) once more than 20 failures pile up across addresses', async () => {
    for (let i = 0; i < 20; i++) {
      await postJson(srv.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `10.1.0.${i}` });
    }
    expect(srv.appliedDelays).toEqual([]);
    await postJson(srv.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': '10.1.1.1' });
    expect(srv.appliedDelays).toEqual([]); // the 21st failure is what tips it
    const ok = await postJson(srv.port, '/api/login', { password: PASSWORD }, { 'x-test-remote': '10.2.0.1' });
    expect(ok.status).toBe(204); // the owner still gets in
    expect(srv.appliedDelays).toEqual([2000]);
  });

  it('once the budget is exceeded, logins from many addresses run one at a time and only 5 may wait; the laptop skips the queue', async () => {
    const slow = await startTestServer({}, { verifyDelayMs: 40 });
    try {
      for (let i = 0; i <= 20; i++) {
        await postJson(slow.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `10.1.0.${i}` });
      }
      const before = slow.verifyCalls();
      const [laptop, ...burst] = await Promise.all([
        postJson(slow.port, '/api/login', { password: PASSWORD }), // 127.0.0.1
        ...Array.from({ length: 12 }, (_, i) => postJson(slow.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `10.3.0.${i}` })),
      ]);
      expect(laptop!.status).toBe(204);
      expect(burst.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
      expect(burst.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(7);
      expect(slow.verifyCalls() - before).toBeLessThanOrEqual(6); // ≤ 5 queued + the laptop
      // the queued ones never overlapped each other; at most the laptop's check ran alongside one of them
      expect(slow.maxConcurrentVerifies()).toBeLessThanOrEqual(2);
    } finally { await slow.stop(); }
  });

  it('a refused (queue full) attempt does not use up that address\'s 5 attempts', async () => {
    const slow = await startTestServer({}, { verifyDelayMs: 40 });
    try {
      for (let i = 0; i <= 20; i++) {
        await postJson(slow.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `10.1.0.${i}` });
      }
      const burst = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        postJson(slow.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `10.4.0.${i}` })));
      const refused = burst.findIndex((r) => r.status === 429);
      expect(refused).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 5; i++) {
        const r = await postJson(slow.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `10.4.0.${refused}` });
        expect(r.status).toBe(401);
      }
    } finally { await slow.stop(); }
  });

  it('counts IPv6 addresses per /64, so one host cannot rotate through its prefix', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await postJson(srv.port, '/api/login', { password: 'wrong-password' }, { 'x-test-remote': `2001:db8:1:2::${i}` });
      expect(r.status).toBe(401);
    }
    const sameNet = await postJson(srv.port, '/api/login', { password: PASSWORD }, { 'x-test-remote': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    expect(sameNet.status).toBe(429);
    const otherNet = await postJson(srv.port, '/api/login', { password: PASSWORD }, { 'x-test-remote': '2001:db8:1:3::1' });
    expect(otherNet.status).toBe(204);
  });
});

describe('rateLimitKey', () => {
  it('keeps IPv4 as is and unwraps IPv4-mapped IPv6', () => {
    expect(rateLimitKey('192.168.1.5')).toBe('192.168.1.5');
    expect(rateLimitKey('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(rateLimitKey('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('reduces IPv6 to its /64 whatever the notation', () => {
    const key = '2001:db8:0:1::/64';
    expect(rateLimitKey('2001:db8:0:1::1')).toBe(key);
    expect(rateLimitKey('2001:0db8:0000:0001:ffff:ffff:ffff:ffff')).toBe(key);
    expect(rateLimitKey('2001:db8:0:1:0:0:0:2')).toBe(key);
    expect(rateLimitKey('2001:db8::1:0:0:0')).toBe('2001:db8:0:0::/64'); // :: expands in the middle
    expect(rateLimitKey('2001:db8:0:1::1.2.3.4')).toBe(key);
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('2001:db8:0:1::1')).not.toBe(rateLimitKey('2001:db8:0:2::1'));
  });
});

describe('revocation of a running server', () => {
  it('revoke-sessions: old cookies stop working, open sockets get 4401, the password still works', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    const s = await openWs(srv.port, 'station', { cookie });
    expect((await get('/api/session', { cookie })).status).toBe(200);

    await revokeSessions(srv.dataDir); // the file watcher (30 ms in tests) picks it up
    expect((await v.closed).code).toBe(4401);
    expect((await s.closed).code).toBe(4401);
    expect((await get('/api/session', { cookie })).status).toBe(401);
    expect((await get('/', { cookie })).status).toBe(302);
    await expect(openWs(srv.port, 'viewer', { cookie })).rejects.toMatchObject({ status: 401 });

    const fresh = await login(srv.port);
    expect((await get('/api/session', { cookie: fresh })).status).toBe(200);
  });

  it('set-password: the old password is rejected at once and sockets get 4401', async () => {
    const hashed = await startTestServer({ PETCAM_PASSWORD: '' });
    try {
      const oldPw = hashed.config.generatedPassword!;
      const cookie = await login(hashed.port, oldPw);
      const v = await openWs(hashed.port, 'viewer', { cookie });
      await setPassword(hashed.dataDir, 'a brand new passphrase', { N: 1024, r: 8, p: 1 });
      expect((await v.closed).code).toBe(4401);
      expect((await postJson(hashed.port, '/api/login', { password: oldPw })).status).toBe(401);
      expect((await postJson(hashed.port, '/api/login', { password: 'a brand new passphrase' }, { 'x-test-remote': '10.9.9.9' })).status).toBe(204);
      expect((await get('/api/session', { cookie })).status).toBe(401);
    } finally { await hashed.stop(); }
  });

  it('a corrupt config.json does not log anyone out', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${srv.dataDir}/config.json`, '{broken');
    await new Promise((r) => setTimeout(r, 200));
    expect(v.ws.readyState).toBe(v.ws.OPEN);
    expect((await get('/api/session', { cookie })).status).toBe(200);
    v.ws.close();
  });
});

describe('static assets', () => {
  it('serves files from the in-memory map with the right types', async () => {
    const js = await get('/assets/viewer.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.body).toBe('console.log("viewer")');
    expect((await get('/assets/styles.css')).headers['content-type']).toMatch(/^text\/css/);
  });

  it('supports conditional requests via ETag', async () => {
    const first = await get('/assets/viewer.js');
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();
    expect((await get('/assets/viewer.js', { 'if-none-match': etag })).status).toBe(304);
  });

  it.each([
    '/assets/../secret.txt',
    '/assets/%2e%2e/secret.txt',
    '/assets/..%2fsecret.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/assets//etc/passwd',
    '/assets/..\\secret.txt',
    '/assets/viewer.js%00.png',
    '/assets/',
    '/assets',
    '/assets/missing.js',
    '/pages/login.html',
    '/secret.txt',
  ])('never reaches the filesystem: %s', async (path) => {
    const res = await request(srv.port, 'GET', path);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('TOP SECRET');
  });
});

describe('WebSocket upgrade', () => {
  it('rejects without a cookie (401), with a bad cookie (401)', async () => {
    await expect(openWs(srv.port, 'viewer')).rejects.toMatchObject({ status: 401 });
    await expect(openWs(srv.port, 'viewer', { cookie: `${SESSION_COOKIE}=1.bad` })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a foreign or missing Origin (403)', async () => {
    const cookie = await login(srv.port);
    await expect(openWs(srv.port, 'viewer', { cookie, origin: 'https://evil.example' })).rejects.toMatchObject({ status: 403 });
    await expect(openWs(srv.port, 'viewer', { cookie, origin: `http://127.0.0.1:${srv.port}` })).rejects.toMatchObject({ status: 403 });
    await expect(openWs(srv.port, 'viewer', { cookie, origin: null })).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a bad role (400) and a wrong path (404)', async () => {
    const cookie = await login(srv.port);
    await expect(openWs(srv.port, 'admin', { cookie })).rejects.toMatchObject({ status: 400 });
    await expect(openWs(srv.port, '', { cookie })).rejects.toMatchObject({ status: 400 });
    await expect(openWs(srv.port, 'viewer', { cookie, path: '/other' })).rejects.toMatchObject({ status: 404 });
  });

  it('accepts a valid session, announces the peer and relays signaling both ways', async () => {
    const cookie = await login(srv.port);
    const station = await openWs(srv.port, 'station', { cookie });
    expect(await station.next()).toEqual({ type: 'peer', present: false });
    const viewer = await openWs(srv.port, 'viewer', { cookie });
    expect(await viewer.next()).toEqual({ type: 'peer', present: true });
    expect(await station.next()).toEqual({ type: 'peer', present: true });

    const offer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } };
    viewer.ws.send(JSON.stringify({ ...offer, injected: 'x' }));
    expect(await station.next((m) => m.type === 'offer')).toEqual(offer);

    const answer = { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' } };
    station.ws.send(JSON.stringify(answer));
    expect(await viewer.next((m) => m.type === 'answer')).toEqual(answer);

    const talk = { type: 'talk', audio: true, video: false };
    viewer.ws.send(JSON.stringify(talk));
    expect(await station.next((m) => m.type === 'talk')).toEqual(talk);

    viewer.ws.close();
    expect(await station.next((m) => m.type === 'peer')).toEqual({ type: 'peer', present: false });
    station.ws.close();
  });

  it('closes a second viewer\'s predecessor with 4409', async () => {
    const cookie = await login(srv.port);
    const v1 = await openWs(srv.port, 'viewer', { cookie });
    const v2 = await openWs(srv.port, 'viewer', { cookie });
    expect((await v1.closed).code).toBe(4409);
    expect(await v2.next()).toEqual({ type: 'peer', present: false });
    v2.ws.close();
  });

  it('closes with 4400 on a disallowed or malformed message', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    v.ws.send(JSON.stringify({ type: 'answer', sdp: { type: 'answer', sdp: 'v=0' } }));
    expect((await v.closed).code).toBe(4400);
    const s = await openWs(srv.port, 'station', { cookie });
    s.ws.send('garbage');
    expect((await s.closed).code).toBe(4400);
  });

  it('closes with 4400 on binary frames', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    v.ws.send(Buffer.from([1, 2, 3]));
    expect((await v.closed).code).toBe(4400);
  });

  it('closes oversized frames (maxPayload)', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    v.ws.send(JSON.stringify({ type: 'pong', pad: 'x'.repeat(70 * 1024) }));
    expect((await v.closed).code).toBe(1009);
  });

  it('sends server pings', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    // tickMs=50 in tests but PING_INTERVAL_MS is 15 s; ping is covered by the hub unit tests.
    // Here we only assert the connection stays healthy across several ticks.
    await new Promise((r) => setTimeout(r, 200));
    expect(v.ws.readyState).toBe(v.ws.OPEN);
    v.ws.close();
  });

  it('graceful stop closes sockets with 1001', async () => {
    const cookie = await login(srv.port);
    const v = await openWs(srv.port, 'viewer', { cookie });
    const closed = v.closed;
    await srv.server.stop();
    expect((await closed).code).toBe(1001);
  });
});
