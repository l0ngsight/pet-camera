// Startup banner text (pure, so it can be tested).
export interface BannerInput {
  port: number;
  host: string;
  ips: string[];
  /** Leaf certificate fingerprint; only shown when there is no local CA (user-supplied certificate). */
  fingerprint256: string;
  ca: { name: string; fingerprint256: string } | undefined;
  generatedPassword: string | undefined;
  dataDir: string;
}

/** 4 lines of 8 colon-separated bytes: easy to compare with what Android shows for an installed CA. */
export function formatFingerprint(fingerprint: string): string[] {
  const bytes = fingerprint.split(':');
  if (bytes.length !== 32) return [fingerprint];
  return [0, 8, 16, 24].map((i) => bytes.slice(i, i + 8).join(':'));
}

export function formatBanner(i: BannerInput): string {
  const allInterfaces = i.host === '0.0.0.0' || i.host === '::';
  const bases = allInterfaces ? i.ips.map((ip) => `https://${ip}:${i.port}`) : [`https://${i.host}:${i.port}`];
  const lines = [
    '',
    '  PetCam is running.',
    '',
    `  On the laptop (camera):   https://localhost:${i.port}/station`,
    '  On the phone (viewer):',
    ...bases.map((b) => `    ${b}/`),
    '',
  ];
  if (i.ca) {
    lines.push(
      '  One-time setup on the phone: install the PetCam CA so Chrome trusts this server.',
      ...bases.map((b) => `    ${b}/ca.crt`),
      `  CA name: ${i.ca.name}`,
      '  CA SHA-256 fingerprint (must match exactly what your phone shows after installing;',
      '  if it differs, remove the certificate and do not continue):',
      ...formatFingerprint(i.ca.fingerprint256).map((l) => `    ${l}`),
      '  After installing it you should never see a certificate warning. If you do, do not proceed.',
    );
  } else {
    lines.push(`  Certificate SHA-256: ${i.fingerprint256}`);
  }
  if (i.generatedPassword) {
    lines.push(
      '',
      '  ============================================================',
      `   First run: your password is   ${i.generatedPassword}`,
      '   It is shown only once. Change it with: npm run set-password',
      '  ============================================================',
    );
  }
  lines.push('');
  return lines.join('\n');
}
