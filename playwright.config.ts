import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Pick once in the config process and export the choice so Playwright workers
// that load this file again use the same server port. An explicit override is
// useful when the selected port is already in use by another process.
const port = Number(process.env.PETCAM_E2E_PORT ?? execFileSync(
  process.execPath,
  ['-e', "const net=require('node:net'); const server=net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });"],
  { encoding: 'utf8' },
).trim());
process.env.PETCAM_E2E_PORT = String(port);
// Key the shared path to the shared port so config reloads in Playwright's
// runner and workers all refer to the same directory.
const dataDir = join(tmpdir(), `petcam-playwright-${port}`);
await mkdir(dataDir, { recursive: true });
process.env.PETCAM_E2E_DATA_DIR = dataDir;
const baseURL = `https://127.0.0.1:${port}`;
process.env.PETCAM_TEST_URL = baseURL;
process.env.PETCAM_PASSWORD = 'test-password-123';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalTeardown: './test/e2e/global-teardown.ts',
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'npm run build && node dist/server/main.js',
    url: `${baseURL}/healthz`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PETCAM_PORT: String(port),
      PETCAM_HOST: '127.0.0.1',
      PETCAM_PASSWORD: 'test-password-123',
      PETCAM_DATA_DIR: dataDir,
    },
  },
});
