// `npm run sandbox`: starts every in-process sandbox server on fixed local
// ports with throwaway credentials, so the CLI and the VS Code extension can
// be tried without a real host. Everything lives in a temp folder that is
// removed when the sandbox stops (Ctrl+C).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selfSignedCertificate } from './cert.ts';
import { startFtpSandbox } from './ftp-server.ts';
import { startSftpSandbox } from './sftp-server.ts';

const PORTS = { sftp: 2222, ftps: 2121, ftpsImplicit: 2990, ftp: 2021 } as const;

const dir = mkdtempSync(path.join(tmpdir(), 'sync-servers-sandbox-'));
const serverDir = path.join(dir, 'server');
const siteDir = path.join(serverDir, 'site');
mkdirSync(path.join(siteDir, 'css'), { recursive: true });
writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html>\n<title>Sample App</title>\n<h1>Sample App</h1>\n');
writeFileSync(path.join(siteDir, 'css', 'site.css'), 'body { font-family: system-ui; }\n');

const user = 'demo-user';
const password = randomBytes(12).toString('hex');
const certificate = selfSignedCertificate();
const caFile = path.join(dir, 'ca.pem');
writeFileSync(caFile, certificate.cert);

const sftp = await startSftpSandbox({ root: serverDir, user, password, port: PORTS.sftp });
const servers = [
  sftp,
  await startFtpSandbox({ root: serverDir, user, password, tls: 'explicit', certificate, port: PORTS.ftps }),
  await startFtpSandbox({ root: serverDir, user, password, tls: 'implicit', certificate, port: PORTS.ftpsImplicit }),
  await startFtpSandbox({ root: serverDir, user, password, tls: 'none', port: PORTS.ftp }),
];

const lines = [
  'Sandbox servers on 127.0.0.1. Stop them with Ctrl+C.',
  '',
  `  SFTP            port ${String(PORTS.sftp)}   host key SHA256:${sftp.hostKeySha256}`,
  `  FTPS explicit   port ${String(PORTS.ftps)}`,
  `  FTPS implicit   port ${String(PORTS.ftpsImplicit)}`,
  `  FTP (insecure)  port ${String(PORTS.ftp)}`,
  '',
  `  User       ${user}`,
  `  Password   ${password}   (throwaway, for this run only)`,
  '  Root       /site',
  `  Files      ${siteDir}`,
  `  CA file    ${caFile}   (for FTPS: --ca-file)`,
  '',
  'Try it:',
  `  sync-servers server add --site "My Site" --name Sandbox --host 127.0.0.1 --port ${String(PORTS.sftp)} --user ${user} --remote-root /site`,
  `  sync-servers server test Sandbox --site "My Site" --host-key SHA256:${sftp.hostKeySha256}`,
  '',
];
process.stdout.write(lines.join('\n'));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await Promise.all(servers.map((server) => server.close()));
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write('Sandbox stopped.\n');
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
