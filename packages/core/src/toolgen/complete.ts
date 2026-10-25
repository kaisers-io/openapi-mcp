import { deepFreeze } from '../freeze.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import type { GeneratedTool, OutputSide } from './build.ts';
import { composeDescription } from './description.ts';
import { explainOutputSchema } from './output-schema.ts';
import type { NullableFieldScope } from './output-schema.ts';

// The output side of one tool: its output schema, the description (which
// names a withheld schema) and the flags that come with them. Frozen:
// every caller of a tool's `complete` shares it, a server snapshot
// included, so none may change what the others see.
export const completeTool = (
  core: Omit<GeneratedTool, OutputSide>,
  openapiVersion: OpenapiVersion,
  defaultResponseIsError: boolean,
  nullableResponseFields: NullableFieldScope | undefined,
): GeneratedTool => {
  const { operation } = core;
  const { outputSchema, withheld, admitsNullFields } = explainOutputSchema(
    operation,
    openapiVersion,
    {
      defaultResponseIsError,
      ...(nullableResponseFields === undefined ? {} : { nullableResponseFields }),
      pagination: core.pagination !== undefined,
      projection: core.projection === true,
    },
  );
  const assumesDefaultIsError =
    defaultResponseIsError &&
    outputSchema !== undefined &&
    Object.hasOwn(operation.responses, 'default');
  return deepFreeze({
    toolName: core.toolName,
    operation,
    inputSchema: core.inputSchema,
    wireSchema: core.wireSchema,
    mapper: core.mapper,
    description: composeDescription(operation, withheld),
    annotations: core.annotations,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(assumesDefaultIsError ? { outputSchemaAssumesDefaultIsError: true as const } : {}),
    ...(admitsNullFields === true ? { outputSchemaAdmitsNullFields: true as const } : {}),
    ...(withheld === undefined ? {} : { outputSchemaWithheld: withheld }),
    ...(core.pagination === undefined ? {} : { pagination: core.pagination }),
    ...(core.projection === true ? { projection: true } : {}),
  });
};
