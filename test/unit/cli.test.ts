import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { choosePassword, runCli } from '../../src/server/cli';
import { loadConfig } from '../../src/server/config';

const FAST = { N: 1024, r: 8, p: 1 };
const STRONG = 'correct horse battery';
let dir: string;
let out: string[];
let err: string[];
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'petcam-cli-')), 'data'); out = []; err = []; });
afterEach(async () => { await rm(join(dir, '..'), { recursive: true, force: true }); });

const run = (argv: string[], passwords: [string, string] | Error, env: Record<string, string> = {}) =>
  runCli({
    argv,
    env: { PETCAM_DATA_DIR: dir, ...env },
    readPasswords: async () => { if (passwords instanceof Error) throw passwords; return passwords; },
    print: (m) => out.push(m),
    printError: (m) => err.push(m),
    hashParams: FAST,
  });

describe('choosePassword (interactive policy loop)', () => {
  const asker = (answers: string[]) => async () => answers.shift() ?? '';
  it('re-asks on a weak password, then asks for confirmation', async () => {
    const msgs: string[] = [];
    const pw = await choosePassword(asker(['short', 'password1234', STRONG, STRONG]), (m) => msgs.push(m));
    expect(pw).toBe(STRONG);
    expect(msgs.join('\n')).toMatch(/at least 12/);
    expect(msgs.join('\n')).toMatch(/common/);
  });
  it('re-asks when the confirmation differs', async () => {
    const msgs: string[] = [];
    expect(await choosePassword(asker([STRONG, 'x', STRONG, STRONG]), (m) => msgs.push(m))).toBe(STRONG);
    expect(msgs.join('\n')).toMatch(/do not match/);
  });
  it('gives up after 3 failed rounds', async () => {
    await expect(choosePassword(asker(['a', 'b', 'c']), () => {})).rejects.toThrow(/too many/i);
  });
});

describe('set-password', () => {
  it('stores a new hash and says the running server picks it up', async () => {
    expect(await run([], [STRONG, STRONG])).toBe(0);
    const c = await loadConfig({ PETCAM_DATA_DIR: dir }, { hashParams: FAST });
    expect(c.generatedPassword).toBeUndefined();
    expect(await c.verifyPassword(STRONG)).toBe(true);
    expect(out.join('\n')).toMatch(/log in again/i);
    expect(out.join('\n')).not.toContain(STRONG);
  });

  it.each([
    ['mismatch', ['aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2'], /do not match/],
    ['too short', ['short', 'short'], /at least 12/],
    ['common', ['password1234', 'password1234'], /common/],
  ] as const)('exits 1 on %s without touching the config', async (_n, pws, msg) => {
    expect(await run([], [...pws] as [string, string])).toBe(1);
    expect(err.join('\n')).toMatch(msg);
    await expect(readFile(join(dir, 'config.json'))).rejects.toThrow();
  });

  it('warns when PETCAM_PASSWORD overrides the stored password', async () => {
    expect(await run([], [STRONG, STRONG], { PETCAM_PASSWORD: 'test-password-123' })).toBe(0);
    expect(err.join('\n') + out.join('\n')).toMatch(/PETCAM_PASSWORD.*overrid/i);
  });
});

describe('set-password --revoke-sessions', () => {
  it('rotates only the session secret', async () => {
    await run([], [STRONG, STRONG]);
    const before = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    out.length = 0;
    expect(await run(['--revoke-sessions'], new Error('must not prompt'))).toBe(0);
    const after = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.sessionSecret).not.toBe(before.sessionSecret);
    expect(out.join('\n')).toMatch(/log in again/i);
  });

  it('exits 1 when there is no config to revoke', async () => {
    expect(await run(['--revoke-sessions'], ['', ''])).toBe(1);
    expect(err.join('\n')).toMatch(/config\.json/);
  });

  it('rejects unknown flags', async () => {
    expect(await run(['--nope'], ['', ''])).toBe(1);
    expect(err.join('\n')).toMatch(/usage/i);
  });
});
