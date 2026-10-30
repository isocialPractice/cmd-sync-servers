/**
 * The library API of cmd-sync-servers. This module is the only entry point
 * consumers import, apart from the optional OS keyring store in
 * `@isocialpractice/cmd-sync-servers/credentials/keyring`.
 *
 * @packageDocumentation
 */

export { VERSION } from './version.ts';
export { SyncError, isSyncError, type SyncErrorCode, type SyncErrorDetails, type SyncErrorOptions } from './errors.ts';

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
export { openSecret, sealSecret, secretBinding, type BoundServer } from './credentials/binding.ts';
export { EnvSecretSource, PASSPHRASE_ENV, PASSWORD_ENV } from './credentials/env.ts';
export { PromptSecretSource, secretQuestion, type SecretPrompt } from './credentials/prompt.ts';
export { lookupSecret, type SecretLookupOptions, type SecretOrigin } from './credentials/lookup.ts';

export type { CertificateDecision, CertificateInfo, CertificateProblem, HostAdapter, HostKeyDecision, HostKeyInfo } from './host.ts';
export { parseServerAddress, type ServerAddress, type ServerAddressResult } from './config/address.ts';

export {
  SyncSession,
  type Comparison,
  type ComparedSide,
  type PlanOptions,
  type SingleTransfer,
  type StatusEntry,
  type StatusReport,
  type SyncSessionOptions,
} from './sync/session.ts';
export { SyncPlan, decide, type Decision, type PlanItem, type PlanSummary, type SavedPlan, type SilentUpdate } from './sync/plan.ts';
export { resultLine, type ExecuteOptions, type ItemOutcome, type ItemResult, type SyncResult } from './sync/execute.ts';
export { classify, copiesMatch, hasChanged, type CompareOptions, type SyncState } from './sync/classify.ts';
export { STATUS, guardedStatus, unsafeNameStatus } from './sync/messages.ts';
export { cloakPatternToGitignore, siteCloak, splitPatterns, type Cloak } from './sync/cloak.ts';
export { DEFAULT_GUARD_PATTERNS, siteGuard, type Guard } from './sync/guard.ts';
export { SyncRecords, recordsFile, type SyncRecord } from './sync/state.ts';
export { DIRECTION_TITLES, type Action, type Direction, type Observation, type ProblemKind, type ProgressEvent, type ScanProblem, type Scope } from './sync/types.ts';

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
  type SecretSupplier,
  type Transport,
  type TransportContext,
} from './transport/index.ts';
export { DEFAULT_LISTING_LIMIT } from './transport/types.ts';
export { describeHostKey, normalizeFingerprint, verifyHostKey, type HostKeyPolicy, type PinnedHostKey } from './transport/hostkeys.ts';
export {
  findCoveredNames,
  normalizeCertificateFingerprint,
  type CertificateChange,
  type NameResolver,
  type TrustedCertificate,
} from './transport/certificates.ts';
export { ServerProbe, type FolderListing, type ServerProbeOptions } from './transport/probe.ts';
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
