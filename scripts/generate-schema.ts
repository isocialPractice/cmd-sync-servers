// Writes schema/site.schema.json from the zod schema of sites.json. A unit
// test fails when the committed file differs from a fresh generation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { sitesJsonSchemaText } from './lib/schema-text.ts';

mkdirSync('schema', { recursive: true });
writeFileSync('schema/site.schema.json', sitesJsonSchemaText());
