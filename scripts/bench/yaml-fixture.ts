// The YAML bench fixture (#76): a file spec whose warm start reuses the cached,
// already validated document instead of parsing the YAML again.

// An inline scalar or empty collection, or undefined for a value that needs
// its own indented block
const inlineYaml = (item: unknown): string | undefined => {
  if (item === null || typeof item !== 'object') {
    return JSON.stringify(item);
  }
  if (Array.isArray(item) && item.length === 0) {
    return '[]';
  }
  return Object.keys(item).length === 0 ? '{}' : undefined;
};

// Block-style YAML for the plain JSON values the fixture generators produce.
// Keys and strings are written as JSON strings, which are valid YAML
// double-quoted scalars, so no YAML library is needed here.
export const toYaml = (value: unknown, indent = ''): string => {
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item) => ['-', item])
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        `${JSON.stringify(key)}:`,
        item,
      ]);
  return entries
    .map(([lead, item]) => {
      const inline = inlineYaml(item);
      return inline === undefined
        ? `${indent}${lead}\n${toYaml(item, `${indent}  `)}`
        : `${indent}${lead} ${inline}\n`;
    })
    .join('');
};

// Operations whose responses carry no schema, so no output validator is
// compiled: a start is then mostly reading the spec and generating tools
export const describedSpec = (operationCount: number): Record<string, unknown> => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < operationCount; index += 1) {
    paths[`/reports${String(index)}/{id}`] = {
      get: {
        operationId: `getReport${String(index)}`,
        summary: `Get report ${String(index)}`,
        description: `Returns report ${String(index)} by its identifier. `.repeat(8),
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['csv', 'json'] } },
        ],
        responses: { 200: { description: 'ok' } },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'described', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
  };
};
