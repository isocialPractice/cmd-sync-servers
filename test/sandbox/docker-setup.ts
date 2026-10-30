// Writes a throwaway RSA certificate and key for the vsftpd container into
// the folder given on the command line (sandbox/run/tls by default).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { selfSignedCertificate } from './cert.ts';

const dir = path.resolve(process.argv[2] ?? 'sandbox/run/tls');
mkdirSync(dir, { recursive: true });
const { cert, key } = selfSignedCertificate({ keyType: 'rsa' });
writeFileSync(path.join(dir, 'cert.pem'), cert);
writeFileSync(path.join(dir, 'key.pem'), key, { mode: 0o600 });
// The container reads the key as root through a read-only mount.
chmodSync(path.join(dir, 'key.pem'), 0o644);
process.stdout.write(`Wrote ${path.join(dir, 'cert.pem')} and key.pem\n`);
