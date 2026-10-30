import path from 'node:path';
import * as z from 'zod';

/** The version of the `sites.json` format this release reads and writes. */
export const SCHEMA_VERSION = 1;

/** Where the generated JSON Schema of `sites.json` is published. */
export const SITES_SCHEMA_URL = 'https://isocialpractice.github.io/cmd-sync-servers/schema/site.schema.json';

/** Every way to reach a server, SFTP first. */
export const PROTOCOLS = ['sftp', 'ftps', 'ftps-implicit', 'ftp', 'local'] as const;
/** SFTP, FTPS with explicit or implicit TLS, plain FTP, or a local or network folder. */
export type Protocol = (typeof PROTOCOLS)[number];

/** The port each protocol uses when a server sets none. */
export function defaultPort(protocol: Exclude<Protocol, 'local'>): number {
  switch (protocol) {
    case 'sftp':
      return 22;
    case 'ftps-implicit':
      return 990;
    case 'ftps':
    case 'ftp':
      return 21;
  }
}

const id = z.uuid().describe('A random UUID, stable across renames.');
const displayName = z.string().trim().min(1).max(120);
const fileMode = z
  .string()
  .regex(/^[0-7]{3,4}$/, 'Must be an octal mode such as "644".')
  .describe('An octal mode such as "644". Unset leaves the server default.');
const pattern = z.string().trim().min(1);

const authSchema = z.strictObject({
  method: z.enum(['password', 'key', 'agent']).describe('How to authenticate. "key" and "agent" are SFTP only.'),
  keyPath: z.string().min(1).optional().describe('Private key file for the "key" method. Referenced, never copied.'),
  savePassword: z
    .boolean()
    .default(false)
    .describe('Keep the password or key passphrase in the operating system credential store.'),
});

const tlsSchema = z.strictObject({
  caFile: z.string().min(1).optional().describe('A PEM file of extra certificate authorities, for a private CA.'),
  servername: z.string().min(1).optional().describe('The host name to verify the certificate against, when it differs from host.'),
  minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).default('TLSv1.2'),
});

const hostKeySchema = z.strictObject({
  algorithm: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}$/, 'Must be an unpadded base64 SHA-256 fingerprint.')
    .describe('The SHA-256 fingerprint, as OpenSSH prints it after "SHA256:".'),
  pinnedAt: z.iso.datetime(),
});

const serverOptionsSchema = z.strictObject({
  passive: z.boolean().default(true).describe('FTP passive mode. Only passive mode is supported.'),
  ipFamily: z.union([z.literal(4), z.literal(6)]).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(30),
  allowInsecure: z.boolean().optional().describe('Required for plain FTP, which sends the password in clear text.'),
  allowRootDeletes: z.boolean().optional().describe('Allow deletes when the remote root is "/" or a drive root.'),
  legacyAlgorithms: z.boolean().optional().describe('SFTP: allow older algorithms for an old server, with a warning.'),
  tls: tlsSchema.optional(),
  hostKey: hostKeySchema.optional().describe('The pinned SSH host key, set when it is accepted on first connection.'),
  uploadOnSave: z.boolean().default(false),
  remoteFileMode: fileMode.optional(),
  remoteDirMode: fileMode.optional(),
});

/** Validates one server of a site, with the rules each protocol adds. */
export const serverSchema = z
  .strictObject({
    id,
    name: displayName.describe('The server name, unique within its site.'),
    protocol: z.enum(PROTOCOLS).describe('"local" is a folder, a mounted drive or a network share.'),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1).optional(),
    auth: authSchema.optional(),
    remoteRoot: z.string().min(1).describe('The site root on the server. For "local", an absolute or UNC path.'),
    webUrl: z.url().optional(),
    options: serverOptionsSchema.prefault({}),
  })
  .superRefine((server, ctx) => {
    if (server.protocol === 'local') {
      for (const key of ['host', 'port', 'username', 'auth'] as const) {
        if (server[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'Not used by the "local" protocol.' });
        }
      }
      if (!path.isAbsolute(server.remoteRoot)) {
        ctx.addIssue({ code: 'custom', path: ['remoteRoot'], message: 'Must be an absolute path.' });
      }
      return;
    }
    if (server.host === undefined) {
      ctx.addIssue({ code: 'custom', path: ['host'], message: `Required for the "${server.protocol}" protocol.` });
    }
    if (!server.remoteRoot.startsWith('/')) {
      ctx.addIssue({ code: 'custom', path: ['remoteRoot'], message: 'Must be an absolute path that starts with "/".' });
    }
    if (server.protocol === 'ftp' && server.options.allowInsecure !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['options', 'allowInsecure'],
        message: 'Plain FTP sends the password in clear text. Set allowInsecure to true to use it, or choose sftp or ftps.',
      });
    }
    if (server.auth !== undefined && server.auth.method !== 'password' && server.protocol !== 'sftp') {
      ctx.addIssue({ code: 'custom', path: ['auth', 'method'], message: `"${server.auth.method}" works with sftp only.` });
    }
    if (server.auth?.method === 'key' && server.auth.keyPath === undefined) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'keyPath'], message: 'Required for the "key" method.' });
    }
  });

const localSchema = z.strictObject({
  webUrl: z.url().optional().describe('The local web address, such as http://localhost:8080/.'),
  caseSensitive: z.boolean().optional().describe('Unset: probed from the file system.'),
  cache: z.boolean().default(true).describe('Cache local scans between runs.'),
});

const cloakingSchema = z.strictObject({
  enabled: z.boolean().default(true),
  patterns: z
    .array(pattern)
    .default([])
    .describe('".psd" cloaks a suffix, "archive*" a name, "node_modules/" a folder, "/drafts/" a root folder, "!x" re-includes.'),
  paths: z.array(pattern).default([]).describe('Site-relative files and folders cloaked one by one.'),
});

const syncSchema = z.strictObject({
  maintainInfo: z.boolean().default(true).describe('Keep sync records, so changes on both sides are detected.'),
  compare: z.enum(['metadata', 'checksum']).default('metadata'),
  mtimeToleranceSeconds: z.number().min(0).max(3600).default(2),
  symlinks: z.enum(['skip', 'follow-inside-root']).default('skip'),
  concurrency: z.number().int().min(1).max(16).default(4),
  guard: z
    .strictObject({
      enabled: z.boolean().default(true),
      patterns: z.array(pattern).default([]).describe('Sensitive-file patterns added to the built-in list.'),
    })
    .prefault({}),
  massDelete: z
    .strictObject({
      maxCount: z.number().int().min(0).default(50),
      maxPercent: z.number().min(0).max(100).default(25),
    })
    .prefault({}),
  recovery: z
    .strictObject({
      enabled: z.boolean().default(true),
      keepDays: z.number().int().min(0).default(14),
      maxMegabytes: z.number().int().min(0).default(1024),
    })
    .prefault({}),
});

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/** Validates one site: its local root, servers, roles, cloaking and synchronization settings. */
export const siteSchema = z
  .strictObject({
    id,
    name: displayName.describe('The site name, unique across all sites, ignoring case.'),
    localRoot: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), 'Must be an absolute path.')
      .describe('The local site folder.'),
    servers: z.array(serverSchema).default([]),
    remoteServerId: id.optional().describe('The server synchronization uses.'),
    testingServerId: id.optional().describe('The server automatic pushes go to.'),
    local: localSchema.prefault({}),
    cloaking: cloakingSchema.prefault({}),
    sync: syncSchema.prefault({}),
  })
  .superRefine((site, ctx) => {
    site.servers.forEach((server, index) => {
      const earlier = site.servers.slice(0, index);
      if (earlier.some((other) => other.id === server.id)) {
        ctx.addIssue({ code: 'custom', path: ['servers', index, 'id'], message: 'Duplicate server id.' });
      }
      if (earlier.some((other) => sameName(other.name, server.name))) {
        ctx.addIssue({ code: 'custom', path: ['servers', index, 'name'], message: `Another server is named "${server.name}".` });
      }
    });
    for (const key of ['remoteServerId', 'testingServerId'] as const) {
      const serverId = site[key];
      if (serverId !== undefined && !site.servers.some((server) => server.id === serverId)) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'No server in this site has this id.' });
      }
    }
  });

/** Validates the whole of `sites.json`. */
export const sitesFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    sites: z.array(siteSchema).default([]),
    lastSelectedSiteId: id.optional(),
  })
  .superRefine((file, ctx) => {
    file.sites.forEach((site, index) => {
      const earlier = file.sites.slice(0, index);
      if (earlier.some((other) => other.id === site.id)) {
        ctx.addIssue({ code: 'custom', path: ['sites', index, 'id'], message: 'Duplicate site id.' });
      }
      if (earlier.some((other) => sameName(other.name, site.name))) {
        ctx.addIssue({ code: 'custom', path: ['sites', index, 'name'], message: `Another site is named "${site.name}".` });
      }
    });
  });

/** A server as stored, with every default filled in. The fields are described in `schema/site.schema.json`. */
export type Server = z.infer<typeof serverSchema>;
/** A server as written, where fields with defaults may be left out. */
export type ServerInput = z.input<typeof serverSchema>;
/** A site as stored, with every default filled in. The fields are described in `schema/site.schema.json`. */
export type Site = z.infer<typeof siteSchema>;
/** A site as written, where fields with defaults may be left out. */
export type SiteInput = z.input<typeof siteSchema>;
/** The whole of `sites.json` as stored. */
export type SitesFile = z.infer<typeof sitesFileSchema>;

/** The JSON Schema of `sites.json`, as written to `schema/site.schema.json`. */
export function sitesJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(sitesFileSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return {
    $schema: generated.$schema,
    $id: SITES_SCHEMA_URL,
    title: 'sync-servers sites.json',
    description: 'The master list of sites and servers shared by the sync-servers CLI and the VS Code extension.',
    ...Object.fromEntries(Object.entries(generated).filter(([key]) => key !== '$schema')),
  };
}

/** Formats validation issues as `<path>: <message>` lines. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const where = issue.path.reduce<string>((text, part) => {
      if (typeof part === 'number') {
        return `${text}[${String(part)}]`;
      }
      return text === '' ? String(part) : `${text}.${String(part)}`;
    }, '');
    return `${where === '' ? '(top level)' : where}: ${issue.message}`;
  });
}
