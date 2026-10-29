import { deepFreeze } from '../freeze.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import type { GeneratedTool, OutputSide } from './build.ts';
import { composeDescription } from './description.ts';
import { explainOutputSchema } from './output-schema.ts';
import type { NullableFieldScope } from './output-schema.ts';

// The output side of one tool: its output schema, the description (which
// names a withheld schema) and the flags that come with them. The tool and
// its output schema are frozen: every caller of a tool's `complete` shares
// them, a server snapshot included, so none may change what the others see.
// The rest is the tool's core, which a deferred snapshot freezes itself.
export const completeTool = (
  core: Omit<GeneratedTool, OutputSide>,
  {
    openapiVersion,
    defaultResponseIsError,
    nullableResponseFields,
  }: {
    openapiVersion: OpenapiVersion;
    defaultResponseIsError: boolean;
    nullableResponseFields: NullableFieldScope | undefined;
  },
  seen?: WeakSet<object>,
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
  if (outputSchema !== undefined) {
    deepFreeze(outputSchema, seen);
  }
  return Object.freeze({
    toolName: core.toolName,
    operation,
    inputSchema: core.inputSchema,
    wireSchema: core.wireSchema,
    mapper: core.mapper,
    description: composeDescription(operation, withheld, core.leftOutParameters),
    annotations: core.annotations,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(assumesDefaultIsError ? { outputSchemaAssumesDefaultIsError: true as const } : {}),
    ...(admitsNullFields === true ? { outputSchemaAdmitsNullFields: true as const } : {}),
    ...(withheld === undefined ? {} : { outputSchemaWithheld: withheld }),
    ...(core.pagination === undefined ? {} : { pagination: core.pagination }),
    ...(core.projection === true ? { projection: true } : {}),
    ...(core.leftOutParameters === undefined ? {} : { leftOutParameters: core.leftOutParameters }),
  });
};
