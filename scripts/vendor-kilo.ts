// Downloads kilo.c and LICENSE from antirez/kilo at the pinned commit into
// vendor/kilo/ and prints their SHA-256, for VENDORED.md. The unit test
// test/unit/tui/vendored.test.ts recomputes the checksums of the committed
// copies, so they cannot drift unnoticed.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const KILO_COMMIT = '323d93b29bd89a2cb446de90c4ed4fea1764176e';
const FILES = ['kilo.c', 'LICENSE'];
const dir = path.resolve('vendor', 'kilo');

mkdirSync(dir, { recursive: true });
for (const name of FILES) {
  const url = `https://raw.githubusercontent.com/antirez/kilo/${KILO_COMMIT}/${name}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  writeFileSync(path.join(dir, name), data);
  process.stdout.write(`${createHash('sha256').update(data).digest('hex')}  ${name}  (${String(data.length)} bytes)\n`);
}
