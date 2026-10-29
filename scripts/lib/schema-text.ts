// The exact text of schema/site.schema.json.
import { sitesJsonSchema } from '../../src/config/schema.ts';

export function sitesJsonSchemaText(): string {
  return `${JSON.stringify(sitesJsonSchema(), null, 2)}\n`;
}
