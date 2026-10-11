// Terminal prompts that don't echo what is typed. Only used when stdin and stdout are a TTY.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function createHiddenPrompter() {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return {
    ask: (question: string) =>
      new Promise<string>((resolve) => {
        process.stdout.write(question);
        muted = true;
        rl.question('', (answer) => {
          muted = false;
          process.stdout.write('\n');
          resolve(answer);
        });
      }),
    close: () => rl.close(),
  };
}

/** Reads two lines (password, confirmation) from piped stdin, for scripts. */
export async function readTwoLinesFromStdin(): Promise<[string, string]> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const [a = '', b = a] = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return [a, b];
}
