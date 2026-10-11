import { execFileSync } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ipPermitted,
  issueLeaf,
  lanIPv4s,
  leafNeedsReissue,
  loadOrCreateCa,
  loadTls,
  sanEntries,
} from '../../src/server/tls';

const DAY = 86_400_000;
const HOST = 'testhost';
// The CA name carries its creation time (UTC, to the minute), so recreated CAs are distinguishable on a phone.
const STAMP = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC';
const nameRe = (host: string) => new RegExp(`^PetCam Local CA \\(${host.replace(/\./g, '\\.')}, ${STAMP}\\)$`);
/** Parses the timestamp out of a CA name. */
const stampOf = (name: string) => Date.parse(`${/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/.exec(name)!.slice(1).join('T')}:00Z`);
const noop = () => {};
// Every temp directory is registered here and removed in afterAll, even if a test fails half way.
const temps: string[] = [];
const tmp = async (prefix: string) => { const d = await mkdtemp(join(tmpdir(), prefix)); temps.push(d); return d; };
let dir: string;
beforeAll(async () => { dir = await tmp('petcam-tls-'); });
afterAll(async () => { await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const opensslOk = (() => { try { execFileSync('openssl', ['version']); return true; } catch { return false; } })();
const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe('lanIPv4s', () => {
  it('returns non-internal IPv4 addresses only', () => {
    const nets = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      tun0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
      down: undefined,
    } as never;
    expect(lanIPv4s(nets)).toEqual(['192.168.1.20', '10.8.0.2']);
  });
});

describe('ipPermitted (the CA name-constraint ranges)', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255'])('allows %s', (ip) => {
    expect(ipPermitted(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '172.32.0.1', '172.15.255.255', '100.128.0.1', '100.63.255.255', '169.254.1.1', '192.169.0.1', '0.0.0.0', '1.2.3', 'abc', '10.0.0.256', '::1'])(
    'rejects %s', (ip) => { expect(ipPermitted(ip)).toBe(false); });
});

describe('local CA + leaf', () => {
  const ips = ['192.168.1.20', '100.101.102.103'];
  const base = () => ({ dataDir: dir, ips, hostname: HOST, log: noop });
  let first: Awaited<ReturnType<typeof loadTls>>;

  it('creates the CA once and a leaf that it signs, with strict file modes', async () => {
    first = await loadTls(base());
    expect(first.generated).toEqual({ ca: true, leaf: true });
    for (const f of ['ca.pem', 'ca-key.pem', 'cert.pem', 'key.pem']) expect(await mode(join(dir, 'tls', f))).toBe(0o600);
    expect((await stat(join(dir, 'tls'))).mode & 0o777).toBe(0o700);
    expect(first.key).toContain('PRIVATE KEY');
    expect(first.ca?.pem).toBe(await readFile(join(dir, 'tls', 'ca.pem'), 'utf8'));
    expect(first.ca?.pem).not.toContain('PRIVATE KEY');
  });

  it('names the CA after the host and reports its fingerprint', () => {
    const ca = new X509Certificate(first.ca!.pem);
    expect(first.ca!.name).toMatch(nameRe(HOST));
    expect(ca.subject).toContain(`CN=PetCam Local CA (${HOST}\\, `); // Node shows the DN-escaped comma
    expect(Math.abs(Date.now() - stampOf(first.ca!.name))).toBeLessThan(120_000); // the stamp is the creation time
    expect(first.ca!.fingerprint256).toBe(ca.fingerprint256);
    expect(first.ca!.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(first.fingerprint256).toBe(new X509Certificate(first.cert).fingerprint256);
    expect(ca.ca).toBe(true);
    const days = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / DAY;
    expect(days).toBeGreaterThan(3600);
  });

  it('the leaf chains to the CA and covers localhost, <host>.local, 127.0.0.1 and the LAN IPs', () => {
    const leaf = new X509Certificate(first.cert);
    const ca = new X509Certificate(first.ca!.pem);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    const san = sanEntries(leaf);
    for (const want of ['DNS:localhost', `DNS:${HOST}.local`, 'IP:127.0.0.1', 'IP:192.168.1.20', 'IP:100.101.102.103']) expect(san).toContain(want);
    expect(leaf.ca).toBe(false);
    expect(leaf.keyUsage).toEqual(expect.arrayContaining(['1.3.6.1.5.5.7.3.1']));
    const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY;
    expect(days).toBeGreaterThan(396);
    expect(days).toBeLessThan(399);
  });

  it.skipIf(!opensslOk)('openssl accepts the chain and shows ECDSA/SHA-256, CA constraints and critical nameConstraints', () => {
    const t = join(dir, 'tls');
    expect(openssl(['verify', '-CAfile', join(t, 'ca.pem'), join(t, 'cert.pem')])).toContain('OK');
    const caText = openssl(['x509', '-noout', '-text', '-in', join(t, 'ca.pem')]);
    expect(caText).toMatch(/CA:TRUE, pathlen:0/);
    expect(caText).toMatch(/X509v3 Name Constraints: critical/);
    for (const permitted of ['DNS:localhost', 'DNS:local', 'IP:127.0.0.0/255.0.0.0', 'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0',
      'IP:192.168.0.0/255.255.0.0', 'IP:100.64.0.0/255.192.0.0']) {
      expect(caText).toContain(permitted);
    }
    const leafText = openssl(['x509', '-noout', '-text', '-in', join(t, 'cert.pem')]);
    expect(leafText).toMatch(/Signature Algorithm: ecdsa-with-SHA256/);
    expect(leafText).toMatch(/CA:FALSE/);
    expect(leafText).toMatch(/TLS Web Server Authentication/);
  });

  it.skipIf(!opensslOk)('the CN value itself (what a phone displays) has an unescaped comma and a single CN', () => {
    const out = openssl(['x509', '-noout', '-subject', '-nameopt', 'multiline,utf8', '-in', join(dir, 'tls', 'ca.pem')]);
    expect(out).toMatch(new RegExp(`commonName\\s*=\\s*PetCam Local CA \\(${HOST}, ${STAMP}\\)\\s*$`, 'm'));
    expect(out.match(/commonName/g)).toHaveLength(1);
  });

  it('reuses everything on the next start when nothing changed', async () => {
    const again = await loadTls(base());
    expect(again.generated).toEqual({ ca: false, leaf: false });
    expect(again.fingerprint256).toBe(first.fingerprint256);
    expect(again.ca!.fingerprint256).toBe(first.ca!.fingerprint256);
  });

  it('reissues only the leaf when an eligible IP appears, keeping the CA', async () => {
    const again = await loadTls({ ...base(), ips: [...ips, '10.8.0.2'] });
    expect(again.generated).toEqual({ ca: false, leaf: true });
    expect(again.ca!.fingerprint256).toBe(first.ca!.fingerprint256);
    expect(again.fingerprint256).not.toBe(first.fingerprint256);
    expect(sanEntries(new X509Certificate(again.cert))).toContain('IP:10.8.0.2');
    expect(new X509Certificate(again.cert).serialNumber).not.toBe(new X509Certificate(first.cert).serialNumber);
    first = again;
  });

  it('does not reissue when an IP merely disappears', async () => {
    const again = await loadTls({ ...base(), ips: ['10.8.0.2'] });
    expect(again.generated.leaf).toBe(false);
  });

  it('skips and reports IPs outside the CA constraints instead of breaking the chain', async () => {
    const logs: string[] = [];
    const t = await loadTls({ ...base(), ips: ['10.8.0.2', '8.8.8.8', '169.254.3.4'], log: (_l, m) => { logs.push(m); } });
    expect(t.skippedIps).toEqual(['8.8.8.8', '169.254.3.4']);
    expect(t.generated.leaf).toBe(false); // skipped IPs never trigger a reissue
    expect(sanEntries(new X509Certificate(t.cert))).not.toContain('IP:8.8.8.8');
    expect(logs.join()).toMatch(/outside|constraint|skipp/i);
  });

  it('reissues when the leaf is unparsable or the leaf key does not match', async () => {
    await writeFile(join(dir, 'tls', 'cert.pem'), 'garbage');
    const a = await loadTls({ ...base(), ips: ['10.8.0.2'] });
    expect(a.generated).toEqual({ ca: false, leaf: true });
    const b = await readFile(join(dir, 'tls', 'key.pem'), 'utf8');
    await unlink(join(dir, 'tls', 'key.pem'));
    const c = await loadTls({ ...base(), ips: ['10.8.0.2'] });
    expect(c.generated.leaf).toBe(true);
    expect(c.key).not.toBe(b);
  });

  it('creates a new CA (and so a new leaf) if the CA key is missing', async () => {
    const before = (await loadTls({ ...base(), ips: ['10.8.0.2'] })).ca!.fingerprint256;
    await unlink(join(dir, 'tls', 'ca-key.pem'));
    const logs: string[] = [];
    const t = await loadTls({ ...base(), ips: ['10.8.0.2'], log: (l, m) => { logs.push(`${l}:${m}`); } });
    expect(t.generated).toEqual({ ca: true, leaf: true });
    expect(t.ca!.fingerprint256).not.toBe(before);
    expect(logs.join()).toMatch(/warn/);
    expect(new X509Certificate(t.cert).verify(new X509Certificate(t.ca!.pem).publicKey)).toBe(true);
  });
});

describe('CA recreation', () => {
  it('keeps the same name (and so timestamp) when the CA is reloaded, and dates a recreated CA anew', async () => {
    const d = await tmp('petcam-tls-r-');
    try {
      const a = await loadTls({ dataDir: d, ips: [], hostname: HOST, log: noop });
      const b = await loadTls({ dataDir: d, ips: [], hostname: HOST, log: noop });
      expect(b.ca!.name).toBe(a.ca!.name);
      expect(b.generated.ca).toBe(false);
    } finally { await rm(d, { recursive: true, force: true }); }
  });

  it('recreates the CA when ca-key.pem is a valid key that belongs to a different CA, overwriting both files with 0600', async () => {
    const d1 = await tmp('petcam-tls-m1-');
    const d2 = await tmp('petcam-tls-m2-');
    try {
      const a = await loadTls({ dataDir: d1, ips: [], hostname: HOST, log: noop });
      await loadTls({ dataDir: d2, ips: [], hostname: HOST, log: noop });
      // a perfectly valid private key, but not the one for d1's CA certificate
      await writeFile(join(d1, 'tls', 'ca-key.pem'), await readFile(join(d2, 'tls', 'ca-key.pem')));
      const logs: string[] = [];
      const t = await loadTls({ dataDir: d1, ips: [], hostname: HOST, log: (l, m) => { logs.push(`${l}:${m}`); } });
      expect(t.generated).toEqual({ ca: true, leaf: true });
      expect(t.ca!.fingerprint256).not.toBe(a.ca!.fingerprint256);
      expect(logs.join()).toMatch(/warn.*(incomplete|unusable|mismatch)/);
      expect(await readFile(join(d1, 'tls', 'ca.pem'), 'utf8')).toBe(t.ca!.pem);
      expect(await mode(join(d1, 'tls', 'ca.pem'))).toBe(0o600);
      expect(await mode(join(d1, 'tls', 'ca-key.pem'))).toBe(0o600);
      // the new key matches the new certificate
      const key = await readFile(join(d1, 'tls', 'ca-key.pem'), 'utf8');
      expect(new X509Certificate(t.ca!.pem).checkPrivateKey(createPrivateKey(key))).toBe(true);
    } finally {
      await rm(d1, { recursive: true, force: true });
      await rm(d2, { recursive: true, force: true });
    }
  });
});

describe('leafNeedsReissue', () => {
  it('decides on expiry, SAN coverage, issuer and key match', async () => {
    const d = await tmp('petcam-tls-d-');
    try {
      const t = await loadTls({ dataDir: d, ips: ['192.168.1.20'], hostname: HOST, log: noop });
      const args = (over: Partial<Parameters<typeof leafNeedsReissue>[0]> = {}) => ({
        leafPem: t.cert, keyPem: t.key, caPem: t.ca!.pem, ips: ['192.168.1.20'], hostname: HOST, nowMs: Date.now(), ...over,
      });
      expect(leafNeedsReissue(args())).toBeNull();
      expect(leafNeedsReissue(args({ nowMs: Date.now() + 370 * DAY }))).toMatch(/expir/);
      expect(leafNeedsReissue(args({ ips: ['192.168.1.20', '10.1.1.1'] }))).toMatch(/10\.1\.1\.1/);
      expect(leafNeedsReissue(args({ hostname: 'other' }))).toMatch(/other\.local/);
      expect(leafNeedsReissue(args({ leafPem: undefined }))).toMatch(/missing/);
      expect(leafNeedsReissue(args({ keyPem: undefined }))).toMatch(/key/);
      const otherCa = await loadTls({ dataDir: await tmp('petcam-tls-e-'), ips: [], hostname: HOST, log: noop });
      expect(leafNeedsReissue(args({ caPem: otherCa.ca!.pem }))).toMatch(/issued/);
    } finally { await rm(d, { recursive: true, force: true }); }
  });
});

describe.skipIf(!opensslOk)('CA name constraints bind the CA key', () => {
  it('a leaf for a public name or public IP does not verify, while a private one does', async () => {
    const d = await tmp('petcam-tls-nc-');
    try {
      const ca = await loadOrCreateCa(d, HOST, noop);
      const caFile = join(d, 'ca.pem');
      await writeFile(caFile, ca.pem);
      const verify = async (sans: Parameters<typeof issueLeaf>[1]) => {
        const leaf = await issueLeaf(ca, sans);
        const f = join(d, 'leaf.pem');
        await writeFile(f, leaf.certPem);
        try { openssl(['verify', '-CAfile', caFile, f]); return true; } catch { return false; }
      };
      expect(await verify([{ type: 'dns', value: 'localhost' }, { type: 'ip', value: '192.168.1.5' }, { type: 'dns', value: 'pc.local' }])).toBe(true);
      expect(await verify([{ type: 'dns', value: 'www.google.com' }])).toBe(false);
      expect(await verify([{ type: 'ip', value: '8.8.8.8' }])).toBe(false);
      expect(await verify([{ type: 'dns', value: 'evil.com' }, { type: 'ip', value: '10.0.0.1' }])).toBe(false);
    } finally { await rm(d, { recursive: true, force: true }); }
  });
});

describe('user-supplied certificate', () => {
  it('uses the supplied files untouched, has no CA, and never writes into data/tls', async () => {
    const d2 = await tmp('petcam-tls2-');
    try {
      await writeFile(join(d2, 'c.pem'), 'CERT');
      await writeFile(join(d2, 'k.pem'), 'KEY');
      const r = await loadTls({ dataDir: d2, ips: [], hostname: HOST, log: noop, certPath: join(d2, 'c.pem'), keyPath: join(d2, 'k.pem') });
      expect(r).toMatchObject({ cert: 'CERT', key: 'KEY', generated: { ca: false, leaf: false } });
      expect(r.ca).toBeUndefined();
      await expect(stat(join(d2, 'tls'))).rejects.toThrow();
    } finally { await rm(d2, { recursive: true, force: true }); }
  });

  it('fails clearly when only one of cert/key is given or unreadable', async () => {
    await expect(loadTls({ dataDir: dir, ips: [], hostname: HOST, log: noop, certPath: '/x' })).rejects.toThrow(/both/i);
    await expect(loadTls({ dataDir: dir, ips: [], hostname: HOST, log: noop, certPath: '/nope/c', keyPath: '/nope/k' })).rejects.toThrow(/PETCAM_TLS_CERT/);
  });
});

describe('hostnames', () => {
  it('uses the hostname as is when it already ends in .local, and sanitises odd characters in the CA name', async () => {
    const d = await tmp('petcam-tls-h-');
    try {
      const t = await loadTls({ dataDir: d, ips: [], hostname: 'my box,x=y.local', log: noop });
      expect(t.ca!.name).toMatch(nameRe('my-box-x-y.local'));
      expect(sanEntries(new X509Certificate(t.cert))).toContain('DNS:my-box-x-y.local');
    } finally { await rm(d, { recursive: true, force: true }); }
  });
});
