import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { OpenapiMcpError, SYSTEM_HEADERS } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { registerApiOptions, resolveApiConfig } from '../src/api-options.ts';
import type { ApiCmdOpts } from '../src/api-options.ts';

// RegisterApiOptions isn't wired into any CLI command yet, so this builds a
// bare standalone Command to exercise the flag registration exactly as a
// real command would use it.
const parseApiCmdOpts = (args: readonly string[]): ApiCmdOpts => {
  const command = registerApiOptions(new Command()).exitOverride();
  command.parse([...args], { from: 'user' });
  return command.opts();
};

const resolve = (args: readonly string[], env: Record<string, string | undefined> = {}) =>
  resolveApiConfig(parseApiCmdOpts(args), testContext({ env }));

const expectUsageError = (fn: () => unknown, messagePart: string): void => {
  try {
    fn();
    expect.unreachable('expected a usage error');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenapiMcpError);
    expect((error as OpenapiMcpError).code).toBe('usage');
    if (messagePart !== '') {
      expect((error as OpenapiMcpError).message).toContain(messagePart);
    }
  }
};

describe('registerApiOptions', () => {
  it('defaults to no headers, a 10MB response cap, and insecure-http disabled', () => {
    const opts = parseApiCmdOpts([]);
    expect(opts.headerEnv).toEqual([]);
    expect(opts.header).toEqual([]);
    expect(opts.maxResponseBytes).toBe('10MB');
    expect(opts.allowInsecureHttp).toBeUndefined();
    expect(opts.baseUrl).toBeUndefined();
  });

  it('collects repeatable --header-env and --header flags in order', () => {
    const opts = parseApiCmdOpts([
      '--header-env',
      'A=ENV_A',
      '--header',
      'X-One:1',
      '--header-env',
      'B=ENV_B',
      '--header',
      'X-Two:2',
    ]);
    expect(opts.headerEnv).toEqual(['A=ENV_A', 'B=ENV_B']);
    expect(opts.header).toEqual(['X-One:1', 'X-Two:2']);
  });

  it('parses --allow-insecure-http and --base-url', () => {
    const opts = parseApiCmdOpts(['--allow-insecure-http', '--base-url', 'https://api.test']);
    expect(opts.allowInsecureHttp).toBe(true);
    expect(opts.baseUrl).toBe('https://api.test');
  });
});

describe('resolveApiConfig — --header-env (secret)', () => {
  it('resolves from the environment and retains envVar', () => {
    const config = resolve(['--header-env', 'Authorization=API_KEY'], {
      API_KEY: 'Bearer abc123',
    });
    expect(config.secretHeaders).toEqual([
      { name: 'Authorization', value: 'Bearer abc123', envVar: 'API_KEY' },
    ]);
  });

  it('fails on a missing env var without echoing anything sensitive', () => {
    expectUsageError(() => resolve(['--header-env', 'Authorization=API_KEY'], {}), 'API_KEY');
  });

  it('fails on an empty env var', () => {
    expectUsageError(
      () => resolve(['--header-env', 'Authorization=API_KEY'], { API_KEY: '' }),
      'API_KEY',
    );
  });

  it('fails on a control character in the resolved value, never echoing it', () => {
    const hostile = `Bearer${String.fromCodePoint(10)}injected`;
    let caught: unknown;
    try {
      resolve(['--header-env', 'Authorization=API_KEY'], { API_KEY: hostile });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).code).toBe('usage');
    expect((caught as OpenapiMcpError).message).not.toContain(hostile);
    expect((caught as OpenapiMcpError).message).not.toContain('injected');
  });

  it('fails on a character above U+00FF in the resolved value, never echoing it', () => {
    const secret = 'Bearer tök€n-value';
    let caught: unknown;
    try {
      resolve(['--header-env', 'Authorization=API_KEY'], { API_KEY: secret });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).code).toBe('usage');
    expect((caught as OpenapiMcpError).message).toContain('API_KEY');
    expect((caught as OpenapiMcpError).message).toContain('above U+00FF');
    expect((caught as OpenapiMcpError).message).not.toContain('tök');
  });

  it('rejects case-insensitive duplicates within the --header-env group', () => {
    expectUsageError(
      () =>
        resolve(['--header-env', 'X-K=ENV_ONE', '--header-env', 'x-k=ENV_TWO'], {
          ENV_ONE: 'a',
          ENV_TWO: 'b',
        }),
      '',
    );
  });
});

describe('resolveApiConfig — --header (static)', () => {
  it('parses a name:value pair split on the first colon', () => {
    const config = resolve(['--header', 'X-Trace:abc']);
    expect(config.staticHeaders).toEqual([{ name: 'X-Trace', value: 'abc' }]);
  });

  it('splits only on the FIRST colon, keeping the rest in the value', () => {
    const config = resolve(['--header', 'X-Trace:abc:def']);
    expect(config.staticHeaders).toEqual([{ name: 'X-Trace', value: 'abc:def' }]);
  });

  it('rejects a header with no colon, without echoing the raw value', () => {
    let caught: unknown;
    try {
      resolve(['--header', 'NoColon']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).code).toBe('usage');
    expect((caught as OpenapiMcpError).message).not.toContain('NoColon');
    expect((caught as OpenapiMcpError).message).toContain('--header');
  });

  it('trims a single run of leading/trailing spaces (RFC 9110 OWS) from the value', () => {
    const config = resolve(['--header', 'X-Trace:  abc ']);
    expect(config.staticHeaders).toEqual([{ name: 'X-Trace', value: 'abc' }]);
  });

  it('rejects a value that is only spaces (empty after trim)', () => {
    expectUsageError(() => resolve(['--header', 'X-Trace:   ']), 'X-Trace');
  });

  it('rejects an invalid header name', () => {
    expectUsageError(() => resolve(['--header', 'Bad Header:v']), 'Bad Header');
  });

  it('rejects a control character in the value', () => {
    const hostile = `v${String.fromCodePoint(10)}injected`;
    expectUsageError(() => resolve(['--header', `X-Trace:${hostile}`]), 'X-Trace');
  });

  // A header value travels as bytes; undici refuses a code point above U+00FF
  // only when the request is sent, as an opaque transport failure on every
  // tool call. Refused at startup instead, naming the header and the rule.
  it('rejects a value with a character above U+00FF at startup, naming the rule', () => {
    expectUsageError(() => resolve(['--header', 'X-Team: Zürich-€']), 'X-Team');
    expectUsageError(() => resolve(['--header', 'X-Team: Zürich-€']), 'above U+00FF');
  });

  it('still accepts a Latin-1 value (U+0080..U+00FF are valid header bytes)', () => {
    const config = resolve(['--header', 'X-Team: Zürich']);
    expect(config.staticHeaders).toContainEqual({ name: 'X-Team', value: 'Zürich' });
  });

  it.each([
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'Set-Cookie',
    'X-Api-Key',
    'X-Auth-Token',
    'X-Session-Id',
    'X-Client-Secret',
    'X-Credential',
    'X-Signature',
    'X-Password',
    'X-Bearer-Token',
    'X-Jwt',
  ])('rejects the sensitive header name %j', (name) => {
    expectUsageError(() => resolve(['--header', `${name}:value`]), name);
  });

  it.each([
    'Host',
    'Content-Length',
    'Content-Type',
    'Connection',
    'Transfer-Encoding',
    'TE',
    'Trailer',
    'Upgrade',
    'Keep-Alive',
    'Proxy-Connection',
    'Expect',
  ])('rejects the hop-by-hop header name %j', (name) => {
    expectUsageError(() => resolve(['--header', `${name}:value`]), name);
  });

  it('rejects case-insensitive duplicates within the --header group', () => {
    expectUsageError(() => resolve(['--header', 'X-K:one', '--header', 'x-k:two']), '');
  });
});

describe('resolveApiConfig — cross-group uniqueness', () => {
  it('rejects the same header name configured via both --header and --header-env', () => {
    expectUsageError(
      () => resolve(['--header', 'X-K:v', '--header-env', 'X-K=ENV'], { ENV: 'secret' }),
      'X-K',
    );
  });

  it('rejects it case-insensitively across groups', () => {
    expectUsageError(
      () => resolve(['--header', 'x-k:v', '--header-env', 'X-K=ENV'], { ENV: 'secret' }),
      'x-k',
    );
  });
});

describe('resolveApiConfig — reservedHeaderNames', () => {
  it('unions lowercased SYSTEM_HEADERS with the configured static and secret names', () => {
    const config = resolve(['--header', 'X-Custom:v', '--header-env', 'X-Sec=ENV'], {
      ENV: 'secret',
    });
    for (const name of SYSTEM_HEADERS) {
      expect(config.reservedHeaderNames.has(name)).toBe(true);
    }
    expect(config.reservedHeaderNames.has('x-custom')).toBe(true);
    expect(config.reservedHeaderNames.has('x-sec')).toBe(true);
    expect(config.reservedHeaderNames.size).toBe(SYSTEM_HEADERS.size + 2);
  });

  it('with no configured headers, equals SYSTEM_HEADERS exactly', () => {
    const config = resolve([]);
    expect(config.reservedHeaderNames).toEqual(new Set(SYSTEM_HEADERS));
  });
});

describe('resolveApiConfig — secretValues', () => {
  it('includes every --header-env value AND every --header value', () => {
    const config = resolve(['--header', 'X-Custom:static-value', '--header-env', 'X-Sec=ENV'], {
      ENV: 'secret-value',
    });
    expect(config.secretValues).toEqual(expect.arrayContaining(['secret-value', 'static-value']));
    expect(config.secretValues).toHaveLength(2);
  });

  it('is empty when no headers are configured', () => {
    expect(resolve([]).secretValues).toEqual([]);
  });

  // A short static --header value (below the redaction variant floor) must
  // not be registered as a secret value: createRedactor throws at startup if
  // a registered secret is a substring of the '[redacted]' marker itself
  // (e.g. "da"), which would turn an entirely legitimate, non-secret value
  // into a startup crash. Skipping short values avoids that footgun and
  // costs no redaction coverage, since values below the 8-char floor get no
  // encoding variants anyway.
  it('does not register a short static --header value (no startup throw, e.g. a value that is a substring of the marker)', () => {
    const config = resolve(['--header', 'Accept-Language:da']);
    expect(config.staticHeaders).toEqual([{ name: 'Accept-Language', value: 'da' }]);
    expect(config.secretValues).toEqual([]);
  });

  it('still registers a long (>= 8 char) static --header value', () => {
    const config = resolve(['--header', 'X-Custom:a-long-static-value']);
    expect(config.secretValues).toEqual(['a-long-static-value']);
  });
});

describe('resolveApiConfig — --base-url', () => {
  it('accepts a bare http(s) URL and stores it verbatim as trusted', () => {
    const config = resolve(['--base-url', 'https://api.example.com/v1']);
    expect(config.baseUrlOverride).toBe('https://api.example.com/v1');
  });

  it('leaves baseUrlOverride undefined when not given', () => {
    const config = resolve([]);
    expect(config.baseUrlOverride).toBeUndefined();
    expect('baseUrlOverride' in config).toBe(false);
  });

  it('rejects an unparsable URL, without echoing the raw value', () => {
    let caught: unknown;
    try {
      resolve(['--base-url', 'not a url']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).message).not.toContain('not a url');
    expect((caught as OpenapiMcpError).message).toContain('--base-url');
  });

  it('rejects a non-http(s) scheme', () => {
    expectUsageError(
      () => resolve(['--base-url', 'ftp://api.example.com']),
      'scheme must be http or https',
    );
  });

  it('rejects userinfo without leaking the username or password', () => {
    let caught: unknown;
    try {
      resolve(['--base-url', 'https://user:pw@host/']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).code).toBe('usage');
    const { message } = caught as OpenapiMcpError;
    expect(message).not.toContain('pw');
    expect(message).not.toContain('user');
    expect(message).toContain('credentials');
  });

  it('rejects a query string without leaking the query value', () => {
    let caught: unknown;
    try {
      resolve(['--base-url', 'https://h/?token=SECRET']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).code).toBe('usage');
    const { message } = caught as OpenapiMcpError;
    expect(message).not.toContain('SECRET');
    expect(message).toContain('query string');
  });

  it('rejects a fragment without echoing it', () => {
    let caught: unknown;
    try {
      resolve(['--base-url', 'https://api.example.com#zzz999']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenapiMcpError);
    expect((caught as OpenapiMcpError).code).toBe('usage');
    const { message } = caught as OpenapiMcpError;
    expect(message).not.toContain('zzz999');
    expect(message).toContain('fragment');
  });
});

describe('resolveApiConfig — --max-response-bytes', () => {
  it('defaults to 10MB in bytes', () => {
    expect(resolve([]).maxResponseBytes).toBe(10 * 1024 * 1024);
  });

  it('parses a KB suffix', () => {
    expect(resolve(['--max-response-bytes', '5KB']).maxResponseBytes).toBe(5 * 1024);
  });

  it('parses a plain byte count with no suffix', () => {
    expect(resolve(['--max-response-bytes', '2048']).maxResponseBytes).toBe(2048);
  });

  it.each(['0', '-5', '10 MB', '10GB', 'MB', '', '10mb'])(
    'rejects the malformed value %j',
    (raw) => {
      expectUsageError(() => resolve(['--max-response-bytes', raw]), '');
    },
  );

  it('rejects a value over the sane ceiling', () => {
    expectUsageError(() => resolve(['--max-response-bytes', '200MB']), '200MB');
  });
});

describe('resolveApiConfig — --allow-insecure-http', () => {
  it('defaults to false', () => {
    expect(resolve([]).allowInsecureHttp).toBe(false);
  });

  it('is true when the flag is passed', () => {
    expect(resolve(['--allow-insecure-http']).allowInsecureHttp).toBe(true);
  });
});

describe('resolveApiConfig — startup budgets', () => {
  it('rejects too many total headers', () => {
    const args: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      args.push('--header', `X-H${index}:v`);
    }
    expectUsageError(() => resolve(args), '');
  });

  it('allows exactly the header count budget', () => {
    const args: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      args.push('--header', `X-H${index}:v`);
    }
    expect(resolve(args).staticHeaders).toHaveLength(32);
  });

  it('rejects a header name over the length budget', () => {
    const longName = `X-${'a'.repeat(255)}`; // 257 chars
    expectUsageError(() => resolve(['--header', `${longName}:v`]), '');
  });

  it('rejects a header value over the length budget', () => {
    const longValue = 'a'.repeat(8193);
    expectUsageError(() => resolve(['--header', `X-Big:${longValue}`]), '');
  });

  it('rejects a header-env value over the length budget', () => {
    const longValue = 'a'.repeat(8193);
    expectUsageError(() => resolve(['--header-env', 'X-Big=ENV'], { ENV: longValue }), 'X-Big');
  });

  it('rejects when the aggregate header byte budget is exceeded', () => {
    const args: string[] = [];
    // 9 headers just under the per-value cap: 9 * (~8010) > 65536, count 9 < 32
    for (let index = 0; index < 9; index += 1) {
      args.push('--header', `X-Agg${index}:${'a'.repeat(8000)}`);
    }
    expectUsageError(() => resolve(args), '');
  });
});
