// Starts a sandbox server of one kind with a temp folder and throwaway
// credentials, and builds transports for it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger, memorySink, type LogRecord, type Logger } from '../../src/log/logger.ts';
import { FtpTransport, type FtpTransportOptions } from '../../src/transport/ftp.ts';
import type { HostKeyPolicy } from '../../src/transport/hostkeys.ts';
import { LocalTransport } from '../../src/transport/local.ts';
import { SftpTransport, type SftpTransportOptions } from '../../src/transport/sftp.ts';
import type { Transport } from '../../src/transport/types.ts';
import { tempDir } from '../helpers/cli.ts';
import { selfSignedCertificate, type TestCertificate } from './cert.ts';
import { startFtpSandbox, type FtpFaults, type FtpSandbox } from './ftp-server.ts';
import { startSftpSandbox, type SftpFaults, type SftpSandbox } from './sftp-server.ts';

export type Kind = 'local' | 'sftp' | 'ftps' | 'ftps-implicit' | 'ftp';

export const KINDS: readonly Kind[] = ['local', 'sftp', 'ftps', 'ftps-implicit', 'ftp'];

export interface RigOptions {
  readonly faults?: FtpFaults & SftpFaults;
  readonly mlsd?: boolean;
  readonly keyboardInteractiveOnly?: boolean;
  readonly publicKey?: string;
}

export interface TransportOverrides {
  readonly password?: string;
  readonly timeoutMs?: number;
  readonly hostKeys?: HostKeyPolicy;
  readonly remoteRoot?: string;
  readonly allowInsecure?: boolean;
  readonly trustCertificate?: boolean;
  readonly minVersion?: 'TLSv1.2' | 'TLSv1.3';
  readonly listingLimit?: number;
  readonly auth?: SftpTransportOptions['auth'];
  readonly secret?: SftpTransportOptions['secret'];
  readonly legacyAlgorithms?: boolean;
  readonly logger?: Logger;
}

export interface Rig {
  readonly kind: Kind;
  /** The local folder that backs the remote root. */
  readonly siteDir: string;
  readonly user: string;
  readonly password: string;
  readonly sandbox: FtpSandbox | SftpSandbox | undefined;
  readonly certificate: TestCertificate | undefined;
  readonly caFile: string | undefined;
  /** Every log record of every transport made by this rig. */
  readonly records: LogRecord[];
  /** How often a transport of this rig asked for a secret. */
  readonly secretRequests: number;
  transport(overrides?: TransportOverrides): Transport;
  close(): Promise<void>;
}

export async function startRig(kind: Kind, options: RigOptions = {}): Promise<Rig> {
  const temp = tempDir('sync-servers-rig-');
  const serverDir = path.join(temp.dir, 'server');
  const siteDir = path.join(serverDir, 'site');
  mkdirSync(siteDir, { recursive: true });
  const user = 'demo-user';
  const password = `pw-${randomBytes(12).toString('hex')}`;
  const sink = memorySink();
  let secretRequests = 0;

  let sandbox: FtpSandbox | SftpSandbox | undefined;
  let certificate: TestCertificate | undefined;
  let caFile: string | undefined;
  if (kind === 'sftp') {
    sandbox = await startSftpSandbox({
      root: serverDir,
      user,
      password,
      ...(options.publicKey === undefined ? {} : { publicKey: options.publicKey }),
      ...(options.keyboardInteractiveOnly === undefined ? {} : { keyboardInteractiveOnly: options.keyboardInteractiveOnly }),
      ...(options.faults === undefined ? {} : { faults: options.faults }),
    });
  } else if (kind !== 'local') {
    if (kind !== 'ftp') {
      certificate = selfSignedCertificate();
      caFile = path.join(temp.dir, 'ca.pem');
      writeFileSync(caFile, certificate.cert);
    }
    sandbox = await startFtpSandbox({
      root: serverDir,
      user,
      password,
      tls: kind === 'ftps' ? 'explicit' : kind === 'ftps-implicit' ? 'implicit' : 'none',
      ...(certificate === undefined ? {} : { certificate }),
      ...(options.mlsd === undefined ? {} : { mlsd: options.mlsd }),
      ...(options.faults === undefined ? {} : { faults: options.faults }),
    });
  }

  const transport = (overrides: TransportOverrides = {}): Transport => {
    const logger = overrides.logger ?? createLogger({ level: 'debug', sinks: [sink] });
    const timeoutMs = overrides.timeoutMs ?? 10_000;
    const secret =
      overrides.secret ??
      ((): Promise<string> => {
        secretRequests += 1;
        const value = overrides.password ?? password;
        logger.redactor.addSecret(value);
        return Promise.resolve(value);
      });
    if (kind === 'local') {
      return new LocalTransport({ root: overrides.remoteRoot ?? siteDir, ...(overrides.listingLimit === undefined ? {} : { listingLimit: overrides.listingLimit }) });
    }
    if (sandbox === undefined) {
      throw new Error('no sandbox');
    }
    const common = {
      host: sandbox.host,
      port: sandbox.port,
      remoteRoot: overrides.remoteRoot ?? '/site',
      timeoutMs,
      logger,
      secret,
      ...(overrides.listingLimit === undefined ? {} : { listingLimit: overrides.listingLimit }),
    };
    if (kind === 'sftp') {
      const options: SftpTransportOptions = {
        ...common,
        username: user,
        auth: overrides.auth ?? { method: 'password' },
        hostKeys: overrides.hostKeys ?? { pinned: undefined, expected: (sandbox as SftpSandbox).hostKeySha256 },
        legacyAlgorithms: overrides.legacyAlgorithms,
      };
      return new SftpTransport(options);
    }
    const ftpOptions: FtpTransportOptions = {
      ...common,
      protocol: kind,
      username: user,
      allowInsecure: overrides.allowInsecure ?? kind === 'ftp',
      tls:
        overrides.trustCertificate === false
          ? { minVersion: overrides.minVersion ?? 'TLSv1.2' }
          : { caFile, minVersion: overrides.minVersion ?? 'TLSv1.2', servername: 'localhost' },
    };
    return new FtpTransport(ftpOptions);
  };

  return {
    kind,
    siteDir,
    user,
    password,
    sandbox,
    certificate,
    caFile,
    records: sink.records,
    get secretRequests() {
      return secretRequests;
    },
    transport,
    close: async () => {
      await sandbox?.close();
      temp.cleanup();
    },
  };
}
