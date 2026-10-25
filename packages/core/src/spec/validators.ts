import load30 from './generated/openapi-3.0-validator.cjs';
import load31 from './generated/openapi-3.1-validator.cjs';
import load32 from './generated/openapi-3.2-validator.cjs';
import type { OpenApiValidators } from './validate.ts';

// Imported only through loadOpenApiValidators, so it stays out of startup
export const OPENAPI_VALIDATORS: OpenApiValidators = {
  '3.0': load30,
  '3.1': load31,
  '3.2': load32,
};
