// Regenerates the precompiled OpenAPI meta-schema validators (issue
// kaisers-io/openapi-mcp-archive#76). Run after bumping ajv, ajv-formats,
// ajv-draft-04 or @seriousme/openapi-schema-validator:
//
//   node scripts/generate-validators.ts
//
// The generator itself is packages/core/src/spec/generate-validators.ts;
// validate.test.ts fails while the committed files differ from its output.
import { writeFile } from 'node:fs/promises';
import {
  GENERATED_FILES,
  generateValidator,
} from '../packages/core/src/spec/generate-validators.ts';

for (const version of ['3.0', '3.1'] as const) {
  await writeFile(
    new URL(`../packages/core/src/spec/generated/${GENERATED_FILES[version]}`, import.meta.url),
    generateValidator(version),
  );
}
