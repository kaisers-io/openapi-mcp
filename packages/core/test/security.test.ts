import { describe, expect, it } from 'vitest';
import {
  describeSecurityScheme,
  normalizeSpec,
  summarizeSecurity,
  unsatisfiedSecurityWarnings,
} from '../src/index.ts';
import type { NormalizedSpec, SecurityScheme } from '../src/index.ts';

const ok = { '200': { description: 'ok' } };

const specWith = (
  securitySchemes: Record<string, unknown>,
  paths: Record<string, unknown>,
  root?: unknown,
): NormalizedSpec =>
  normalizeSpec(
    {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      components: { securitySchemes },
      ...(root === undefined ? {} : { security: root }),
      paths,
    },
    '3.1',
  );

const schemes = {
  key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  query: { type: 'apiKey', in: 'query', name: 'api_key' },
  cookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
  bearer: { type: 'http', scheme: 'Bearer' },
  basic: { type: 'http', scheme: 'basic' },
  digest: { type: 'http', scheme: 'digest' },
  cc: {
    type: 'oauth2',
    flows: {
      clientCredentials: { tokenUrl: '/oauth/token', scopes: { read: 'r', write: 'w' } },
      authorizationCode: { authorizationUrl: '/a', tokenUrl: '/t', scopes: {} },
    },
  },
  code: {
    type: 'oauth2',
    flows: { authorizationCode: { authorizationUrl: '/a', tokenUrl: '/t' } },
  },
  oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.example/.well-known' },
  mtls: { type: 'mutualTLS' },
  weird: { type: 'kerberos' },
  broken: { type: 'apiKey', in: 'body', name: 'x' },
};

describe('normalizeSpec — securitySchemes / security extraction', () => {
  it('extracts every scheme shape, client-credentials flow included', () => {
    const spec = specWith(schemes, {});
    const byName = new Map(spec.securitySchemes?.map((scheme) => [scheme.name, scheme]));
    expect(byName.get('key')).toEqual({
      name: 'key',
      type: 'apiKey',
      in: 'header',
      paramName: 'X-API-Key',
    });
    expect(byName.get('bearer')).toEqual({ name: 'bearer', type: 'http', scheme: 'bearer' });
    expect(byName.get('cc')).toEqual({
      name: 'cc',
      type: 'oauth2',
      flows: ['clientCredentials', 'authorizationCode'],
      clientCredentials: { tokenUrl: '/oauth/token', scopes: ['read', 'write'] },
    });
    expect(byName.get('code')).toEqual({
      name: 'code',
      type: 'oauth2',
      flows: ['authorizationCode'],
    });
    expect(byName.get('oidc')?.type).toBe('openIdConnect');
    expect(byName.get('mtls')?.type).toBe('mutualTLS');
    expect(byName.get('weird')?.type).toBe('unsupported');
    expect(byName.get('broken')?.type).toBe('unsupported');
  });

  it('omits the fields entirely for a spec without security', () => {
    const spec = normalizeSpec(
      { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} },
      '3.1',
    );
    expect(spec).not.toHaveProperty('securitySchemes');
    expect(spec).not.toHaveProperty('security');
  });

  it('reads root and operation security; a malformed list is "no information", not "no auth"', () => {
    const spec = specWith(
      schemes,
      {
        '/a': { get: { security: [{ key: [] }, {}], responses: ok } },
        '/b': { get: { security: [{ key: 'not-a-list' }], responses: ok } },
        '/c': { get: { security: [], responses: ok } },
      },
      [{ bearer: [] }],
    );
    expect(spec.security).toEqual([{ bearer: [] }]);
    const [opA, opB, opC] = spec.operations;
    expect(opA?.security).toEqual([{ key: [] }, {}]);
    expect(opB).not.toHaveProperty('security');
    expect(opC?.security).toEqual([]);
  });

  it('keeps a scheme literally named __proto__ as a plain requirement key', () => {
    const spec = specWith({}, {}, JSON.parse('[{"__proto__": ["x"]}]'));
    expect(Object.keys(spec.security?.[0] ?? {})).toEqual(['__proto__']);
  });
});

describe('describeSecurityScheme', () => {
  const hint = (name: keyof typeof schemes): string => {
    const scheme = specWith(schemes, {}).securitySchemes?.find((entry) => entry.name === name);
    return describeSecurityScheme(scheme as SecurityScheme);
  };

  it('names the flag that supplies each supported credential', () => {
    expect(hint('key')).toContain('pass --header-env X-API-Key=<ENV>');
    expect(hint('cookie')).toContain('--header-env Cookie=<ENV> holding "sid=<value>"');
    expect(hint('bearer')).toContain('--header-env Authorization=<ENV> holding "Bearer <token>"');
    expect(hint('basic')).toContain('holding "Basic <base64 user:password>"');
    expect(hint('cookie')).toContain('several cookie schemes go into that one Cookie value');
    expect(hint('cc')).toContain('(oauth2 clientCredentials)');
    expect(hint('oidc')).toContain('with a token obtained elsewhere');
  });

  it('states explicitly what is unsupported', () => {
    expect(hint('query')).toContain('query-string credentials are not supported');
    expect(hint('code')).toContain('interactive OAuth flows are not supported');
    expect(hint('mtls')).toContain('client certificates are not supported');
    expect(hint('weird')).toContain('not supported: unknown security scheme type "kerberos"');
    expect(hint('broken')).toContain('not supported: apiKey scheme without a valid "in"');
    expect(hint('digest')).toContain(
      'http digest is a challenge/response scheme and cannot be supplied as a static header',
    );
    expect(hint('digest')).not.toContain('--header-env');
  });

  it('sanitizes hostile spec text in the hint', () => {
    const name = `evil${String.fromCodePoint(0x20_2e)}`;
    const text = describeSecurityScheme({ name, type: 'apiKey', in: 'header', paramName: 'X' });
    expect(text).not.toContain(String.fromCodePoint(0x20_2e));
  });
});

describe('summarizeSecurity / unsatisfiedSecurityWarnings', () => {
  const spec = specWith(
    schemes,
    {
      '/root': { get: { responses: ok } },
      '/either': { get: { security: [{ bearer: [] }, { cc: ['read'] }], responses: ok } },
      '/both': { get: { security: [{ key: [], cookie: [] }], responses: ok } },
      '/optional': { get: { security: [{ query: [] }, {}], responses: ok } },
      '/open': { get: { security: [], responses: ok } },
      '/ghost': { get: { security: [{ ghost: [] }], responses: ok } },
    },
    [{ key: [] }],
  );
  const ops = spec.operations;

  it('counts referencing operations per declared scheme, in declaration order', () => {
    expect(summarizeSecurity(spec, ops).map((entry) => [entry.scheme, entry.toolCount])).toEqual([
      ['key', 2],
      ['query', 1],
      ['cookie', 1],
      ['bearer', 1],
      ['cc', 1],
    ]);
  });

  it('warns per unsatisfied requirement, with an example operation and the hints', () => {
    const warnings = unsatisfiedSecurityWarnings(spec, ops, { headerNames: new Set() });
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('1 exposed operation (e.g. GET /root) requires credentials');
    expect(warnings[0]).toContain('--header-env X-API-Key=<ENV>');
    expect(warnings[1]).toContain('GET /either');
    expect(warnings[1]).toContain('; OR ');
    expect(warnings[3]).toContain('"ghost" is not declared in components.securitySchemes');
    // An optional ({}) alternative and an explicit [] are never warned about.
    expect(warnings.join('\n')).not.toContain('/optional');
    expect(warnings.join('\n')).not.toContain('/open');
  });

  it('a configured header satisfies its scheme; an AND requirement needs every header', () => {
    const warnings = unsatisfiedSecurityWarnings(spec, ops, {
      headerNames: new Set(['x-api-key', 'authorization']),
    });
    // /root (key) and /either (bearer via Authorization) are satisfied;
    // /both still lacks the Cookie header; /ghost is never satisfiable.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('GET /both');
    const all = unsatisfiedSecurityWarnings(spec, ops, {
      headerNames: new Set(['x-api-key', 'authorization', 'cookie']),
    });
    expect(all).toHaveLength(1);
    expect(all[0]).toContain('GET /ghost');
  });

  it('renders one AND group with AND, and two OR alternatives with OR', () => {
    const both = specWith(schemes, { '/x': { get: { responses: ok } } }, [{ key: [], cookie: [] }]);
    const [andWarning] = unsatisfiedSecurityWarnings(both, both.operations, {
      headerNames: new Set(),
    });
    expect(andWarning).toMatch(/all of: security scheme "key" .* AND security scheme "cookie"/u);
    expect(andWarning).not.toContain('OR');

    const either = specWith(schemes, { '/x': { get: { responses: ok } } }, [
      { key: [] },
      { cookie: [] },
    ]);
    const [orWarning] = unsatisfiedSecurityWarnings(either, either.operations, {
      headerNames: new Set(),
    });
    expect(orWarning).toMatch(/security scheme "key" .*; OR security scheme "cookie"/u);
    expect(orWarning).not.toContain('AND');
  });

  it('never reports an AND of two Authorization-based schemes as satisfied by one header', () => {
    const spec2 = specWith(schemes, { '/c': { get: { responses: ok } } }, [{ bearer: [], cc: [] }]);
    const warnings = unsatisfiedSecurityWarnings(spec2, spec2.operations, {
      headerNames: new Set(['authorization']),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'cannot be met: 2 schemes each need the one Authorization header',
    );
  });

  it('several cookie schemes in one alternative are satisfied by the one Cookie header', () => {
    const cookies = specWith(
      { ...schemes, csrf: { type: 'apiKey', in: 'cookie', name: 'csrf' } },
      { '/x': { get: { responses: ok } } },
      [{ cookie: [], csrf: [] }],
    );
    expect(
      unsatisfiedSecurityWarnings(cookies, cookies.operations, {
        headerNames: new Set(['cookie']),
      }),
    ).toEqual([]);
  });

  it('does not recommend a header name that cannot be sent, nor a challenge/response scheme', () => {
    const odd = specWith(
      { spaced: { type: 'apiKey', in: 'header', name: 'api key' }, digest: schemes.digest },
      { '/x': { get: { responses: ok } } },
      [{ spaced: [] }, { digest: [] }],
    );
    const [warning] = unsatisfiedSecurityWarnings(odd, odd.operations, {
      headerNames: new Set(['api key', 'authorization']),
    });
    expect(warning).toContain('this header name cannot be sent');
    expect(warning).not.toContain('--header-env api key');
    expect(warning).toContain('http digest is a challenge/response scheme');
    const summary = summarizeSecurity(odd, odd.operations);
    expect(summary.map((entry) => entry.reason !== undefined)).toEqual([true, true]);
  });

  it('carries a reason for every scheme that cannot be supplied, and none otherwise', () => {
    const all = specWith(schemes, { '/x': { get: { responses: ok } } }, [
      Object.fromEntries(Object.keys(schemes).map((name) => [name, []])),
    ]);
    const reasons = Object.fromEntries(
      summarizeSecurity(all, all.operations).map((entry) => [entry.scheme, entry.reason]),
    );
    expect(reasons).toEqual({
      key: undefined,
      query: expect.stringContaining('query-string'),
      cookie: undefined,
      bearer: undefined,
      basic: undefined,
      digest: expect.stringContaining('challenge/response'),
      cc: undefined,
      code: undefined,
      oidc: undefined,
      mtls: 'client certificates are not supported',
      weird: 'unknown security scheme type "kerberos"',
      broken: expect.stringContaining('apiKey scheme without'),
    });
  });

  it('groups operations sharing one requirement into a single warning', () => {
    const shared = specWith(
      schemes,
      { '/a': { get: { responses: ok } }, '/b': { get: { responses: ok } } },
      [{ key: [] }],
    );
    const warnings = unsatisfiedSecurityWarnings(shared, shared.operations, {
      headerNames: new Set(),
    });
    expect(warnings).toEqual([expect.stringContaining('2 exposed operations (e.g. GET /a)')]);
  });
});
