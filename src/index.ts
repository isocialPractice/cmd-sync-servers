/**
 * The library API of cmd-sync-servers. This module is the only entry point
 * consumers import, apart from the optional OS keyring store in
 * `@isocialpractice/cmd-sync-servers/credentials/keyring`.
 *
 * @packageDocumentation
 */

export { VERSION } from './version.ts';
export { SyncError, isSyncError, type SyncErrorCode } from './errors.ts';

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
