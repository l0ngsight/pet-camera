import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertPasswordStrength, loadConfig, passwordProblem, revokeSessions, setPassword } from '../../src/server/config';

const FAST = { hashParams: { N: 1024, r: 8, p: 1 } };
const STRONG = 'correct horse battery';
let dir: string;
let logs: Array<[string, string]>;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'petcam-cfg-')), 'data');
  logs = [];
});
afterEach(async () => { await rm(join(dir, '..'), { recursive: true, force: true }); });
const env = (extra: Record<string, string> = {}) => ({ PETCAM_DATA_DIR: dir, ...extra });
const opts = (extra: object = {}) => ({ ...FAST, log: (l: string, m: string) => { logs.push([l, m]); }, ...extra });
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('password policy', () => {
  it('requires 12+ characters', () => {
    expect(passwordProblem('a1b2c3d4e5f')).toMatch(/at least 12/);
    expect(passwordProblem('a1b2c3d4e5f6')).toBeNull();
  });
  it('rejects common and trivially repetitive passwords, ignoring case', () => {
    for (const bad of ['password1234', 'PasswordPassword', '123456789012', 'qwertyuiop12', 'aaaaaaaaaaaaaaaa', 'abababababab']) {
      expect(passwordProblem(bad), bad).toMatch(/common|repeat/);
    }
  });
  it('assertPasswordStrength throws the problem', () => {
    expect(() => assertPasswordStrength('short')).toThrow(/at least 12/);
    expect(() => assertPasswordStrength(STRONG)).not.toThrow();
  });
});

describe('env parsing', () => {
  it('applies defaults', async () => {
    const c = await loadConfig({ PETCAM_DATA_DIR: dir }, opts());
    expect(c).toMatchObject({ port: 8443, host: '0.0.0.0', dataDir: dir });
    expect(c.tlsCertPath).toBeUndefined();
    const d = await loadConfig({}, opts({ cwd: dir + '-cwd' }));
    expect(d.dataDir).toBe(resolve(dir + '-cwd', 'data'));
    await rm(d.dataDir, { recursive: true, force: true });
  });

  it('reads overrides, allowing port 0 for tests', async () => {
    const c = await loadConfig(env({ PETCAM_PORT: '0', PETCAM_HOST: '127.0.0.1', PETCAM_TLS_CERT: '/c', PETCAM_TLS_KEY: '/k' }), opts());
    expect(c).toMatchObject({ port: 0, host: '127.0.0.1', tlsCertPath: '/c', tlsKeyPath: '/k' });
  });

  it.each(['abc', '-1', '65536', '80.5'])('rejects PETCAM_PORT=%j', async (bad) => {
    await expect(loadConfig(env({ PETCAM_PORT: bad }), opts())).rejects.toThrow(/PETCAM_PORT/);
  });
});

describe('first run and persistence', () => {
  it('generates a one-time password (randomInt alphabet), stores only its hash, with strict permissions', async () => {
    const c = await loadConfig(env(), opts());
    expect(c.generatedPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    expect(await c.verifyPassword(c.generatedPassword!)).toBe(true);
    expect(await c.verifyPassword('wrong-password')).toBe(false);

    const raw = await readFile(join(dir, 'config.json'), 'utf8');
    expect(raw).not.toContain(c.generatedPassword!);
    const json = JSON.parse(raw);
    expect(json.passwordHash).toMatch(/^scrypt\$/);
    expect(Buffer.from(json.sessionSecret, 'base64')).toHaveLength(32);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
  });

  it('chmods an existing, too-open data directory to 0700', async () => {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    await loadConfig(env(), opts());
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('prompts instead of generating when a prompt function is supplied (TTY), and never echoes it', async () => {
    const c = await loadConfig(env(), opts({ promptPassword: async () => STRONG }));
    expect(c.generatedPassword).toBeUndefined();
    expect(await c.verifyPassword(STRONG)).toBe(true);
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain(STRONG);
  });

  it('rejects a weak prompted password', async () => {
    await expect(loadConfig(env(), opts({ promptPassword: async () => 'short' }))).rejects.toThrow(/at least 12/);
  });

  it('does not prompt when PETCAM_PASSWORD is set or a hash already exists', async () => {
    let prompts = 0;
    const promptPassword = async () => { prompts++; return STRONG; };
    await loadConfig(env({ PETCAM_PASSWORD: STRONG }), opts({ promptPassword }));
    await loadConfig(env({ PETCAM_DATA_DIR: dir + '2' }), opts({ promptPassword }));
    await loadConfig(env({ PETCAM_DATA_DIR: dir + '2' }), opts({ promptPassword }));
    expect(prompts).toBe(1);
    await rm(dir + '2', { recursive: true, force: true });
  });

  it('keeps password and session key stable across restarts and prints nothing the second time', async () => {
    const a = await loadConfig(env(), opts());
    const b = await loadConfig(env(), opts());
    expect(b.generatedPassword).toBeUndefined();
    expect(b.sessionKey.equals(a.sessionKey)).toBe(true);
    expect(await b.verifyPassword(a.generatedPassword!)).toBe(true);
  });

  it('refuses to overwrite a corrupt config.json', async () => {
    await loadConfig(env(), opts());
    await writeFile(join(dir, 'config.json'), '{not json');
    await expect(loadConfig(env(), opts())).rejects.toThrow(/config\.json/);
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe('{not json');
  });

  it('rejects structurally invalid config.json', async () => {
    await loadConfig(env(), opts());
    await writeFile(join(dir, 'config.json'), JSON.stringify({ passwordHash: 'x', sessionSecret: 'AAAA' }));
    await expect(loadConfig(env(), opts())).rejects.toThrow(/config\.json/);
  });
});

describe('PETCAM_PASSWORD', () => {
  it('overrides the stored hash, with a different session key', async () => {
    const stored = await loadConfig(env(), opts());
    const c = await loadConfig(env({ PETCAM_PASSWORD: 'test-password-123' }), opts());
    expect(c.generatedPassword).toBeUndefined();
    expect(await c.verifyPassword('test-password-123')).toBe(true);
    expect(await c.verifyPassword(stored.generatedPassword!)).toBe(false);
    expect(c.sessionKey.equals(stored.sessionKey)).toBe(false);
  });

  it('works on a fresh data dir without storing the plaintext', async () => {
    const c = await loadConfig(env({ PETCAM_PASSWORD: 'test-password-123' }), opts());
    expect(c.generatedPassword).toBeUndefined();
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain('test-password-123');
    expect(c.sessionKey).toHaveLength(32);
  });

  it('warns (does not fail) when it is weak, and says nothing when it is fine', async () => {
    const weak = await loadConfig(env({ PETCAM_PASSWORD: 'x' }), opts());
    expect(weak.warnings.join()).toMatch(/PETCAM_PASSWORD.*at least 12/);
    expect(await weak.verifyPassword('x')).toBe(true);
    const common = await loadConfig(env({ PETCAM_PASSWORD: 'password1234' }), opts());
    expect(common.warnings.join()).toMatch(/common/);
    const fine = await loadConfig(env({ PETCAM_PASSWORD: STRONG }), opts());
    expect(fine.warnings).toEqual([]);
  });
});

describe('setPassword and revokeSessions (file side)', () => {
  it('setPassword replaces the hash, enforces policy, and works on a fresh dir', async () => {
    await setPassword(dir, STRONG, FAST.hashParams);
    expect((await loadConfig(env(), opts())).generatedPassword).toBeUndefined();
    await expect(setPassword(dir, 'short', FAST.hashParams)).rejects.toThrow(/at least 12/);
    await expect(setPassword(dir, 'password1234', FAST.hashParams)).rejects.toThrow(/common/);
  });

  it('revokeSessions rotates only the sessionSecret', async () => {
    await setPassword(dir, STRONG, FAST.hashParams);
    const before = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    await revokeSessions(dir);
    const after = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.sessionSecret).not.toBe(before.sessionSecret);
    expect(Buffer.from(after.sessionSecret, 'base64')).toHaveLength(32);
    expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
  });

  it('revokeSessions fails clearly when there is nothing to revoke', async () => {
    await expect(revokeSessions(dir)).rejects.toThrow(/config\.json/);
  });
});

describe('hot reload', () => {
  it('a new password changes the key, drops the old password and notifies listeners once', async () => {
    const c = await loadConfig(env(), opts());
    const oldKey = c.sessionKey;
    const oldPw = c.generatedPassword!;
    let fired = 0;
    c.onKeyChange(() => { fired++; });
    expect(await c.reload()).toBe(false); // nothing changed yet
    await setPassword(dir, STRONG, FAST.hashParams);
    expect(await c.reload()).toBe(true);
    expect(fired).toBe(1);
    expect(c.sessionKey.equals(oldKey)).toBe(false);
    expect(await c.verifyPassword(STRONG)).toBe(true);
    expect(await c.verifyPassword(oldPw)).toBe(false);
    expect(await c.reload()).toBe(false);
    expect(fired).toBe(1);
  });

  it('revoke-sessions changes the key but keeps the password', async () => {
    const c = await loadConfig(env(), opts());
    const oldKey = c.sessionKey;
    let fired = 0;
    c.onKeyChange(() => { fired++; });
    await revokeSessions(dir);
    expect(await c.reload()).toBe(true);
    expect(fired).toBe(1);
    expect(c.sessionKey.equals(oldKey)).toBe(false);
    expect(await c.verifyPassword(c.generatedPassword!)).toBe(true);
  });

  it('with PETCAM_PASSWORD, a new stored hash is ignored but revoke-sessions still rotates the key', async () => {
    const c = await loadConfig(env({ PETCAM_PASSWORD: 'test-password-123' }), opts());
    const key = c.sessionKey;
    await setPassword(dir, STRONG, FAST.hashParams);
    expect(await c.reload()).toBe(false);
    expect(c.sessionKey.equals(key)).toBe(true);
    expect(await c.verifyPassword('test-password-123')).toBe(true);
    await revokeSessions(dir);
    expect(await c.reload()).toBe(true);
    expect(await c.verifyPassword('test-password-123')).toBe(true);
  });

  it('keeps the old config and logs an error when the file becomes invalid or vanishes', async () => {
    const c = await loadConfig(env(), opts());
    const key = c.sessionKey;
    const pw = c.generatedPassword!;
    let fired = 0;
    c.onKeyChange(() => { fired++; });
    await writeFile(join(dir, 'config.json'), '{broken');
    expect(await c.reload()).toBe(false);
    await rm(join(dir, 'config.json'));
    expect(await c.reload()).toBe(false);
    expect(fired).toBe(0);
    expect(c.sessionKey.equals(key)).toBe(true);
    expect(await c.verifyPassword(pw)).toBe(true);
    expect(logs.filter(([l]) => l === 'error')).toHaveLength(2);
  });

  it('unsubscribed listeners are not called', async () => {
    const c = await loadConfig(env(), opts());
    let fired = 0;
    const off = c.onKeyChange(() => { fired++; });
    off();
    await revokeSessions(dir);
    await c.reload();
    expect(fired).toBe(0);
  });

  it('the file watcher picks up a change without an explicit reload, and stops when asked', async () => {
    const c = await loadConfig(env(), opts({ watchIntervalMs: 30 }));
    let fired = 0;
    c.onKeyChange(() => { fired++; });
    c.startWatching();
    await revokeSessions(dir);
    await until(() => fired === 1);
    c.stopWatching();
    await revokeSessions(dir);
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(1);
  });
});
