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
    expect(hint('digest')).toContain('holding "digest <credentials>"');
    expect(hint('cc')).toContain('(oauth2 clientCredentials)');
    expect(hint('oidc')).toContain('with a token obtained elsewhere');
  });

  it('states explicitly what is unsupported', () => {
    expect(hint('query')).toContain('query-string credentials are not supported');
    expect(hint('code')).toContain('interactive OAuth flows are not supported');
    expect(hint('mtls')).toContain('client certificates are not supported');
    expect(hint('weird')).toContain('unrecognized or malformed');
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
    expect(warnings[0]).toContain('1 exposed operation (e.g. GET /root) require');
    expect(warnings[0]).toContain('--header-env X-API-Key=<ENV>');
    expect(warnings[1]).toContain('GET /either');
    expect(warnings[1]).toContain('; or ');
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
