import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../../src/index.ts';

// The values the package exports. Adding or removing one changes the public
// API: update this list and say so in CHANGELOG.md. Types are checked by
// TypeDoc's validation in `npm run docs:api`.
const EXPORTS = [
  'CREDENTIAL_SERVICE',
  'DEFAULT_GUARD_PATTERNS',
  'DEFAULT_LISTING_LIMIT',
  'DEFAULT_RETRY_DELAYS_MS',
  'DIRECTION_TITLES',
  'EnvSecretSource',
  'FtpTransport',
  'LocalTransport',
  'MODERN_ALGORITHMS',
  'MemoryCredentialStore',
  'PASSPHRASE_ENV',
  'PASSWORD_ENV',
  'PROTOCOLS',
  'PromptSecretSource',
  'REDACTED',
  'ROOT',
  'Redactor',
  'SCHEMA_VERSION',
  'SITES_SCHEMA_URL',
  'STATUS',
  'ServerProbe',
  'SftpTransport',
  'SiteRegistry',
  'SyncError',
  'SyncPlan',
  'SyncRecords',
  'SyncSession',
  'TransportPool',
  'VERSION',
  'baseName',
  'caseCollisions',
  'checkPath',
  'childPath',
  'classify',
  'cloakPatternToGitignore',
  'copiesMatch',
  'createLogger',
  'createTransport',
  'decide',
  'defaultPaths',
  'defaultPort',
  'describeHostKey',
  'findCoveredNames',
  'findServer',
  'formatIssues',
  'guardedStatus',
  'hasChanged',
  'isCaseSensitive',
  'isInside',
  'isSyncError',
  'isTransient',
  'joinLocal',
  'joinRemote',
  'lookupSecret',
  'memorySink',
  'nameProblem',
  'normalizeCertificateFingerprint',
  'normalizeFingerprint',
  'openSecret',
  'parentPath',
  'parseServerAddress',
  'parseSitesFile',
  'recordsFile',
  'resolveLocalTarget',
  'resultLine',
  'runLogSink',
  'safeLocalTarget',
  'sealSecret',
  'secretAccount',
  'secretBinding',
  'secretQuestion',
  'secretSupplier',
  'serializeSitesFile',
  'serverSchema',
  'siteCloak',
  'siteGuard',
  'siteSchema',
  'silentLogger',
  'sitesFileSchema',
  'sitesJsonSchema',
  'splitPatterns',
  'textSink',
  'toRemotePath',
  'transportFactory',
  'unsafeNameStatus',
  'verifyHostKey',
  'withRetry',
];

test('the library exports exactly the documented values', () => {
  assert.deepEqual(Object.keys(api).sort(), [...EXPORTS].sort());
});

test('the main classes and functions are what they claim to be', () => {
  assert.equal(typeof api.SiteRegistry.open, 'function');
  assert.equal(typeof api.SyncSession.open, 'function');
  assert.equal(typeof api.SyncPlan.fromJSON, 'function');
  assert.ok(new api.SyncError('E_AUTH', 'No password.') instanceof Error);
  assert.ok(api.isSyncError(new api.SyncError('E_LOCKED', 'Locked.'), 'E_LOCKED'));
  assert.deepEqual(api.PROTOCOLS, ['sftp', 'ftps', 'ftps-implicit', 'ftp', 'local']);
  assert.equal(api.DIRECTION_TITLES.put, 'Put newer files to remote');
});
