import { describe, expect, it } from 'vitest';
import type { NormalizedSpec } from '@kaisers-io/openapi-mcp-core';
import { assertBaseUrlShape, resolveBaseUrl } from '../src/commands/serve.ts';

// M5 Task 11: in-process unit coverage for the base-URL resolution helpers
// serve.ts's action body wires together — the CLI's OWN serve.test.ts/
// serve-http.test.ts suites drive these through a real spawned subprocess
// (v8 coverage instrumentation never sees inside a child process), so this
// file is what actually exercises resolveBaseUrl's/assertBaseUrlShape's own
// branches for the coverage gate, alongside the E2E behavior proof.
const baseSpec: NormalizedSpec = {
  title: 't',
  specVersion: '1',
  openapiVersion: '3.1',
  operations: [],
  omitted: [],
};

describe('resolveBaseUrl', () => {
  it('--base-url wins and is TRUSTED, regardless of the spec', () => {
    const spec: NormalizedSpec = { ...baseSpec, serverUrl: 'https://spec.example/api' };
    const result = resolveBaseUrl(
      'https://operator.example/base',
      spec,
      'https://spec.example/openapi.json',
      false,
    );
    expect(result).toEqual({ url: new URL('https://operator.example/base'), trusted: true });
  });

  it('an ABSOLUTE serverUrl is used as-is, UNTRUSTED', () => {
    const spec: NormalizedSpec = { ...baseSpec, serverUrl: 'https://api.example.com/v1' };
    const result = resolveBaseUrl(undefined, spec, 'https://spec.example/openapi.json', false);
    expect(result).toEqual({ url: new URL('https://api.example.com/v1'), trusted: false });
  });

  it('a RELATIVE serverUrl, spec from a URL, resolves against displaySource', () => {
    const spec: NormalizedSpec = { ...baseSpec, serverUrl: '/v2', serverUrlIsRelative: true };
    const result = resolveBaseUrl(
      undefined,
      spec,
      'https://spec.example/nested/openapi.json',
      false,
    );
    expect(result).toEqual({ url: new URL('https://spec.example/v2'), trusted: false });
  });

  it('an ABSENT serverUrl, spec from a URL, defaults to the spec origin root', () => {
    const result = resolveBaseUrl(
      undefined,
      baseSpec,
      'https://spec.example/nested/openapi.json',
      false,
    );
    expect(result).toEqual({ url: new URL('https://spec.example/'), trusted: false });
  });

  it('a FILE spec with no usable server candidate and no --base-url is a usage error', () => {
    // DisplaySource is a plain local file path in real usage (spec/load.ts:
    // `displaySource: path`), which is not URL-parseable either — but this
    // uses a URL-SHAPED displaySource specifically to isolate the
    // `specSourceIsFile` guard itself from that separate, redundant
    // "displaySource doesn't parse as a URL" fallback below it: with the
    // guard removed, a URL-shaped displaySource WOULD resolve successfully
    // (falling through to the URL-spec branch), so this is a true
    // falsification target for the guard, not for the fallback catch.
    expect(() =>
      resolveBaseUrl(undefined, baseSpec, 'https://example.com/openapi.json', true),
    ).toThrow(/--base-url/u);
  });

  it('a RELATIVE serverUrl on a FILE spec (no override) is ALSO a usage error — a file has no document base to resolve against', () => {
    const spec: NormalizedSpec = { ...baseSpec, serverUrl: '/v2', serverUrlIsRelative: true };
    expect(() => resolveBaseUrl(undefined, spec, 'https://example.com/openapi.json', true)).toThrow(
      /--base-url/u,
    );
  });
});

describe('assertBaseUrlShape', () => {
  it('accepts a plain http(s) origin+path', () => {
    expect(() => assertBaseUrlShape(new URL('https://api.example.com/v1'))).not.toThrow();
    expect(() => assertBaseUrlShape(new URL('http://127.0.0.1:8080/'))).not.toThrow();
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => assertBaseUrlShape(new URL('ftp://api.example.com/'))).toThrow(/scheme/u);
  });

  it('rejects embedded userinfo', () => {
    expect(() => assertBaseUrlShape(new URL('https://user:pass@api.example.com/'))).toThrow(
      /credentials/u,
    );
  });

  it('rejects a query string', () => {
    expect(() => assertBaseUrlShape(new URL('https://api.example.com/?x=1'))).toThrow(/query/u);
  });

  it('rejects a fragment', () => {
    expect(() => assertBaseUrlShape(new URL('https://api.example.com/#frag'))).toThrow(/fragment/u);
  });
});
