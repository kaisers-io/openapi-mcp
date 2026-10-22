import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/index.ts';
import type { OutboundBudgets, RequestMapper } from '../src/index.ts';

const budgets: OutboundBudgets = {
  maxUrlLength: 8192,
  maxHeaderBytes: 16_384,
  maxBodyBytes: 65_536,
};

// An unpaired UTF-16 surrogate: valid as a JS string but `encodeURIComponent`
// throws a URIError on it. Used to exercise the encode-failure branch of
// `encodeLeaf`, distinct from the value-shape guard.
const LONE_SURROGATE = String.fromCodePoint(0xd8_00);

const ok = (result: ReturnType<typeof buildRequest>) => {
  if (!('ok' in result)) {
    throw new Error(`expected ok, got error: ${result.error}`);
  }
  return result.ok;
};

const err = (result: ReturnType<typeof buildRequest>): string => {
  if ('ok' in result) {
    throw new Error('expected an error, got ok');
  }
  return result.error;
};

// A minimal mapper with a single path field, used by most path-serialization
// tests below.
const pathMapper = (explode = false): RequestMapper => ({
  bodyMode: 'none',
  fields: {
    petId: { destination: 'path', wireName: 'petId', style: 'simple', explode, required: true },
  },
});

describe('buildRequest — path/simple', () => {
  it('percent-encodes a primitive path value', () => {
    const built = ok(buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId: 'a b' }, budgets));
    expect(built.pathname).toBe('/pets/a%20b');
  });

  it('serializes an exploded array as comma-joined (simple ignores explode for arrays)', () => {
    const built = ok(
      buildRequest(pathMapper(true), 'get', '/pets/{petId}', { petId: [3, 4, 5] }, budgets),
    );
    expect(built.pathname).toBe('/pets/3,4,5');
  });

  it('serializes a non-exploded array as comma-joined', () => {
    const built = ok(
      buildRequest(pathMapper(false), 'get', '/pets/{petId}', { petId: [3, 4, 5] }, budgets),
    );
    expect(built.pathname).toBe('/pets/3,4,5');
  });

  it('serializes an object with explode=false as a flat k,v,k,v list', () => {
    const built = ok(
      buildRequest(
        pathMapper(false),
        'get',
        '/pets/{petId}',
        { petId: { role: 'admin', firstName: 'Alex' } },
        budgets,
      ),
    );
    expect(built.pathname).toBe('/pets/role,admin,firstName,Alex');
  });

  it('serializes an object with explode=true as k=v pairs', () => {
    const built = ok(
      buildRequest(
        pathMapper(true),
        'get',
        '/pets/{petId}',
        { petId: { role: 'admin', firstName: 'Alex' } },
        budgets,
      ),
    );
    expect(built.pathname).toBe('/pets/role=admin,firstName=Alex');
  });

  it.each([['.'], ['..'], ['../admin'], ['a/b'], ['%2e%2e'], ['x%2Fy'], ['x%5Cy'], ['a\\b']])(
    'rejects a traversal/separator-bearing path leaf: %s',
    (petId) => {
      const message = err(buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId }, budgets));
      expect(message).toMatch(/petId/u);
    },
  );

  it.each([['.%2e'], ['%2e.'], ['.%2E'], ['%2E.'], ['%2e'], ['%2E'], ['a.%2eb'], ['x%2e.y']])(
    'rejects a mixed-encoded dot segment (double-decodes to . or ..): %s',
    (petId) => {
      const message = err(buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId }, budgets));
      // Names the encoded dot, so a caller with a legitimate value (the
      // deliberate a.%2eb false positive) can tell why it was refused, and
      // says that nothing reached the upstream
      expect(message).toBe(
        'path parameter "petId" was refused: it contains a path separator or dot-segment (/, \\, . or .., or an encoded slash or dot such as %2F, %5C or %2E). No request was sent; pass the value without them',
      );
    },
  );

  it.each([['v1..v2'], ['file.tar.gz'], ['a%2eb'], ['...']])(
    'still accepts a leaf whose dots cannot form an encoded dot segment: %s',
    (petId) => {
      const built = buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId }, budgets);
      expect(ok(built).pathname).toMatch(/^\/pets\//u);
    },
  );

  it('rejects a traversal element inside an array path leaf', () => {
    const message = err(
      buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId: ['ok', '../admin'] }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });

  it('rejects an empty required path value', () => {
    const message = err(buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId: '' }, budgets));
    expect(message).toMatch(/petId/u);
  });

  it('rejects a missing required path value', () => {
    const message = err(buildRequest(pathMapper(), 'get', '/pets/{petId}', {}, budgets));
    expect(message).toMatch(/petId/u);
  });

  it('rejects a null required path value', () => {
    const message = err(
      buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId: null }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });

  it('rejects a nested object in a path field (value-shape guard)', () => {
    const message = err(
      buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId: { a: { b: 1 } } }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });

  it('rejects an array-of-objects in a path field (value-shape guard)', () => {
    const message = err(
      buildRequest(pathMapper(), 'get', '/pets/{petId}', { petId: [{ a: 1 }] }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });
});

describe('buildRequest — query/form', () => {
  const queryMapper = (explode: boolean): RequestMapper => ({
    bodyMode: 'none',
    fields: {
      id: { destination: 'query', wireName: 'id', style: 'form', explode, required: false },
    },
  });

  it('serializes a primitive', () => {
    const built = ok(buildRequest(queryMapper(true), 'get', '/x', { id: 5 }, budgets));
    expect(built.query).toBe('id=5');
  });

  it('explode=true array -> repeated key', () => {
    const built = ok(buildRequest(queryMapper(true), 'get', '/x', { id: [3, 4, 5] }, budgets));
    expect(built.query).toBe('id=3&id=4&id=5');
  });

  it('explode=false array -> comma-joined single key', () => {
    const built = ok(buildRequest(queryMapper(false), 'get', '/x', { id: [3, 4, 5] }, budgets));
    expect(built.query).toBe('id=3,4,5');
  });

  it('explode=true object -> pairs, wireName disappears', () => {
    const built = ok(
      buildRequest(
        queryMapper(true),
        'get',
        '/x',
        { id: { role: 'admin', firstName: 'Alex' } },
        budgets,
      ),
    );
    expect(built.query).toBe('role=admin&firstName=Alex');
  });

  it('explode=false object -> a single key, flat k,v,k,v list', () => {
    const built = ok(
      buildRequest(
        queryMapper(false),
        'get',
        '/x',
        { id: { role: 'admin', firstName: 'Alex' } },
        budgets,
      ),
    );
    expect(built.query).toBe('id=role,admin,firstName,Alex');
  });

  it('percent-encodes space as %20, not "+", and does not over-encode as URLSearchParams would', () => {
    const built = ok(buildRequest(queryMapper(true), 'get', '/x', { id: 'a b~c' }, budgets));
    expect(built.query).toBe('id=a%20b~c');
  });

  it('omits an absent optional query param entirely', () => {
    const built = ok(buildRequest(queryMapper(true), 'get', '/x', {}, budgets));
    expect(built.query).toBe('');
  });

  it('omits a null optional query param entirely', () => {
    const built = ok(buildRequest(queryMapper(true), 'get', '/x', { id: null }, budgets));
    expect(built.query).toBe('');
  });

  it('rejects a null required query param', () => {
    const requiredMapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        id: { destination: 'query', wireName: 'id', style: 'form', explode: true, required: true },
      },
    };
    const message = err(buildRequest(requiredMapper, 'get', '/x', { id: null }, budgets));
    expect(message).toMatch(/id/u);
  });

  it('rejects a nested object in a query field (value-shape guard)', () => {
    const message = err(
      buildRequest(queryMapper(true), 'get', '/x', { id: { a: { b: 1 } } }, budgets),
    );
    expect(message).toMatch(/id/u);
  });

  it('rejects an array-of-objects in a query field (value-shape guard)', () => {
    const message = err(buildRequest(queryMapper(true), 'get', '/x', { id: [{ a: 1 }] }, budgets));
    expect(message).toMatch(/id/u);
  });

  it('detects a form,explode=true object key collision between two fields', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        obj: {
          destination: 'query',
          wireName: 'obj',
          style: 'form',
          explode: true,
          required: false,
        },
        role: {
          destination: 'query',
          wireName: 'role',
          style: 'form',
          explode: true,
          required: false,
        },
      },
    };
    const message = err(
      buildRequest(mapper, 'get', '/x', { obj: { role: 'admin' }, role: 'user' }, budgets),
    );
    expect(message).toMatch(/role/u);
  });
});

describe('buildRequest — header/simple', () => {
  const headerMapper = (explode: boolean): RequestMapper => ({
    bodyMode: 'none',
    fields: {
      'x-trace': {
        destination: 'header',
        wireName: 'X-Trace',
        style: 'simple',
        explode,
        required: false,
      },
    },
  });

  it('does not percent-encode a header value', () => {
    const built = ok(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': 'a b~c' }, budgets),
    );
    expect(built.headers['x-trace']).toBe('a b~c');
  });

  it('lowercases the header name', () => {
    const built = ok(buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': 'v' }, budgets));
    expect(Object.keys(built.headers)).toEqual(['x-trace']);
  });

  it.each([['price 5€'], ['naïve ✓'], ['日本'], ['emoji 😀']])(
    'rejects a header value with a character above U+00FF with a specific argument error: %s',
    (value) => {
      const message = err(
        buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': value }, budgets),
      );
      expect(message).toBe(
        'header parameter "X-Trace" was refused: it contains a character above U+00FF, which an HTTP header cannot carry. No request was sent; use Latin-1 text only (ASCII is safest)',
      );
    },
  );

  it('still accepts Latin-1 header characters (U+0080..U+00FF are valid header bytes)', () => {
    const built = ok(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': 'café ÿ' }, budgets),
    );
    expect(built.headers['x-trace']).toBe('café ÿ');
  });

  it('rejects a CR/LF-bearing header value', () => {
    const crlf = `bad${String.fromCodePoint(13, 10)}injected: 1`;
    const message = err(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': crlf }, budgets),
    );
    expect(message).toMatch(/x-trace/iu);
  });

  it('rejects a control-character-bearing header value', () => {
    const control = `bad${String.fromCodePoint(7)}bell`;
    const message = err(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': control }, budgets),
    );
    expect(message).toMatch(/x-trace/iu);
  });

  it('comma-joins an array header value', () => {
    const built = ok(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': ['a', 'b', 'c'] }, budgets),
    );
    expect(built.headers['x-trace']).toBe('a,b,c');
  });

  it('rejects an ambiguous delimiter-bearing array element', () => {
    const message = err(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': ['a,b', 'c'] }, budgets),
    );
    expect(message).toMatch(/x-trace/iu);
  });

  it('rejects an ambiguous "=" in an exploded object element', () => {
    const message = err(
      buildRequest(headerMapper(true), 'get', '/x', { 'x-trace': { 'a=b': 'c' } }, budgets),
    );
    expect(message).toMatch(/x-trace/iu);
  });

  it('serializes an object with explode=false as a flat k,v,k,v list', () => {
    const built = ok(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': { role: 'admin' } }, budgets),
    );
    expect(built.headers['x-trace']).toBe('role,admin');
  });

  it('serializes an object with explode=true as k=v pairs', () => {
    const built = ok(
      buildRequest(headerMapper(true), 'get', '/x', { 'x-trace': { role: 'admin' } }, budgets),
    );
    expect(built.headers['x-trace']).toBe('role=admin');
  });

  it('rejects a nested object in a header field (value-shape guard)', () => {
    const message = err(
      buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': { a: { b: 1 } } }, budgets),
    );
    expect(message).toMatch(/x-trace/iu);
  });

  it('omits an absent optional header', () => {
    const built = ok(buildRequest(headerMapper(false), 'get', '/x', {}, budgets));
    expect(built.headers).toEqual({});
  });

  it('omits a null optional header', () => {
    const built = ok(buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': null }, budgets));
    expect(built.headers).toEqual({});
  });

  it('accepts a valid RFC 9110 token wireName', () => {
    const built = ok(buildRequest(headerMapper(false), 'get', '/x', { 'x-trace': 'v' }, budgets));
    expect(built.headers['x-trace']).toBe('v');
  });
});

describe('buildRequest — header wireName validation (spec-derived, untrusted)', () => {
  // A hostile spec could declare a header parameter whose NAME itself carries
  // an embedded CRLF; undici throws at fetch time on such a key, which would
  // otherwise escape this module's fail-closed `{error}` contract.
  const wireNameMapper = (wireName: string): RequestMapper => ({
    bodyMode: 'none',
    fields: {
      'x-trace': {
        destination: 'header',
        wireName,
        style: 'simple',
        explode: false,
        required: false,
      },
    },
  });

  it('rejects a CR/LF-bearing header wireName', () => {
    const injected = `X-Foo${String.fromCodePoint(13, 10)}Evil`;
    const message = err(
      buildRequest(wireNameMapper(injected), 'get', '/x', { 'x-trace': 'v' }, budgets),
    );
    expect(message).toMatch(/invalid header name/iu);
  });

  it('rejects a space-bearing header wireName', () => {
    const message = err(
      buildRequest(wireNameMapper('X Foo'), 'get', '/x', { 'x-trace': 'v' }, budgets),
    );
    expect(message).toMatch(/invalid header name/iu);
  });

  it('rejects a control-character-bearing header wireName', () => {
    const injected = `X-Foo${String.fromCodePoint(7)}`;
    const message = err(
      buildRequest(wireNameMapper(injected), 'get', '/x', { 'x-trace': 'v' }, budgets),
    );
    expect(message).toMatch(/invalid header name/iu);
  });

  it('accepts a valid token wireName', () => {
    const built = ok(
      buildRequest(wireNameMapper('X-Trace-Id'), 'get', '/x', { 'x-trace': 'v' }, budgets),
    );
    expect(built.headers['x-trace-id']).toBe('v');
  });
});

describe('buildRequest — body', () => {
  it('reassembles a flattened body via bodyPath, JSON-stringified', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        name: { destination: 'body', bodyPath: ['name'], required: true },
        age: { destination: 'body', bodyPath: ['age'], required: false },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', { name: 'Rex', age: 3 }, budgets));
    expect(built.contentType).toBe('application/json');
    expect(built.body).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(built.body))).toEqual({ name: 'Rex', age: 3 });
  });

  it('omits an absent optional flattened field', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        name: { destination: 'body', bodyPath: ['name'], required: true },
        age: { destination: 'body', bodyPath: ['age'], required: false },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', { name: 'Rex' }, budgets));
    expect(JSON.parse(new TextDecoder().decode(built.body))).toEqual({ name: 'Rex' });
  });

  it('sends the single body field as-is', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', { body: [1, 2, 3] }, budgets));
    expect(JSON.parse(new TextDecoder().decode(built.body))).toEqual([1, 2, 3]);
  });

  it('sends no body when bodyMode is none', () => {
    const mapper: RequestMapper = { bodyMode: 'none', fields: {} };
    const built = ok(buildRequest(mapper, 'post', '/pets', {}, budgets));
    expect(built.body).toBeUndefined();
    expect(built.contentType).toBeUndefined();
  });

  it('sends no body when the optional body group is entirely absent', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        name: { destination: 'body', bodyPath: ['name'], required: false },
        age: { destination: 'body', bodyPath: ['age'], required: false },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', {}, budgets));
    expect(built.body).toBeUndefined();
    expect(built.contentType).toBeUndefined();
  });

  it('never attaches a body on GET even when the mapper has body fields', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const built = ok(buildRequest(mapper, 'get', '/pets', { body: { a: 1 } }, budgets));
    expect(built.body).toBeUndefined();
    expect(built.contentType).toBeUndefined();
  });

  it('never attaches a body on HEAD even when the mapper has body fields', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const built = ok(buildRequest(mapper, 'HEAD', '/pets', { body: { a: 1 } }, budgets));
    expect(built.body).toBeUndefined();
  });

  it('serializes a form-urlencoded body with URLSearchParams', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/x-www-form-urlencoded',
      fields: {
        name: { destination: 'body', bodyPath: ['name'], required: true },
        age: { destination: 'body', bodyPath: ['age'], required: false },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', { name: 'Rex', age: 3 }, budgets));
    expect(built.contentType).toBe('application/x-www-form-urlencoded');
    expect(new TextDecoder().decode(built.body)).toBe('name=Rex&age=3');
  });

  it('rejects a non-scalar value in a form-urlencoded body', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/x-www-form-urlencoded',
      fields: {
        tags: { destination: 'body', bodyPath: ['tags'], required: true },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { tags: ['a', 'b'] }, budgets));
    expect(message).toMatch(/tags/u);
  });

  it('rejects a missing required single body', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', {}, budgets));
    expect(message).toMatch(/body/iu);
  });

  // `JSON.stringify` throws on a bigint, a circular reference, or a throwing
  // `toJSON` — this module must catch that and fail closed with `{error}`
  // rather than let the throw escape its never-throw contract.
  it('rejects a JSON body containing a bigint (JSON.stringify throws)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { body: 1n }, budgets));
    expect(message).toMatch(/serialized/iu);
  });

  it('rejects a JSON body with a throwing toJSON (JSON.stringify throws)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        thing: { destination: 'body', bodyPath: ['thing'], required: true },
      },
    };
    const hostile = {
      toJSON() {
        throw new Error('boom');
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { thing: hostile }, budgets));
    expect(message).toMatch(/serialized/iu);
  });
});

describe('buildRequest — outbound budgets', () => {
  it('rejects an over-long URL', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        petId: {
          destination: 'path',
          wireName: 'petId',
          style: 'simple',
          explode: false,
          required: true,
        },
      },
    };
    const tinyBudgets: OutboundBudgets = {
      maxUrlLength: 10,
      maxHeaderBytes: 16_384,
      maxBodyBytes: 65_536,
    };
    const message = err(
      buildRequest(
        mapper,
        'get',
        '/pets/{petId}',
        { petId: 'a-very-long-identifier' },
        tinyBudgets,
      ),
    );
    expect(message).toMatch(/url/iu);
  });

  it('rejects over-large aggregate headers', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        'x-trace': {
          destination: 'header',
          wireName: 'X-Trace',
          style: 'simple',
          explode: false,
          required: false,
        },
      },
    };
    const tinyBudgets: OutboundBudgets = {
      maxUrlLength: 8192,
      maxHeaderBytes: 8,
      maxBodyBytes: 65_536,
    };
    const message = err(
      buildRequest(
        mapper,
        'get',
        '/x',
        { 'x-trace': 'a much longer header value than 8 bytes' },
        tinyBudgets,
      ),
    );
    expect(message).toMatch(/header/iu);
  });

  it('rejects an over-large body', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const tinyBudgets: OutboundBudgets = {
      maxUrlLength: 8192,
      maxHeaderBytes: 16_384,
      maxBodyBytes: 8,
    };
    const message = err(
      buildRequest(
        mapper,
        'post',
        '/pets',
        { body: { a: 'much more than eight bytes' } },
        tinyBudgets,
      ),
    );
    expect(message).toMatch(/body/iu);
  });
});

describe('buildRequest — value-shape guard on non-object/array/primitive values', () => {
  const symbolPathMapper: RequestMapper = {
    bodyMode: 'none',
    fields: {
      petId: {
        destination: 'path',
        wireName: 'petId',
        style: 'simple',
        explode: false,
        required: true,
      },
    },
  };

  it('rejects a symbol value (neither primitive, array, nor plain object)', () => {
    const message = err(
      buildRequest(symbolPathMapper, 'get', '/pets/{petId}', { petId: Symbol('x') }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });
});

describe('buildRequest — encode-failure branch (lone surrogate)', () => {
  it('rejects a path primitive that cannot be percent-encoded', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        petId: {
          destination: 'path',
          wireName: 'petId',
          style: 'simple',
          explode: false,
          required: true,
        },
      },
    };
    const message = err(
      buildRequest(mapper, 'get', '/pets/{petId}', { petId: LONE_SURROGATE }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });

  it('rejects a path object key that is a traversal string (object key branch)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        petId: {
          destination: 'path',
          wireName: 'petId',
          style: 'simple',
          explode: false,
          required: true,
        },
      },
    };
    const message = err(
      buildRequest(mapper, 'get', '/pets/{petId}', { petId: { '..': 'admin' } }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });

  it('rejects a path object value that is a traversal string (object value branch)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        petId: {
          destination: 'path',
          wireName: 'petId',
          style: 'simple',
          explode: false,
          required: true,
        },
      },
    };
    const message = err(
      buildRequest(mapper, 'get', '/pets/{petId}', { petId: { role: '../admin' } }, budgets),
    );
    expect(message).toMatch(/petId/u);
  });

  it('rejects a query field whose wireName cannot be percent-encoded', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        id: {
          destination: 'query',
          wireName: LONE_SURROGATE,
          style: 'form',
          explode: true,
          required: false,
        },
      },
    };
    const message = err(buildRequest(mapper, 'get', '/x', { id: 'v' }, budgets));
    expect(message).toMatch(/query/u);
  });

  it('rejects a query primitive value that cannot be percent-encoded', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        id: { destination: 'query', wireName: 'id', style: 'form', explode: true, required: false },
      },
    };
    const message = err(buildRequest(mapper, 'get', '/x', { id: LONE_SURROGATE }, budgets));
    expect(message).toMatch(/id/u);
  });

  it('rejects a query array element that cannot be percent-encoded', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        id: { destination: 'query', wireName: 'id', style: 'form', explode: true, required: false },
      },
    };
    const message = err(buildRequest(mapper, 'get', '/x', { id: ['ok', LONE_SURROGATE] }, budgets));
    expect(message).toMatch(/id/u);
  });

  it.each([true, false])(
    'rejects a query object KEY that cannot be percent-encoded (explode=%s)',
    (explode) => {
      const mapper: RequestMapper = {
        bodyMode: 'none',
        fields: {
          id: { destination: 'query', wireName: 'id', style: 'form', explode, required: false },
        },
      };
      const message = err(
        buildRequest(mapper, 'get', '/x', { id: { [LONE_SURROGATE]: 'v' } }, budgets),
      );
      expect(message).toMatch(/id/u);
    },
  );

  it.each([true, false])(
    'rejects a query object VALUE that cannot be percent-encoded (explode=%s)',
    (explode) => {
      const mapper: RequestMapper = {
        bodyMode: 'none',
        fields: {
          id: { destination: 'query', wireName: 'id', style: 'form', explode, required: false },
        },
      };
      const message = err(
        buildRequest(mapper, 'get', '/x', { id: { role: LONE_SURROGATE } }, budgets),
      );
      expect(message).toMatch(/id/u);
    },
  );
});

describe('buildRequest — header object value-side ambiguous delimiter', () => {
  it('rejects an exploded object VALUE containing "="', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        'x-trace': {
          destination: 'header',
          wireName: 'X-Trace',
          style: 'simple',
          explode: true,
          required: false,
        },
      },
    };
    const message = err(buildRequest(mapper, 'get', '/x', { 'x-trace': { role: 'a=b' } }, budgets));
    expect(message).toMatch(/x-trace/iu);
  });

  it('rejects a non-exploded object VALUE containing ","', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        'x-trace': {
          destination: 'header',
          wireName: 'X-Trace',
          style: 'simple',
          explode: false,
          required: false,
        },
      },
    };
    const message = err(buildRequest(mapper, 'get', '/x', { 'x-trace': { role: 'a,b' } }, budgets));
    expect(message).toMatch(/x-trace/iu);
  });
});

describe('buildRequest — path template / defensive invariants', () => {
  it('rejects a path field with no matching template placeholder', () => {
    const mapper: RequestMapper = {
      bodyMode: 'none',
      fields: {
        petId: {
          destination: 'path',
          wireName: 'petId',
          style: 'simple',
          explode: false,
          required: true,
        },
      },
    };
    const message = err(buildRequest(mapper, 'get', '/pets/{other}', { petId: '5' }, budgets));
    expect(message).toMatch(/petId/u);
  });
});

describe('buildRequest — body reassembly defensive invariants', () => {
  it('rejects a flattened body field with an empty bodyPath', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        x: { destination: 'body', bodyPath: [], required: false },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { x: 'v' }, budgets));
    expect(message).toMatch(/x/u);
  });

  it('rejects a dangerous intermediate bodyPath segment (prototype pollution guard)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        x: { destination: 'body', bodyPath: ['__proto__', 'y'], required: false },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { x: 'v' }, budgets));
    expect(message).toMatch(/x/u);
  });

  it('rejects a dangerous final bodyPath segment (prototype pollution guard)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        x: { destination: 'body', bodyPath: ['a', 'constructor'], required: false },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { x: 'v' }, budgets));
    expect(message).toMatch(/x/u);
  });

  it('reassembles a two-level nested bodyPath, reusing an already-built parent object', () => {
    const mapper: RequestMapper = {
      bodyMode: 'flattened',
      bodyContentType: 'application/json',
      fields: {
        first: { destination: 'body', bodyPath: ['parent', 'first'], required: false },
        second: { destination: 'body', bodyPath: ['parent', 'second'], required: false },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', { first: 1, second: 2 }, budgets));
    expect(JSON.parse(new TextDecoder().decode(built.body))).toEqual({
      parent: { first: 1, second: 2 },
    });
  });

  it('skips an explicit undefined property in a single-mode form-urlencoded body', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/x-www-form-urlencoded',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const built = ok(
      buildRequest(mapper, 'post', '/pets', { body: { a: 'x', b: undefined } }, budgets),
    );
    expect(new TextDecoder().decode(built.body)).toBe('a=x');
  });

  it('rejects a mapper missing a body content type (invariant violation)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { body: 'v' }, budgets));
    expect(message).toMatch(/content type/iu);
  });

  it('rejects a single-mode mapper with no body-destination field (invariant violation)', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {},
    };
    const message = err(buildRequest(mapper, 'post', '/pets', {}, budgets));
    expect(message).toMatch(/single body/iu);
  });

  it('sends no body when an optional single-mode body is absent', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/json',
      fields: {
        body: { destination: 'body', bodyPath: [], required: false },
      },
    };
    const built = ok(buildRequest(mapper, 'post', '/pets', {}, budgets));
    expect(built.body).toBeUndefined();
  });

  it('rejects a non-object single-mode form-urlencoded body', () => {
    const mapper: RequestMapper = {
      bodyMode: 'single',
      bodyContentType: 'application/x-www-form-urlencoded',
      fields: {
        body: { destination: 'body', bodyPath: [], required: true },
      },
    };
    const message = err(buildRequest(mapper, 'post', '/pets', { body: 'just a string' }, budgets));
    expect(message).toMatch(/object/iu);
  });
});

// #54 / D5: the declared media type (with parameters) is what is sent, and
// every JSON variant is JSON-encoded.
describe('buildRequest — declared JSON media-type variants (#54)', () => {
  const mapperFor = (bodyContentType: string): RequestMapper => ({
    bodyMode: 'flattened',
    bodyContentType,
    fields: { name: { destination: 'body', bodyPath: ['name'], required: true } },
  });

  it.each([
    'application/merge-patch+json',
    'application/json; charset=utf-8',
    'application/vnd.api+json',
  ])('sends Content-Type %s with a JSON body', (contentType) => {
    const built = ok(buildRequest(mapperFor(contentType), 'patch', '/x', { name: 'n' }, budgets));
    expect(built.contentType).toBe(contentType);
    expect(JSON.parse(new TextDecoder().decode(built.body))).toEqual({ name: 'n' });
  });

  it('fails closed on a mapper content type that is neither JSON nor form', () => {
    const result = buildRequest(mapperFor('text/plain'), 'post', '/x', { name: 'n' }, budgets);
    expect(err(result)).toMatch(/content type/iu);
  });
});

// #59: OAS 3.1.1 §4.8.12.4 Style Examples — brackets and delimiters are
// percent-encoded exactly as in the spec's examples.
describe('buildRequest — query deepObject / spaceDelimited / pipeDelimited (#59)', () => {
  const styled = (
    style: 'deepObject' | 'spaceDelimited' | 'pipeDelimited',
    explode: boolean,
  ): RequestMapper => ({
    bodyMode: 'none',
    fields: {
      created: { destination: 'query', wireName: 'created', style, explode, required: false },
    },
  });
  const run = (
    style: 'deepObject' | 'spaceDelimited' | 'pipeDelimited',
    explode: boolean,
    created: unknown,
  ) => buildRequest(styled(style, explode), 'get', '/x', { created }, budgets);

  it('deepObject: name[key]=value with encoded brackets', () => {
    const built = ok(run('deepObject', true, { gt: 1, lte: 5 }));
    expect(built.query).toBe('created%5Bgt%5D=1&created%5Blte%5D=5');
  });

  it('deepObject: keys and values containing &, =, # are percent-encoded', () => {
    const built = ok(run('deepObject', true, { 'a&b=': 'x#y&z=1' }));
    expect(built.query).toBe('created%5Ba%26b%3D%5D=x%23y%26z%3D1');
  });

  it('deepObject: a nested value or a non-object value fails closed', () => {
    expect(err(run('deepObject', true, { gt: { a: 1 } }))).toMatch(/cannot be serialized/u);
    expect(err(run('deepObject', true, 'x'))).toMatch(/deepObject/u);
  });

  it('pipeDelimited: array joined with %7C; spaceDelimited with %20', () => {
    expect(ok(run('pipeDelimited', false, ['a', 'b'])).query).toBe('created=a%7Cb');
    expect(ok(run('spaceDelimited', false, ['a', 'b'])).query).toBe('created=a%20b');
  });

  it('delimited object: k, v, k, v sequence', () => {
    expect(ok(run('pipeDelimited', false, { R: 100, G: 200 })).query).toBe(
      'created=R%7C100%7CG%7C200',
    );
  });

  it('delimited: a value containing its own delimiter is rejected as ambiguous', () => {
    expect(err(run('pipeDelimited', false, ['a|b', 'c']))).toMatch(/delimiter/u);
    expect(err(run('spaceDelimited', false, ['a b']))).toMatch(/delimiter/u);
  });

  it('delimited: other reserved characters are still encoded', () => {
    expect(ok(run('pipeDelimited', false, ['a&b', 'c=#'])).query).toBe('created=a%26b%7Cc%3D%23');
  });

  it.each(['a][b', 'a[0]', ']', '[', 'a['])(
    'deepObject: a key %j containing a bracket is rejected as ambiguous with nesting',
    (key) => {
      expect(err(run('deepObject', true, { [key]: 'v', ok: 1 }))).toMatch(
        /key containing "\[" or "\]"/u,
      );
    },
  );

  it('delimited: an empty array or object is omitted, like form', () => {
    expect(ok(run('pipeDelimited', false, [])).query).toBe('');
    expect(ok(run('spaceDelimited', false, [])).query).toBe('');
    expect(ok(run('pipeDelimited', false, {})).query).toBe('');
  });
});

// #40: a REQUIRED body whose flattened properties are all optional and all
// absent is still sent — as an empty object — instead of silently dropped.
describe('buildRequest — required empty body (#40)', () => {
  const mapper = (bodyContentType: string, bodyRequired: boolean): RequestMapper => ({
    bodyMode: 'flattened',
    bodyContentType,
    ...(bodyRequired ? { bodyRequired: true } : {}),
    fields: { note: { destination: 'body', bodyPath: ['note'], required: false } },
  });

  it('sends {} with the JSON content type when the body is required', () => {
    const built = ok(buildRequest(mapper('application/json', true), 'post', '/x', {}, budgets));
    expect(built.contentType).toBe('application/json');
    expect(new TextDecoder().decode(built.body)).toBe('{}');
  });

  it('sends an empty form body with its content type when the body is required', () => {
    const built = ok(
      buildRequest(mapper('application/x-www-form-urlencoded', true), 'post', '/x', {}, budgets),
    );
    expect(built.contentType).toBe('application/x-www-form-urlencoded');
    expect(built.body?.byteLength).toBe(0);
  });

  it('keeps an optional, entirely absent body absent', () => {
    const built = ok(buildRequest(mapper('application/json', false), 'post', '/x', {}, budgets));
    expect(built.body).toBeUndefined();
    expect(built.contentType).toBeUndefined();
  });

  it('still never sends a body for GET', () => {
    const built = ok(buildRequest(mapper('application/json', true), 'get', '/x', {}, budgets));
    expect(built.body).toBeUndefined();
  });
});

// #71: base64 tool input is decoded to the raw request bytes.
describe('buildRequest — application/octet-stream body (#71)', () => {
  const mapper: RequestMapper = {
    bodyMode: 'single',
    bodyContentType: 'application/octet-stream',
    bodyRequired: true,
    fields: { body: { destination: 'body', bodyPath: [], required: true } },
  };

  it('decodes base64 and sends the raw bytes with the declared content type', () => {
    const built = ok(buildRequest(mapper, 'post', '/upload', { body: 'AAEC/w==' }, budgets));
    expect(built.contentType).toBe('application/octet-stream');
    expect([...(built.body ?? [])]).toEqual([0, 1, 2, 255]);
  });

  it('fails closed on invalid base64 or a non-string payload', () => {
    expect(err(buildRequest(mapper, 'post', '/upload', { body: 'a*b=' }, budgets))).toMatch(
      /base64/u,
    );
    expect(err(buildRequest(mapper, 'post', '/upload', { body: { a: 1 } }, budgets))).toMatch(
      /base64/u,
    );
  });

  it('counts the DECODED bytes against the body budget', () => {
    const big = Buffer.alloc(budgets.maxBodyBytes + 1).toString('base64');
    expect(err(buildRequest(mapper, 'post', '/upload', { body: big }, budgets))).toMatch(/budget/u);
  });

  it('sends a multi-MiB upload (the regex check overflowed the stack above ~3.2 MiB)', () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024, 0xab);
    const large = { ...budgets, maxBodyBytes: 10 * 1024 * 1024 };
    const built = ok(
      buildRequest(mapper, 'post', '/upload', { body: bytes.toString('base64') }, large),
    );
    expect(built.body?.byteLength).toBe(bytes.byteLength);
  });

  it('rejects non-canonical trailing bits and embedded whitespace', () => {
    expect(err(buildRequest(mapper, 'post', '/upload', { body: 'QR==' }, budgets))).toMatch(
      /base64/u,
    );
    expect(err(buildRequest(mapper, 'post', '/upload', { body: 'aGVs bG8=' }, budgets))).toMatch(
      /base64/u,
    );
  });
});
