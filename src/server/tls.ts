// TLS material: a user-supplied cert, or a persistent name-constrained local CA that signs a short-lived leaf.
// Reference: docs/spikes/local-ca.cjs. Only the leaf is reissued when the LAN IPs change, so the phone's trust in the CA survives.
import { AsnConvert } from '@peculiar/asn1-schema';
import * as asn from '@peculiar/asn1-x509';
import * as x509 from '@peculiar/x509';
import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Logger } from './log';

x509.cryptoProvider.set(webcrypto as never);

type Key = webcrypto.CryptoKey;
type KeyPair = webcrypto.CryptoKeyPair;

const DAY_MS = 86_400_000;
const RENEW_BEFORE_MS = 30 * DAY_MS;
const LEAF_VALIDITY_DAYS = 397;
const CA_VALIDITY_DAYS = 3650;
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/** The only IPv4 ranges the CA may certify (also encoded as critical nameConstraints in the CA cert). */
const PERMITTED_CIDRS = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10], // CGNAT, e.g. Tailscale
] as const;

export interface TlsMaterial {
  /** Leaf certificate PEM (what the HTTPS server presents). */
  cert: string;
  key: string;
  /** SHA-256 fingerprint of the leaf, uppercase colon-hex. */
  fingerprint256: string;
  /** Which parts were (re)generated on this start. */
  generated: { ca: boolean; leaf: boolean };
  /** Public part of the local CA, for `GET /ca.crt` and the banner. Absent for a user-supplied cert. */
  ca?: { pem: string; fingerprint256: string; name: string };
  /** LAN IPs left out of the SAN because the CA's name constraints don't permit them. */
  skippedIps: string[];
}

export interface TlsOptions {
  dataDir: string;
  /** Non-internal IPv4 addresses of this machine. */
  ips: string[];
  /** os.hostname(); the leaf gets `<hostname>.local`. */
  hostname: string;
  log: Logger;
  certPath?: string | undefined;
  keyPath?: string | undefined;
}

export function lanIPv4s(nets: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function parseIPv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

export function ipPermitted(ip: string): boolean {
  const n = parseIPv4(ip);
  if (n === null) return false;
  return PERMITTED_CIDRS.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (parseIPv4(base)! & mask) >>> 0;
  });
}

/** SAN as `DNS:name` / `IP:addr` strings (DNS lower-cased). */
export function sanEntries(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^IP Address:/, 'IP:'))
    .map((s) => (s.startsWith('DNS:') ? `DNS:${s.slice(4).toLowerCase()}` : s));
}

/** Hostnames end up in a certificate DN and a DNS SAN, so keep them to [A-Za-z0-9.-]. */
function cleanHostname(hostname: string): string {
  return hostname.replace(/[^A-Za-z0-9.-]/g, '-') || 'petcam';
}

function leafDnsName(hostname: string): string {
  const h = cleanHostname(hostname);
  return h.toLowerCase().endsWith('.local') ? h : `${h}.local`;
}

// ---- file helpers ----

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function ensureTlsDir(dataDir: string): Promise<string> {
  const dir = join(dataDir, 'tls');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

// ---- crypto helpers ----

function pemOf(der: ArrayBuffer, label: string): string {
  return x509.PemConverter.encode(der, label);
}

async function exportKeyPem(key: Key): Promise<string> {
  return pemOf(await webcrypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY');
}

async function importKeyPem(pem: string): Promise<Key> {
  const der = createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' });
  return webcrypto.subtle.importKey('pkcs8', der, ALG, true, ['sign']);
}

function randomSerial(): string {
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f; // positive ASN.1 integer
  return b.toString('hex');
}

export interface Ca {
  cert: x509.X509Certificate;
  key: Key;
  pem: string;
  name: string;
  created: boolean;
}

function caUsable(certPem: string, keyPem: string, nowMs: number): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.checkPrivateKey(createPrivateKey(keyPem)) && Date.parse(cert.validTo) > nowMs;
  } catch {
    return false;
  }
}

async function createCa(hostname: string): Promise<{ cert: x509.X509Certificate; key: Key }> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as KeyPair;
  const subtree = (base: asn.GeneralName) => new asn.GeneralSubtree({ base });
  const permitted = [
    subtree(new asn.GeneralName({ dNSName: 'localhost' })),
    subtree(new asn.GeneralName({ dNSName: 'local' })), // matches *.local
    ...PERMITTED_CIDRS.map(([base, bits]) => subtree(new asn.GeneralName({ iPAddress: `${base}/${bits}` }))),
  ];
  const nameConstraints = new asn.NameConstraints({ permittedSubtrees: new asn.GeneralSubtrees(permitted) });
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    // The creation time (UTC, to the minute) tells apart CA generations on the phone after a recreation;
    // the comma must be escaped in a DN string.
    name: `CN=PetCam Local CA (${cleanHostname(hostname)}\\, ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + CA_VALIDITY_DAYS * DAY_MS),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      new x509.Extension('2.5.29.30', true, AsnConvert.serialize(nameConstraints)),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { cert, key: keys.privateKey };
}

/** Loads data/tls/ca{,-key}.pem, or creates a new CA if either is missing, unreadable, mismatched or expired. */
export async function loadOrCreateCa(dataDir: string, hostname: string, log: Logger): Promise<Ca> {
  const dir = await ensureTlsDir(dataDir);
  const caFile = join(dir, 'ca.pem');
  const keyFile = join(dir, 'ca-key.pem');
  const [certPem, keyPem] = await Promise.all([readIfExists(caFile), readIfExists(keyFile)]);

  if (certPem && keyPem && caUsable(certPem, keyPem, Date.now())) {
    const cert = new x509.X509Certificate(certPem);
    return { cert, key: await importKeyPem(keyPem), pem: certPem, name: cert.subjectName.getField('CN')[0] ?? cert.subject, created: false };
  }
  if (certPem || keyPem) {
    log('warn', 'local CA is incomplete or unusable; creating a new one (phones must install it again)');
  }
  const fresh = await createCa(hostname);
  const pem = fresh.cert.toString('pem');
  await writeAtomic(keyFile, await exportKeyPem(fresh.key));
  await writeAtomic(caFile, pem);
  log('info', 'created local CA', { name: fresh.cert.subjectName.getField('CN')[0] });
  return { cert: fresh.cert, key: fresh.key, pem, name: fresh.cert.subjectName.getField('CN')[0] ?? fresh.cert.subject, created: true };
}

export type San = { type: 'dns' | 'ip'; value: string };

/** Signs a new leaf (new key, random serial) with the CA. Exported for tests of the name constraints. */
export async function issueLeaf(ca: Pick<Ca, 'cert' | 'key'>, sans: San[]): Promise<{ certPem: string; keyPem: string }> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as KeyPair;
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: 'CN=petcam',
    issuer: ca.cert.subject,
    notBefore: new Date(now - DAY_MS), // tolerate phone clock skew
    notAfter: new Date(now + LEAF_VALIDITY_DAYS * DAY_MS),
    signingKey: ca.key,
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(sans),
      await x509.AuthorityKeyIdentifierExtension.create(ca.cert),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await exportKeyPem(keys.privateKey) };
}

export interface ReissueCheck {
  leafPem: string | undefined;
  keyPem: string | undefined;
  caPem: string;
  /** Only IPs the CA permits. */
  ips: string[];
  hostname: string;
  nowMs: number;
}

/** Returns why the leaf must be reissued, or null when it is still fit for purpose. */
export function leafNeedsReissue(c: ReissueCheck): string | null {
  if (!c.leafPem) return 'leaf certificate missing';
  if (!c.keyPem) return 'leaf private key missing';
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(c.leafPem);
    if (!leaf.checkPrivateKey(createPrivateKey(c.keyPem))) return 'leaf key does not match certificate';
    if (!leaf.verify(new X509Certificate(c.caPem).publicKey)) return 'leaf not issued by the current CA';
  } catch {
    return 'leaf certificate unreadable';
  }
  if (Date.parse(leaf.validTo) - c.nowMs < RENEW_BEFORE_MS) return 'leaf expires within 30 days';
  const have = new Set(sanEntries(leaf));
  const wanted = ['DNS:localhost', `DNS:${leafDnsName(c.hostname).toLowerCase()}`, 'IP:127.0.0.1', ...c.ips.map((i) => `IP:${i}`)];
  const missing = wanted.find((w) => !have.has(w));
  return missing ? `SAN is missing ${missing.replace(/^(DNS|IP):/, '')}` : null;
}

function fingerprintOf(pem: string): string {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return 'unknown';
  }
}

export async function loadTls(opts: TlsOptions): Promise<TlsMaterial> {
  if (Boolean(opts.certPath) !== Boolean(opts.keyPath)) {
    throw new Error('PETCAM_TLS_CERT and PETCAM_TLS_KEY must both be set (or both unset)');
  }

  if (opts.certPath && opts.keyPath) {
    let cert: string;
    let key: string;
    try {
      [cert, key] = await Promise.all([readFile(opts.certPath, 'utf8'), readFile(opts.keyPath, 'utf8')]);
    } catch (err) {
      throw new Error(`cannot read PETCAM_TLS_CERT / PETCAM_TLS_KEY: ${(err as Error).message}`);
    }
    return { cert, key, fingerprint256: fingerprintOf(cert), generated: { ca: false, leaf: false }, skippedIps: [] };
  }

  const ca = await loadOrCreateCa(opts.dataDir, opts.hostname, opts.log);
  const ips = opts.ips.filter(ipPermitted);
  const skippedIps = opts.ips.filter((ip) => !ipPermitted(ip));
  if (skippedIps.length) {
    opts.log('warn', 'LAN addresses outside the CA name constraints are skipped (the certificate will not cover them)', { skippedIps });
  }

  const dir = join(opts.dataDir, 'tls');
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  const [leafPem, keyPem] = await Promise.all([readIfExists(certFile), readIfExists(keyFile)]);
  const reason = leafNeedsReissue({ leafPem, keyPem, caPem: ca.pem, ips, hostname: opts.hostname, nowMs: Date.now() });

  let cert = leafPem!;
  let key = keyPem!;
  if (reason) {
    opts.log('info', 'issuing leaf certificate', { reason });
    const sans: San[] = [
      { type: 'dns', value: 'localhost' },
      { type: 'dns', value: leafDnsName(opts.hostname) },
      { type: 'ip', value: '127.0.0.1' },
      ...ips.filter((ip) => ip !== '127.0.0.1').map((value) => ({ type: 'ip' as const, value })),
    ];
    const fresh = await issueLeaf(ca, sans);
    await writeAtomic(keyFile, fresh.keyPem);
    await writeAtomic(certFile, fresh.certPem);
    cert = fresh.certPem;
    key = fresh.keyPem;
  }
  return {
    cert,
    key,
    fingerprint256: fingerprintOf(cert),
    generated: { ca: ca.created, leaf: reason !== null },
    ca: { pem: ca.pem, fingerprint256: fingerprintOf(ca.pem), name: ca.name },
    skippedIps,
  };
}
