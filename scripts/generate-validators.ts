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
  GENERATED_DIAGNOSER_FILES,
  GENERATED_FILES,
  generateValidator,
} from '../packages/core/src/spec/generate-validators.ts';

const generated = (file: string): URL =>
  new URL(`../packages/core/src/spec/generated/${file}`, import.meta.url);

for (const version of ['3.0', '3.1', '3.2'] as const) {
  await writeFile(generated(GENERATED_FILES[version]), generateValidator(version));
  await writeFile(generated(GENERATED_DIAGNOSER_FILES[version]), generateValidator(version, true));
}
