// `npm run set-password` and `npm run revoke-sessions` (--revoke-sessions): terminal wiring around cli.ts.
import { choosePassword, runCli } from './cli';
import { createHiddenPrompter, readTwoLinesFromStdin } from './prompt';

async function readPasswords(): Promise<[string, string]> {
  if (!process.stdin.isTTY) return readTwoLinesFromStdin();
  const prompter = createHiddenPrompter();
  try {
    const pw = await choosePassword(prompter.ask, console.log);
    return [pw, pw]; // choosePassword already confirmed it
  } finally {
    prompter.close();
  }
}

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  readPasswords,
  print: console.log,
  printError: console.error,
});
