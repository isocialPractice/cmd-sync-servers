/**
 * The library API of cmd-sync-servers. This module is the only entry point
 * consumers import, apart from the optional OS keyring store in
 * `@isocialpractice/cmd-sync-servers/credentials/keyring`.
 *
 * @packageDocumentation
 */

export { VERSION } from './version.ts';
export { SyncError, isSyncError, type SyncErrorCode, type SyncErrorOptions } from './errors.ts';

export { defaultPaths, type PathsEnvironment, type PathsOptions, type SyncServersPaths } from './config/paths.ts';
export {
  SiteRegistry,
  findServer,
  parseSitesFile,
  serializeSitesFile,
  type NewServer,
  type NewSite,
  type SiteQuery,
  type SiteRegistryOptions,
} from './config/registry.ts';
export {
  PROTOCOLS,
  SCHEMA_VERSION,
  SITES_SCHEMA_URL,
  defaultPort,
  formatIssues,
  serverSchema,
  siteSchema,
  sitesFileSchema,
  sitesJsonSchema,
  type Protocol,
  type Server,
  type ServerInput,
  type Site,
  type SiteInput,
  type SitesFile,
} from './config/schema.ts';

export {
  CREDENTIAL_SERVICE,
  secretAccount,
  type CredentialStore,
  type SecretKind,
  type SecretRef,
  type SecretRequest,
  type SecretSource,
} from './credentials/types.ts';
export { MemoryCredentialStore } from './credentials/memory.ts';
export { EnvSecretSource, PASSPHRASE_ENV, PASSWORD_ENV } from './credentials/env.ts';
export { PromptSecretSource, secretQuestion, type SecretPrompt } from './credentials/prompt.ts';
export { lookupSecret, type SecretLookupOptions } from './credentials/lookup.ts';

export type { HostAdapter, HostKeyDecision, HostKeyInfo } from './host.ts';

export {
  ROOT,
  baseName,
  caseCollisions,
  checkPath,
  childPath,
  isCaseSensitive,
  isInside,
  joinLocal,
  joinRemote,
  nameProblem,
  parentPath,
  safeLocalTarget,
  toRemotePath,
  type PathCheck,
  type RemotePath,
} from './sync/paths.ts';

export {
  createTransport,
  secretSupplier,
  transportFactory,
  type Capabilities,
  type EntryType,
  type RemoteEntry,
  type Transport,
  type TransportContext,
} from './transport/index.ts';
export { DEFAULT_LISTING_LIMIT } from './transport/types.ts';
export { describeHostKey, normalizeFingerprint, verifyHostKey, type HostKeyPolicy, type PinnedHostKey } from './transport/hostkeys.ts';
export { TransportPool, type PoolOptions } from './transport/pool.ts';
export { DEFAULT_RETRY_DELAYS_MS, isTransient, withRetry, type RetryOptions } from './transport/retry.ts';
export { LocalTransport, type LocalTransportOptions } from './transport/local.ts';
export { SftpTransport, MODERN_ALGORITHMS, type SftpTransportOptions } from './transport/sftp.ts';
export { FtpTransport, type FtpTransportOptions } from './transport/ftp.ts';

export {
  REDACTED,
  Redactor,
  createLogger,
  memorySink,
  runLogSink,
  silentLogger,
  textSink,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type Logger,
  type LoggerOptions,
} from './log/logger.ts';
