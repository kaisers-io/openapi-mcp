import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// `tools` names the credential each exposed operation's `security`
// requirement expects (components.securitySchemes), so an operator no longer
// has to guess which header to pass via --header-env
// (kaisers-io/openapi-mcp-archive#55, merged from
// kaisers-io/openapi-mcp-archive#83).

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

const runTools = async (
  extra: readonly string[],
): Promise<{ code: number; lines: string[]; errLines: string[] }> => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const ctx = testContext({
    lines,
    errLines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => fixturesDir,
  });
  const code = await run(ctx, [
    'node',
    'openapi-mcp',
    ...extra,
    'tools',
    '--spec',
    'security-schemes.json',
  ]);
  return { code, lines, errLines };
};

describe('tools — security scheme hints', () => {
  it('lists the expected credential per referenced scheme in human mode', async () => {
    const { code, lines } = await runTools([]);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toContain(
      'auth: security scheme "apiKeyHeader" (apiKey in header "X-API-Key") — pass --header-env X-API-Key=<ENV>',
    );
    expect(text).toContain(
      'auth: security scheme "apiKeyQuery" (apiKey in query "api_key") — query-string credentials are not supported',
    );
    expect(text).toContain(
      'auth: security scheme "bearer" (http bearer) — pass --header-env Authorization=<ENV> holding "Bearer <token>"',
    );
    expect(text).toContain('auth: security scheme "cc" (oauth2 clientCredentials)');
  });

  it('carries the same hints, with the referencing tool count, in the JSON envelope', async () => {
    const { code, lines } = await runTools(['--json']);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(lines[0]!) as {
      data: {
        security: {
          scheme: string;
          type: string;
          toolCount: number;
          hint: string;
          reason?: string;
        }[];
      };
    };
    expect(
      envelope.data.security.map((entry) => [
        entry.scheme,
        entry.type,
        entry.toolCount,
        entry.reason ?? null,
      ]),
    ).toEqual([
      ['apiKeyHeader', 'apiKey', 1, null],
      ['apiKeyQuery', 'apiKey', 1, expect.stringContaining('query-string credentials')],
      ['bearer', 'http', 1, null],
      ['cc', 'oauth2', 1, null],
    ]);
  });
});
