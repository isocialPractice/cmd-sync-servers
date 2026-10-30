// Assembles the Pages site in _site/: the pages of docs/, and the JSON Schema
// at the address sites.json files point to. `npm run docs:api` adds _site/api/.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('_site', { recursive: true, force: true });
cpSync('docs', '_site', { recursive: true });
mkdirSync('_site/schema', { recursive: true });
cpSync('schema/site.schema.json', '_site/schema/site.schema.json');
process.stdout.write('Assembled _site from docs/ and schema/.\n');
