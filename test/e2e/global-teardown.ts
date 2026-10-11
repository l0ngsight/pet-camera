import { rm } from 'node:fs/promises';
import type { FullConfig } from '@playwright/test';

export default async function globalTeardown(config: FullConfig): Promise<void> {
  const webServers = config.webServer ? [config.webServer].flat() : [];
  const dataDir = webServers
    .map((server) => server.env?.PETCAM_DATA_DIR)
    .find((value): value is string => Boolean(value))
    ?? process.env.PETCAM_E2E_DATA_DIR;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
