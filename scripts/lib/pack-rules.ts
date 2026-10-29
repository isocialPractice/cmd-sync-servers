// The rules `npm run pack:check` applies to the file list of `npm pack`.

const topLevelFiles = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
const builtFile = /^out\/.+\.(?:js|d\.ts)$/;
const schemaFile = /^schema\/[^/]+\.schema\.json$/;

const forbidden: readonly RegExp[] = [
  /(?:^|\/)tests?(?:\/|$)/,
  /fixtures?/i,
  /(?:^|\/)sandbox(?:\/|$)/,
  /(?:^|\/)vendor(?:\/|$)/,
  /(?:^|\/)\.(?:claude|support|archive|backups|tmp|github|vscode)(?:\/|$)/,
  /(?:^|\/)\.env/,
  /(?:^|\/)id_(?:rsa|ecdsa|ed25519)/,
  /\.(?:pem|key|crt|p12|pfx|kdbx|map|tsbuildinfo|code-workspace|lnk|ai)$/i,
  /(?:^|\/)task\.bat$/i,
];

const required: readonly string[] = [
  'package.json',
  'LICENSE',
  'README.md',
  'out/index.js',
  'out/index.d.ts',
  'out/cli/main.js',
];

/** Returns one message per problem with the packed paths; empty when all is well. */
export function checkPackPaths(packed: readonly string[]): string[] {
  const paths = packed.map((path) => path.replaceAll('\\', '/'));
  const problems: string[] = [];
  for (const path of paths) {
    if (!topLevelFiles.has(path) && !builtFile.test(path) && !schemaFile.test(path)) {
      problems.push(`not in the allowlist: ${path}`);
    }
    if (forbidden.some((pattern) => pattern.test(path))) {
      problems.push(`must never be packed: ${path}`);
    }
  }
  for (const path of required) {
    if (!paths.includes(path)) {
      problems.push(`missing: ${path}`);
    }
  }
  return problems;
}
