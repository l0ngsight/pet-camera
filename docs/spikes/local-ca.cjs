// Spike (Ari, 2026-10-10): name-constrained local CA + leaf with @peculiar/x509. Reference for src/server/tls.ts.
// Run from docs/spikes/: `node local-ca.cjs && openssl verify -CAfile ca.pem ok.pem` (bad*.pem must fail with "permitted subtree violation").
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.resolve(__dirname, '../../package.json'));
const x509 = req('@peculiar/x509');
const { AsnConvert } = req('@peculiar/asn1-schema');
const asn = req('@peculiar/asn1-x509');
const { webcrypto } = require('crypto');
const fs = require('fs');
x509.cryptoProvider.set(webcrypto);
const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

const ipSubtree = (cidr) => new asn.GeneralSubtree({ base: new asn.GeneralName({ iPAddress: cidr }) });
const dnsSubtree = (d) => new asn.GeneralSubtree({ base: new asn.GeneralName({ dNSName: d }) });

(async () => {
  const caKeys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const nc = new asn.NameConstraints({ permittedSubtrees: new asn.GeneralSubtrees([
    dnsSubtree('localhost'), dnsSubtree('local'),
    ipSubtree('127.0.0.0/8'), ipSubtree('10.0.0.0/8'), ipSubtree('172.16.0.0/12'), ipSubtree('192.168.0.0/16'), ipSubtree('100.64.0.0/10'),
  ]) });
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=PetCam Local CA', notBefore: new Date(), notAfter: new Date(Date.now() + 3650 * 864e5),
    keys: caKeys, signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      new x509.Extension('2.5.29.30', true, AsnConvert.serialize(nc)),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const leafKeys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const mk = async (sans) => x509.X509CertificateGenerator.create({
    serialNumber: '02', subject: 'CN=petcam', issuer: ca.subject, notBefore: new Date(), notAfter: new Date(Date.now() + 397 * 864e5),
    signingKey: caKeys.privateKey, publicKey: leafKeys.publicKey, signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(sans),
      await x509.AuthorityKeyIdentifierExtension.create(ca),
    ],
  });
  const ok = await mk([{ type: 'dns', value: 'localhost' }, { type: 'dns', value: 'mybox.local' }, { type: 'ip', value: '127.0.0.1' }, { type: 'ip', value: '192.168.1.50' }, { type: 'ip', value: '100.101.102.103' }]);
  const bad = await mk([{ type: 'dns', value: 'www.google.com' }]);
  const badip = await mk([{ type: 'ip', value: '8.8.8.8' }]);
  fs.writeFileSync('ca.pem', ca.toString('pem')); fs.writeFileSync('ok.pem', ok.toString('pem'));
  fs.writeFileSync('bad.pem', bad.toString('pem')); fs.writeFileSync('badip.pem', badip.toString('pem'));
})();
