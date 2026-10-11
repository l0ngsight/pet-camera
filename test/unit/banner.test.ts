import { describe, expect, it } from 'vitest';
import { formatBanner, formatFingerprint } from '../../src/server/banner';

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 1).toString(16).padStart(2, '0').toUpperCase()).join(':');
const base = {
  port: 8443,
  host: '0.0.0.0',
  ips: ['192.168.1.20', '10.8.0.2'],
  fingerprint256: 'AA:BB',
  ca: { name: 'PetCam Local CA (laptop)', fingerprint256: FP },
  generatedPassword: undefined,
  dataDir: '/d',
};

describe('formatFingerprint', () => {
  it('splits a SHA-256 fingerprint into 4 lines of 8 colon-separated bytes', () => {
    const lines = formatFingerprint(FP);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l).toMatch(/^([0-9A-F]{2}:){7}[0-9A-F]{2}$/);
    expect(lines.join(':')).toBe(FP);
  });
  it('returns odd input as a single line instead of failing', () => {
    expect(formatFingerprint('unknown')).toEqual(['unknown']);
  });
});

describe('formatBanner', () => {
  it('lists the station URL (localhost) and every viewer URL', () => {
    const text = formatBanner(base);
    expect(text).toContain('https://localhost:8443/station');
    expect(text).toContain('https://192.168.1.20:8443/');
    expect(text).toContain('https://10.8.0.2:8443/');
    expect(text).not.toContain('password');
  });

  it('shows the CA install URL, name and the fingerprint on 4 lines, with the mandatory-check warning', () => {
    const text = formatBanner(base);
    expect(text).toContain('https://192.168.1.20:8443/ca.crt');
    expect(text).toContain('PetCam Local CA (laptop)');
    for (const l of formatFingerprint(FP)) expect(text).toContain(l);
    expect(text).not.toContain(FP); // never on one line
    expect(text).toMatch(/must match exactly/i);
  });

  it('without a CA (user-supplied certificate) shows no /ca.crt and the leaf fingerprint instead', () => {
    const text = formatBanner({ ...base, ca: undefined });
    expect(text).not.toContain('/ca.crt');
    expect(text).toContain('AA:BB');
  });

  it('prints the generated password when present, and not otherwise', () => {
    expect(formatBanner({ ...base, generatedPassword: 'Abcdefgh23456789' })).toContain('Abcdefgh23456789');
    expect(formatBanner({ ...base, generatedPassword: 'Abcdefgh23456789' })).toContain('npm run set-password');
  });

  it('shows only the bound host when not listening on all interfaces', () => {
    const text = formatBanner({ ...base, host: '127.0.0.1' });
    expect(text).toContain('https://127.0.0.1:8443/');
    expect(text).not.toContain('192.168.1.20');
  });
});
