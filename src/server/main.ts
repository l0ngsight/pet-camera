// Entry point: `npm start`. Loads config + TLS, starts the server, prints the banner, shuts down gracefully.
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { formatBanner } from './banner';
import { choosePassword } from './cli';
import { loadConfig } from './config';
import { createLogger } from './log';
import { createHiddenPrompter } from './prompt';
import { createPetcamServer } from './server';
import { lanIPv4s, loadTls } from './tls';

const log = createLogger();

/** First run on a terminal: let the user choose the password instead of printing a generated one. */
async function promptFirstPassword(): Promise<string> {
  console.log('\n  First run: choose the password for PetCam.\n');
  const prompter = createHiddenPrompter();
  try {
    return await choosePassword(prompter.ask, console.log);
  } finally {
    prompter.close();
  }
}

async function main(): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const config = await loadConfig(process.env, { log, ...(interactive && { promptPassword: promptFirstPassword }) });
  for (const w of config.warnings) log('warn', w);

  const ips = lanIPv4s();
  const tls = await loadTls({
    dataDir: config.dataDir,
    ips,
    hostname: hostname(),
    log,
    certPath: config.tlsCertPath,
    keyPath: config.tlsKeyPath,
  });

  const server = createPetcamServer({
    config,
    tls,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    log,
  });
  const addr = await server.start();
  log('info', 'listening', { host: config.host, port: addr.port });
  console.log(
    formatBanner({
      port: addr.port,
      host: config.host,
      ips,
      fingerprint256: tls.fingerprint256,
      ca: tls.ca && { name: tls.ca.name, fingerprint256: tls.ca.fingerprint256 },
      generatedPassword: config.generatedPassword,
      dataDir: config.dataDir,
    }),
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });
    server.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log('error', 'shutdown failed', { err: String(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') log('error', 'port already in use; set PETCAM_PORT to another port', { err: e.message });
  else log('error', 'startup failed', { err: e.message });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log('error', 'unhandled rejection', { err: String(err) });
  process.exit(1);
});
