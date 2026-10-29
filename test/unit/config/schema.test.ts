import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatIssues,
  serverSchema,
  siteSchema,
  sitesFileSchema,
  type ServerInput,
  type SiteInput,
} from '../../../src/config/schema.ts';
import { sitesJsonSchemaText } from '../../../scripts/lib/schema-text.ts';

const root = path.resolve('/sites/my-site');

function server(overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    id: randomUUID(),
    name: 'Production',
    protocol: 'sftp',
    host: 'sftp.example.com',
    username: 'demo-user',
    remoteRoot: '/var/www/my-site',
    ...overrides,
  };
}

function site(overrides: Partial<SiteInput> = {}): SiteInput {
  return { id: randomUUID(), name: 'My Site', localRoot: root, ...overrides };
}

function issues(result: { success: boolean; error?: { issues: Parameters<typeof formatIssues>[0] } }): string[] {
  return result.success || result.error === undefined ? [] : formatIssues(result.error.issues);
}

test('a minimal site gets every default', () => {
  const parsed = siteSchema.parse(site());
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.local, { cache: true });
  assert.deepEqual(parsed.cloaking, { enabled: true, patterns: [], paths: [] });
  assert.equal(parsed.sync.maintainInfo, true);
  assert.equal(parsed.sync.compare, 'metadata');
  assert.equal(parsed.sync.mtimeToleranceSeconds, 2);
  assert.equal(parsed.sync.symlinks, 'skip');
  assert.equal(parsed.sync.concurrency, 4);
  assert.deepEqual(parsed.sync.guard, { enabled: true, patterns: [] });
  assert.deepEqual(parsed.sync.massDelete, { maxCount: 50, maxPercent: 25 });
  assert.deepEqual(parsed.sync.recovery, { enabled: true, keepDays: 14, maxMegabytes: 1024 });
});

test('a new site has cloaking on and no cloaking patterns', () => {
  const parsed = siteSchema.parse(site());
  assert.equal(parsed.cloaking.enabled, true);
  assert.equal(parsed.cloaking.patterns.length, 0);
});

test('a server gets its option defaults', () => {
  const parsed = serverSchema.parse(server());
  assert.deepEqual(parsed.options, { passive: true, timeoutSeconds: 30, uploadOnSave: false });
});

test('unknown keys are rejected with their path', () => {
  const result = sitesFileSchema.safeParse({
    schemaVersion: 1,
    sites: [{ ...site(), servers: [{ ...server(), colour: 'blue' }] }],
  });
  assert.equal(result.success, false);
  assert.ok(issues(result).some((line) => line.startsWith('sites[0].servers[0]: ') && line.includes('colour')));
});

test('plain FTP needs allowInsecure', () => {
  const refused = serverSchema.safeParse(server({ protocol: 'ftp' }));
  assert.ok(issues(refused).some((line) => line.startsWith('options.allowInsecure: ')));
  assert.equal(serverSchema.safeParse(server({ protocol: 'ftp', options: { allowInsecure: true } })).success, true);
});

test('network servers need a host and an absolute POSIX root', () => {
  const lines = issues(serverSchema.safeParse(server({ host: undefined, remoteRoot: 'www' })));
  assert.ok(lines.some((line) => line.startsWith('host: ')));
  assert.ok(lines.some((line) => line.startsWith('remoteRoot: ')));
});

test('local servers take a folder and no host, port, user or auth', () => {
  const ok = serverSchema.safeParse({ id: randomUUID(), name: 'Share', protocol: 'local', remoteRoot: path.resolve('/mnt/share') });
  assert.equal(ok.success, true);
  const lines = issues(serverSchema.safeParse(server({ protocol: 'local', remoteRoot: path.resolve('/mnt/share') })));
  assert.ok(lines.some((line) => line.startsWith('host: ')));
  assert.ok(lines.some((line) => line.startsWith('username: ')));
});

test('key and agent sign-in are SFTP only, and a key needs a file', () => {
  assert.ok(
    issues(serverSchema.safeParse(server({ protocol: 'ftps', auth: { method: 'agent' } }))).some((line) =>
      line.startsWith('auth.method: '),
    ),
  );
  assert.ok(issues(serverSchema.safeParse(server({ auth: { method: 'key' } }))).some((line) => line.startsWith('auth.keyPath: ')));
});

test('host key fingerprints must be unpadded base64 SHA-256', () => {
  const pinned = { algorithm: 'ssh-ed25519', sha256: 'A'.repeat(43), pinnedAt: '2026-10-29T12:00:00Z' };
  assert.equal(serverSchema.safeParse(server({ options: { hostKey: pinned } })).success, true);
  assert.equal(serverSchema.safeParse(server({ options: { hostKey: { ...pinned, sha256: 'SHA256:abc' } } })).success, false);
});

test('roles must point at servers of the site', () => {
  const lines = issues(siteSchema.safeParse(site({ servers: [server()], remoteServerId: randomUUID() })));
  assert.ok(lines.some((line) => line.startsWith('remoteServerId: ')));
});

test('server names are unique within a site, ignoring case', () => {
  const lines = issues(siteSchema.safeParse(site({ servers: [server(), server({ name: 'production' })] })));
  assert.ok(lines.some((line) => line.startsWith('servers[1].name: ')));
});

test('site names are unique, ignoring case, and ids are unique', () => {
  const first = site();
  const lines = issues(
    sitesFileSchema.safeParse({ schemaVersion: 1, sites: [first, site({ name: 'MY SITE' }), { ...site({ name: 'Other' }), id: first.id }] }),
  );
  assert.ok(lines.some((line) => line.startsWith('sites[1].name: ')));
  assert.ok(lines.some((line) => line.startsWith('sites[2].id: ')));
});

test('the local root must be absolute', () => {
  assert.ok(issues(siteSchema.safeParse(site({ localRoot: 'sites/my-site' }))).some((line) => line.startsWith('localRoot: ')));
});

test('names are trimmed', () => {
  assert.equal(siteSchema.parse(site({ name: '  My Site  ' })).name, 'My Site');
});

test('schema/site.schema.json matches the zod schema', () => {
  const committed = readFileSync(new URL('../../../schema/site.schema.json', import.meta.url), 'utf8');
  assert.equal(committed, sitesJsonSchemaText(), 'schema/site.schema.json is stale: run "npm run schema" and commit it');
});

test('the JSON Schema describes the file for editors', () => {
  const schema = JSON.parse(sitesJsonSchemaText()) as {
    $id: string;
    properties: Record<string, unknown>;
    additionalProperties: unknown;
  };
  assert.equal(schema.$id, 'https://isocialpractice.github.io/cmd-sync-servers/schema/site.schema.json');
  assert.ok('sites' in schema.properties);
  assert.ok('schemaVersion' in schema.properties);
  assert.equal(schema.additionalProperties, false);
});
