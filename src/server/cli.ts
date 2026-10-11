// Logic of `npm run set-password` / `npm run revoke-sessions`, separated from terminal I/O so it can be tested.
import { resolve } from 'node:path';
import type { ScryptParams } from './auth';
import { assertPasswordStrength, passwordProblem, revokeSessions, setPassword } from './config';

const LOG_IN_AGAIN = 'The running server reloads this within a few seconds and signs everyone out; the station tab on this laptop must log in again.';
const MAX_ROUNDS = 3;

/** Interactive loop: ask, check the policy, ask for confirmation. `ask` must not echo. */
export async function choosePassword(ask: (question: string) => Promise<string>, say: (msg: string) => void): Promise<string> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const first = await ask('New password (at least 12 characters): ');
    const problem = passwordProblem(first);
    if (problem) {
      say(`That password ${problem}.`);
      continue;
    }
    if ((await ask('Repeat password: ')) !== first) {
      say('The passwords do not match.');
      continue;
    }
    return first;
  }
  throw new Error('too many attempts');
}

export interface CliDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Returns the password and its confirmation (two prompts on a TTY, two lines on piped stdin). */
  readPasswords: () => Promise<[string, string]>;
  print: (msg: string) => void;
  printError: (msg: string) => void;
  hashParams?: ScryptParams;
}

/** Returns the process exit code. */
export async function runCli(d: CliDeps): Promise<number> {
  const flags = d.argv.filter((a) => a.startsWith('-'));
  const revoke = flags.includes('--revoke-sessions');
  if (flags.some((f) => f !== '--revoke-sessions') || d.argv.length !== flags.length) {
    d.printError('usage: set-password [--revoke-sessions]');
    return 1;
  }
  const dataDir = resolve(d.env['PETCAM_DATA_DIR'] || 'data');
  try {
    if (revoke) {
      await revokeSessions(dataDir);
      d.print(`Session secret rotated in ${dataDir}/config.json. ${LOG_IN_AGAIN}`);
    } else {
      const [first, second] = await d.readPasswords();
      if (first !== second) throw new Error('the passwords do not match');
      assertPasswordStrength(first);
      await setPassword(dataDir, first, d.hashParams);
      d.print(`Password updated in ${dataDir}/config.json. ${LOG_IN_AGAIN}`);
    }
    if (d.env['PETCAM_PASSWORD']) {
      d.printError('Note: PETCAM_PASSWORD is set and overrides the stored password; unset it for this change to apply to logins.');
    }
    return 0;
  } catch (err) {
    d.printError(`${revoke ? 'revoke-sessions' : 'set-password'} failed: ${(err as Error).message}`);
    return 1;
  }
}
