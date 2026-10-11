// Bundles server (node, ESM) and client (browser) code into dist/. See docs/ARCHITECTURE.md §4.
import { build, context } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const root = new URL('..', import.meta.url).pathname;
const p = (...parts) => join(root, ...parts);

const serverEntries = ['main', 'set-password'].map((n) => p('src/server', `${n}.ts`)).filter(existsSync);
const clientEntries = ['login', 'viewer', 'station'].map((n) => p('src/client', `${n}.ts`)).filter(existsSync);

const serverOpts = {
  entryPoints: serverEntries,
  outdir: p('dist/server'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};

const clientOpts = {
  entryPoints: clientEntries,
  outdir: p('dist/public/assets'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
};

/** HTML -> dist/public/pages, CSS -> dist/public/assets (served from the in-memory manifest). */
async function copyStatic() {
  await mkdir(p('dist/public/pages'), { recursive: true });
  await mkdir(p('dist/public/assets'), { recursive: true });
  if (existsSync(p('src/client/pages'))) {
    for (const f of await readdir(p('src/client/pages'))) {
      if (f.endsWith('.html')) await cp(p('src/client/pages', f), p('dist/public/pages', f));
    }
  }
  if (existsSync(p('src/client/styles.css'))) {
    await cp(p('src/client/styles.css'), p('dist/public/assets/styles.css'));
  }
}

if (!watch) {
  await rm(p('dist'), { recursive: true, force: true });
  if (serverEntries.length) await build(serverOpts);
  if (clientEntries.length) await build(clientOpts);
  await copyStatic();
} else {
  await copyStatic();
  const ctxs = [];
  if (serverEntries.length) ctxs.push(await context(serverOpts));
  if (clientEntries.length) ctxs.push(await context(clientOpts));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching… (restart the server manually; static files are indexed at startup)');
}
