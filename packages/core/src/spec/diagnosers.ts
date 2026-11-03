import load30 from './generated/openapi-3.0-diagnoser.cjs';
import load31 from './generated/openapi-3.1-diagnoser.cjs';
import load32 from './generated/openapi-3.2-diagnoser.cjs';
import type { OpenApiValidators } from './validate.ts';

// Imported only after a spec failed validation, to list its errors (issue #131)
export const OPENAPI_DIAGNOSERS: OpenApiValidators = {
  '3.0': load30,
  '3.1': load31,
  '3.2': load32,
};
