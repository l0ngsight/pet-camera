// Env + data/config.json. Creates the session secret and (when no PETCAM_PASSWORD) the password on first run,
// and hot-reloads config.json so `set-password` / `revoke-sessions` take effect on a running server.
import { randomBytes, randomInt } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_SCRYPT,
  deriveSessionKey,
  hashPassword,
  plainPasswordMatches,
  verifyPasswordHash,
  type ScryptParams,
} from './auth';
import type { Logger } from './log';

export const MIN_PASSWORD_LENGTH = 12;
const GENERATED_PASSWORD_LENGTH = 16;
// No look-alike characters (0/O, 1/l/I): the user types this by hand from the banner.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const DEFAULT_WATCH_INTERVAL_MS = 2000;

// Not a dictionary: just the passwords that satisfy the length rule and are still the first things guessed.
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'password123456', 'passwordpassword', 'passw0rd1234', 'mypassword123', 'mypassword1234',
  '123456789012', '1234567890123', '12345678901234', '123123123123', '111111111111', '000000000000',
  'qwertyuiop12', 'qwertyuiopas', 'qwertyuiopasdf', 'qwertyqwerty', '1q2w3e4r5t6y', 'qazwsxedcrfv', '1qaz2wsx3edc',
  'abcdefghijkl', 'abcdefghijklm', 'iloveyou1234', 'letmein123456', 'welcome12345', 'administrator', 'changeme1234',
  'changeme12345', 'changemechangeme', 'trustno1trustno1', 'petcampetcam', 'petcam123456', 'dragondragon12', 'monkeymonkey12',
]);

/** Why `password` is unacceptable (as a sentence fragment: "<what> <problem>"), or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'is too common';
  if (/^(.{1,4})\1+$/s.test(password)) return 'is just a short pattern repeated';
  return null;
}

export function assertPasswordStrength(password: string, what = 'password'): void {
  const problem = passwordProblem(password);
  if (problem) throw new Error(`${what} ${problem}`);
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
  /** HMAC key for session cookies (see auth.deriveSessionKey). Changes when config.json is reloaded with a new secret or hash. */
  readonly sessionKey: Buffer;
  verifyPassword(candidate: string): Promise<boolean>;
  /** Set only on the run that created the password without a prompt; print it once and never store it. */
  generatedPassword: string | undefined;
  /** Startup warnings to log (e.g. a weak PETCAM_PASSWORD). */
  warnings: string[];
  /** Re-reads config.json. Resolves true if the session key changed (listeners are notified). Keeps the old config on any error. */
  reload(): Promise<boolean>;
  /** Called when a reload changed the session key, i.e. all existing sessions are revoked. Returns an unsubscribe function. */
  onKeyChange(listener: () => void): () => void;
  startWatching(): void;
  stopWatching(): void;
}

export interface LoadOptions {
  hashParams?: ScryptParams;
  cwd?: string;
  log?: Logger;
  /** Interactive first-run prompt (pass only when attached to a TTY). Without it a password is generated and printed once. */
  promptPassword?: () => Promise<string>;
  watchIntervalMs?: number;
}

interface StoredConfig {
  passwordHash?: string;
  sessionSecret: string;
}

function parseStored(raw: string, file: string): StoredConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or delete it (deleting resets the password and all sessions)`);
  }
  const d = data as Partial<StoredConfig> | null;
  const secretOk = typeof d?.sessionSecret === 'string' && Buffer.from(d.sessionSecret, 'base64').length === 32;
  const hashOk = d?.passwordHash === undefined || (typeof d.passwordHash === 'string' && d.passwordHash.startsWith('scrypt$'));
  if (!d || !secretOk || !hashOk) throw new Error(`${file} has an invalid structure (need 32-byte sessionSecret, scrypt passwordHash)`);
  const out: StoredConfig = { sessionSecret: d.sessionSecret! };
  if (d.passwordHash !== undefined) out.passwordHash = d.passwordHash;
  return out;
}

async function readStored(dataDir: string): Promise<StoredConfig | undefined> {
  const file = join(dataDir, 'config.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseStored(raw, file);
}

async function writeStored(dataDir: string, cfg: StoredConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700); // mkdir's mode is ignored when the directory already exists
  const file = join(dataDir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

function generatePassword(): string {
  let out = '';
  for (let i = 0; i < GENERATED_PASSWORD_LENGTH; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 8443;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n > 65535) throw new Error(`PETCAM_PORT must be an integer 0-65535 (got "${value}")`);
  return n;
}

export async function loadConfig(env: NodeJS.ProcessEnv, opts: LoadOptions = {}): Promise<Config> {
  const params = opts.hashParams ?? DEFAULT_SCRYPT;
  const log: Logger = opts.log ?? (() => {});
  const port = parsePort(env['PETCAM_PORT']);
  const host = env['PETCAM_HOST'] || '0.0.0.0';
  const dataDir = resolve(opts.cwd ?? process.cwd(), env['PETCAM_DATA_DIR'] || 'data');
  const plain = env['PETCAM_PASSWORD'] || undefined;
  const warnings: string[] = [];
  if (plain !== undefined) {
    const problem = passwordProblem(plain);
    if (problem) warnings.push(`PETCAM_PASSWORD ${problem}; anyone on your network who can reach this server could guess it`);
  }

  let stored = await readStored(dataDir);
  let generatedPassword: string | undefined;
  let dirty = false;
  if (!stored) {
    stored = { sessionSecret: randomBytes(32).toString('base64') };
    dirty = true;
  }
  if (!plain && !stored.passwordHash) {
    let chosen: string;
    if (opts.promptPassword) {
      chosen = await opts.promptPassword();
      assertPasswordStrength(chosen);
    } else {
      chosen = generatedPassword = generatePassword();
    }
    stored.passwordHash = await hashPassword(chosen, params);
    dirty = true;
  }
  if (dirty) await writeStored(dataDir, stored);

  const keyFor = (s: StoredConfig) => deriveSessionKey(s.sessionSecret, plain ?? s.passwordHash!);
  const state = { hash: stored.passwordHash, key: keyFor(stored) };
  const listeners = new Set<() => void>();
  const file = join(dataDir, 'config.json');
  const interval = opts.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  let onChange: (() => void) | undefined;

  async function reload(): Promise<boolean> {
    let next: StoredConfig | undefined;
    try {
      next = await readStored(dataDir);
      if (!next) throw new Error(`${file} is missing`);
      if (!plain && !next.passwordHash) throw new Error(`${file} has no passwordHash`);
    } catch (err) {
      log('error', 'config reload failed; keeping the previous configuration', { err: (err as Error).message });
      return false;
    }
    state.hash = next.passwordHash;
    const key = keyFor(next);
    if (key.equals(state.key)) return false;
    state.key = key;
    log('info', 'config changed; sessions revoked');
    for (const l of [...listeners]) l();
    return true;
  }

  return {
    port,
    host,
    dataDir,
    tlsCertPath: env['PETCAM_TLS_CERT'] || undefined,
    tlsKeyPath: env['PETCAM_TLS_KEY'] || undefined,
    get sessionKey() {
      return state.key;
    },
    verifyPassword: async (candidate) =>
      plain !== undefined ? plainPasswordMatches(candidate, plain) : state.hash !== undefined && verifyPasswordHash(candidate, state.hash),
    generatedPassword,
    warnings,
    reload,
    onKeyChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    startWatching() {
      if (onChange) return;
      onChange = () => void reload();
      watchFile(file, { interval, persistent: false }, onChange);
    },
    stopWatching() {
      if (!onChange) return;
      unwatchFile(file, onChange);
      onChange = undefined;
    },
  };
}

/** Used by `npm run set-password`. Replacing the hash changes the session key, which revokes every session. */
export async function setPassword(dataDir: string, password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<void> {
  assertPasswordStrength(password);
  const stored = (await readStored(dataDir)) ?? { sessionSecret: randomBytes(32).toString('base64') };
  stored.passwordHash = await hashPassword(password, params);
  await writeStored(dataDir, stored);
}

/** Used by `npm run revoke-sessions`: new sessionSecret, same password. Every issued cookie stops verifying. */
export async function revokeSessions(dataDir: string): Promise<void> {
  const stored = await readStored(dataDir);
  if (!stored) throw new Error(`${join(dataDir, 'config.json')} not found; nothing to revoke`);
  stored.sessionSecret = randomBytes(32).toString('base64');
  await writeStored(dataDir, stored);
}
