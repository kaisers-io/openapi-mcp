import { describe, expect, it } from 'vitest';
import {
  FILTER_MAX_MATCH_STEPS,
  FILTER_PATTERN_MAX_COUNT,
  FILTER_PATTERN_MAX_LENGTH,
  FILTER_PATTERN_MAX_WILDCARDS,
  GLOBSTAR,
  OpenapiMcpError,
  STAR,
  type CompiledGlob,
  type FilterPattern,
  compileGlob,
  createMatchBudget,
  globMatches,
  parseFilterPattern,
  parseFilterPatterns,
} from '../src/index.ts';

// Every pattern now also carries its `compiled` programme, so exact-object
// assertions must account for it or they fail to typecheck and to match.
// `shape` asserts the identifying fields and checks the compiled member
// separately — the token programme has its own dedicated tests, and restating
// it inline here would be noise.
const shape = (raw: string): Omit<FilterPattern, 'compiled'> => {
  const parsed = parseFilterPattern(raw);
  expect(parsed.compiled.tokens.length).toBeGreaterThan(0);
  const { compiled: _compiled, ...rest } = parsed;
  return rest;
};

describe('parseFilterPattern — form detection', () => {
  it('reads a bare word as an operationId glob', () => {
    expect(shape('readPets')).toEqual({
      kind: 'operationId',
      glob: 'readPets',
      raw: 'readPets',
    });
  });

  it('reads a wildcard word as an operationId glob', () => {
    expect(shape('read*')).toEqual({
      kind: 'operationId',
      glob: 'read*',
      raw: 'read*',
    });
  });

  it('reads the tag: prefix as the tag form', () => {
    expect(shape('tag:admin*')).toEqual({
      kind: 'tag',
      glob: 'admin*',
      raw: 'tag:admin*',
    });
  });

  it('reads METHOD + space + path as the methodPath form', () => {
    expect(shape('GET /users/**')).toEqual({
      kind: 'methodPath',
      method: 'GET',
      glob: '/users/**',
      raw: 'GET /users/**',
    });
  });

  it('compiles each pattern once, carrying the programme on the pattern', () => {
    // The compiled programme travels WITH the pattern so matching never
    // recompiles per candidate string
    const parsed = parseFilterPattern('GET /users/**');
    expect(parsed.compiled.tokens).toEqual(compileGlob('/users/**').tokens);
  });

  it('accepts every exposable HTTP method', () => {
    for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD']) {
      expect(parseFilterPattern(`${method} /x`).kind).toBe('methodPath');
    }
  });

  it('keeps a tag glob that itself contains a colon', () => {
    expect(shape('tag:a:b')).toEqual({ kind: 'tag', glob: 'a:b', raw: 'tag:a:b' });
  });

  it('does not treat a mid-string "tag:" as the tag form', () => {
    expect(parseFilterPattern('xtag:admin').kind).toBe('operationId');
  });
});

describe('parseFilterPattern — rejections', () => {
  it('rejects an empty pattern', () => {
    expect(() => parseFilterPattern('')).toThrowError(OpenapiMcpError);
  });

  it('rejects a bare "tag:" with no glob', () => {
    expect(() => parseFilterPattern('tag:')).toThrowError(/needs a tag glob/u);
  });

  it('rejects an unknown method in the methodPath form', () => {
    try {
      parseFilterPattern('FETCH /users');
      expect.unreachable('expected a usage error');
    } catch (error) {
      const typed = error as OpenapiMcpError;
      expect(typed.code).toBe('usage');
      expect(typed.message).toContain('GET');
    }
  });

  it('rejects a lowercase method — the language is case-sensitive', () => {
    expect(() => parseFilterPattern('get /users')).toThrowError(OpenapiMcpError);
  });

  it('rejects OPTIONS and TRACE, which are never exposed in v1', () => {
    expect(() => parseFilterPattern('OPTIONS /users')).toThrowError(OpenapiMcpError);
    expect(() => parseFilterPattern('TRACE /users')).toThrowError(OpenapiMcpError);
  });

  it('rejects a methodPath whose path does not start with a slash', () => {
    expect(() => parseFilterPattern('GET users')).toThrowError(/must start with "\/"/u);
  });

  it('rejects two spaces — exactly one separates method from path (grammar rule 7)', () => {
    expect(() => parseFilterPattern('GET  /users')).toThrowError(OpenapiMcpError);
  });

  it('rejects a trailing space', () => {
    expect(() => parseFilterPattern('GET ')).toThrowError(OpenapiMcpError);
  });

  it('never degrades a spaced pattern into an operationId glob (grammar rule 7)', () => {
    // An operationId containing a space is unreachable by design: silently
    // parsing "list pets!" as an operationId would surface later as a dead
    // pattern instead of as the usage error it is
    expect(() => parseFilterPattern('list pets!')).toThrowError(/must start with one of/u);
  });

  it('rejects an over-long pattern', () => {
    expect(() => parseFilterPattern('x'.repeat(FILTER_PATTERN_MAX_LENGTH + 1))).toThrowError(
      /at most 256 characters/u,
    );
  });

  it('accepts a pattern exactly at the cap', () => {
    const raw = 'x'.repeat(FILTER_PATTERN_MAX_LENGTH);
    expect(parseFilterPattern(raw).raw).toBe(raw);
  });

  it('never echoes the raw pattern value back in an error message', () => {
    try {
      parseFilterPattern('SNIFF /x');
      expect.unreachable('expected a usage error');
    } catch (error) {
      expect((error as OpenapiMcpError).message).not.toContain('SNIFF');
    }
  });

  it('freezes the occurrence cap enforced by parseFilterPatterns', () => {
    expect(FILTER_PATTERN_MAX_COUNT).toBe(128);
  });
});

describe('parseFilterPatterns — the list bound', () => {
  const many = (count: number): readonly string[] =>
    Array.from({ length: count }, (_unused, index) => `op${String(index)}`);

  it('returns an empty list for no patterns', () => {
    expect(parseFilterPatterns([])).toEqual([]);
  });

  it('parses exactly at the count cap', () => {
    const parsed = parseFilterPatterns(many(FILTER_PATTERN_MAX_COUNT));
    expect(parsed).toHaveLength(FILTER_PATTERN_MAX_COUNT);
    expect(parsed[0]).toMatchObject({ kind: 'operationId', glob: 'op0', raw: 'op0' });
  });

  it('rejects one pattern over the count cap', () => {
    expect(() => parseFilterPatterns(many(FILTER_PATTERN_MAX_COUNT + 1))).toThrowError(
      /at most 128/u,
    );
  });

  it('enforces the count before parsing, so an over-long list fails on the count', () => {
    // The bound is a cheap gate in front of 129 compilations, not a summary of them
    expect(() =>
      parseFilterPatterns(Array.from({ length: FILTER_PATTERN_MAX_COUNT + 1 }, () => '')),
    ).toThrowError(/at most 128/u);
  });

  it('still parses and validates every element', () => {
    const parsed = parseFilterPatterns(['tag:admin*', 'GET /users/**']);
    expect(parsed[0]).toMatchObject({ kind: 'tag', glob: 'admin*', raw: 'tag:admin*' });
    expect(parsed[1]).toMatchObject({
      kind: 'methodPath',
      method: 'GET',
      glob: '/users/**',
      raw: 'GET /users/**',
    });
    expect(() => parseFilterPatterns(['listPets', 'FETCH /users'])).toThrowError(OpenapiMcpError);
    expect(() => parseFilterPatterns(['**a'.repeat(11)])).toThrowError(/at most 10 wildcards/u);
  });
});

// The grammar assertions are expressed as BEHAVIOUR rather than as properties
// of a compiled RegExp source, because there is no RegExp on the production
// path any more. `match` is the one-line adapter every case below uses.
const match = (glob: string, value: string): boolean =>
  globMatches(compileGlob(glob), value, createMatchBudget());

describe('compileGlob — literal handling (grammar rule 5)', () => {
  it('is anchored at both ends', () => {
    expect(match('pets', 'pets')).toBe(true);
    expect(match('pets', 'xpetsx')).toBe(false);
  });

  it('does not let a match end before an embedded newline (grammar rule 3)', () => {
    // The RegExp form achieved this by omitting the "m" flag; the token
    // programme achieves it by consuming the whole value or failing
    expect(match('pets', 'pets\nx')).toBe(false);
  });

  it('compiles an empty glob to an empty-string matcher (grammar rule 9)', () => {
    expect(compileGlob('').tokens).toEqual([]);
    expect(match('', '')).toBe(true);
    expect(match('', 'a')).toBe(false);
  });

  it('escapes nothing, because nothing reaches a RegExp constructor', () => {
    // The RegExp-based compiler escaped metacharacters before building a RegExp.
    // The token programme has no such step: every non-star character is stored
    // as itself, which is why regex syntax cannot be injected and an
    // unbalanced metacharacter cannot raise SyntaxError.
    expect(compileGlob('a(b').tokens).toEqual(['a', '(', 'b']);
    expect(compileGlob('a.c').tokens).toEqual(['a', '.', 'c']);
  });

  it('treats "." as a literal, not as any-character', () => {
    expect(match('a.c', 'a.c')).toBe(true);
    expect(match('a.c', 'abc')).toBe(false);
  });

  it('treats regex grouping and alternation as literals', () => {
    expect(match('get(v1|v2)', 'get(v1|v2)')).toBe(true);
    expect(match('get(v1|v2)', 'getv1')).toBe(false);
  });

  it('treats quantifier characters as literals', () => {
    expect(match('a+b?c', 'a+b?c')).toBe(true);
    expect(match('a+b?c', 'aab?c')).toBe(false);
  });

  it('treats character-class brackets as literals', () => {
    expect(match('id[0-9]', 'id[0-9]')).toBe(true);
    expect(match('id[0-9]', 'id5')).toBe(false);
  });

  it('treats anchors and braces as literals', () => {
    // eslint-disable-next-line no-template-curly-in-string -- literal "${1}" text in the fixture, not interpolation
    expect(match('^a${1}', '^a${1}')).toBe(true);
  });

  it('compiles an unbalanced metacharacter without throwing', () => {
    // An operator typo must be a non-match, never a SyntaxError from the RegExp
    // constructor, and never a way to inject regex syntax into the matcher
    expect(() => compileGlob('a(b')).not.toThrow();
    expect(match('a(b', 'a(b')).toBe(true);
    expect(match('a\\d', 'a5')).toBe(false);
    expect(match('a\\d', 'a\\d')).toBe(true);
  });
});

describe('compileGlob — wildcards (grammar rules 1, 2, 4)', () => {
  it('matches a plain literal', () => {
    expect(match('readPets', 'readPets')).toBe(true);
    expect(match('readPets', 'readPet')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(match('readPets', 'readpets')).toBe(false);
    expect(match('read*', 'READ_ALL')).toBe(false);
  });

  it('expands "*" within a segment but not across "/"', () => {
    expect(match('/users/*', '/users/list')).toBe(true);
    expect(match('/users/*', '/users/1/pets')).toBe(false);
  });

  it('expands "**" across segments', () => {
    expect(match('/users/**', '/users/1/pets')).toBe(true);
    expect(match('/users/**', '/users/')).toBe(true);
  });

  it('does NOT let "/x/**" match "/x" — the slash before "**" is literal (rule 2)', () => {
    // Frozen decision: no special-casing of a trailing "/**". An operator who
    // wants the collection endpoint too writes "/users**" or supplies both.
    expect(match('/users/**', '/users')).toBe(false);
    expect(match('/users**', '/users')).toBe(true);
    expect(match('/users**', '/users/1/pets')).toBe(true);
  });

  it('lets "*" match an empty run', () => {
    expect(match('read*', 'read')).toBe(true);
  });

  it('matches everything with a lone "**"', () => {
    expect(match('**', '/a/b/c')).toBe(true);
    expect(match('**', '')).toBe(true);
  });

  it('matches a line separator with "**" — [\\s\\S], not "." (rule 4)', () => {
    expect(match('**', 'a\u2028b')).toBe(true);
  });

  it('does not let a lone "*" match a path with separators', () => {
    expect(match('*', '/a/b')).toBe(false);
    expect(match('*', 'ab')).toBe(true);
  });

  it('collapses three or more stars to a single deep wildcard (rule 1)', () => {
    expect(compileGlob('a***b').tokens).toEqual(compileGlob('a**b').tokens);
    expect(compileGlob('***').tokens).toEqual(compileGlob('**').tokens);
  });

  it('handles wildcards at both ends', () => {
    expect(match('*Pet*', 'readPetById')).toBe(true);
    expect(match('*Pet*', 'readDogById')).toBe(false);
  });

  it('handles a template path with braces', () => {
    expect(match('/users/{userId}', '/users/{userId}')).toBe(true);
    expect(match('/users/{userId}', '/users/{id}')).toBe(false);
    expect(match('/users/*', '/users/{userId}')).toBe(true);
  });

  it('never emits two adjacent wildcard tokens', () => {
    // Star runs are consumed whole. Under the RegExp compiler this mattered
    // because "[^/]*[^/]*" is the classic catastrophic shape; the state-set
    // matcher does not care, but the invariant is kept so the token programme
    // stays a canonical form of the pattern.
    for (const glob of ['**', '***', 'a**b', '*/*', '**/**']) {
      const { tokens } = compileGlob(glob);
      for (let i = 1; i < tokens.length; i += 1) {
        const previous = tokens[i - 1];
        const current = tokens[i];
        const isWildcard = (t: unknown): boolean => t === STAR || t === GLOBSTAR;
        expect(isWildcard(previous) && isWildcard(current)).toBe(false);
      }
    }
  });
});

describe('compileGlob — sanity bounds', () => {
  it('rejects a pattern with more than the allowed number of wildcard groups', () => {
    const glob = '**a'.repeat(FILTER_PATTERN_MAX_WILDCARDS + 1);
    expect(() => compileGlob(glob)).toThrowError(/at most 10 wildcards/u);
  });

  it('accepts a pattern exactly at the wildcard cap', () => {
    expect(() => compileGlob('**a'.repeat(FILTER_PATTERN_MAX_WILDCARDS))).not.toThrow();
  });

  it('counts a collapsed run of stars as one wildcard (rule 1)', () => {
    // "*****" is one wildcard group, not five
    expect(() => compileGlob('*****a*****b')).not.toThrow();
  });

  it('surfaces the cap through parseFilterPattern for every form', () => {
    expect(() => parseFilterPattern('**a'.repeat(11))).toThrowError(OpenapiMcpError);
    expect(() => parseFilterPattern(`tag:${'**a'.repeat(11)}`)).toThrowError(OpenapiMcpError);
    expect(() => parseFilterPattern(`GET /${'**a'.repeat(11)}`)).toThrowError(OpenapiMcpError);
  });

  it('is a sanity bound only — it is no longer what provides the safety property', () => {
    // Stated as an executable reminder: an earlier design claimed this cap made
    // a backtracking RegExp safe, and the benchmark that "proved" it used a
    // value shape that never reaches the combinatorial case. The matcher below
    // does not backtrack at all, and the budget bounds the aggregate.
    expect(FILTER_PATTERN_MAX_WILDCARDS).toBe(10);
  });
});

describe('globMatches — no backtracking', () => {
  // Reuses the module-level `match` adapter defined above rather than
  // redeclaring an identical one in this block's scope.
  it('answers the shape that costs 134 ms as a RegExp in microseconds', () => {
    // Measured with the RegExp-based compiler at 10 wildcards — a pattern the
    // cap ADMITS — against "a" x n + "b": 3.9 ms at 20, 26 ms at 24, 134 ms at
    // 28, 277 ms at 30. Doubling per added character. The original benchmark
    // used only nine "a"s and cost 1.2 ms, which is why the suite stayed green.
    const glob = '**a'.repeat(FILTER_PATTERN_MAX_WILDCARDS);
    for (const aCount of [28, 40, 800]) {
      expect(match(glob, `${'a'.repeat(aCount)}b`)).toBe(false);
    }
  });

  it('costs a bounded, predictable number of steps rather than an explosive one', () => {
    // The real acceptance criterion, and the reason it is a step count and not
    // a wall-clock threshold: the count is a pure function of the inputs, so
    // this assertion cannot go green on a fast machine and red on a slow one.
    const compiled = compileGlob('**a'.repeat(FILTER_PATTERN_MAX_WILDCARDS));
    const spend = (value: string): number => {
      const budget = createMatchBudget();
      globMatches(compiled, value, budget);
      return FILTER_MAX_MATCH_STEPS - budget.remaining;
    };
    const short = spend(`${'a'.repeat(28)}b`);
    const long = spend(`${'a'.repeat(56)}b`);
    // Linear in the value length, not exponential: doubling the input roughly
    // doubles the work. A backtracking engine squares it many times over.
    expect(long).toBeLessThan(short * 4);
    expect(long).toBeLessThan(compiled.tokens.length * 57 + 1);
  });

  it('settles a prefilter rejection far more cheaply than a simulation', () => {
    // An earlier version of this case asserted the rejection spent ZERO steps
    // while the implementation unconditionally charged one — the suite could
    // not have passed. It also asserted the wrong property: a prefilter is not
    // free, it is CHEAP, and the counter is only honest if it says so. What
    // matters is that it costs O(value + affix) rather than O(tokens x value).
    const compiled = compileGlob('/users/**');
    const value = `/orders/${'x'.repeat(500)}`;
    const budget = createMatchBudget();
    expect(globMatches(compiled, value, budget)).toBe(false);
    const spent = FILTER_MAX_MATCH_STEPS - budget.remaining;
    expect(spent).toBeGreaterThan(0);
    // Bounded by materializing the value plus comparing the required prefix —
    // nowhere near the tokens x length a simulation would cost
    expect(spent).toBeLessThanOrEqual(value.length + compiled.prefix.length);
  });

  it('is deterministic — identical inputs spend identical steps', () => {
    const compiled = compileGlob('**a**b*c');
    const spend = (): number => {
      const budget = createMatchBudget();
      globMatches(compiled, 'xxaxxbxxc', budget);
      return FILTER_MAX_MATCH_STEPS - budget.remaining;
    };
    expect(new Set([spend(), spend(), spend()]).size).toBe(1);
  });

  it('refuses with a validation error once the budget is exhausted', () => {
    const compiled = compileGlob('**a'.repeat(FILTER_PATTERN_MAX_WILDCARDS));
    const budget = createMatchBudget(100);
    expect(() => globMatches(compiled, 'a'.repeat(10_000), budget)).toThrowError(/work budget/u);
  });

  it('freezes the measured budget', () => {
    // Recalibrated twice: an earlier version charged only live-state
    // transitions; a later revision added code-point materialization, affix
    // comparisons and state-array
    // initialization, which raised a realistic maximal configuration (256
    // patterns, 512 operations, four candidate fields each) from a REPORTED
    // 13,049,627 steps to a MEASURED 33,099,767 — 1.5x headroom under the old
    // 50M cap, i.e. close enough to fire on legitimate use. At 200M the same
    // configuration sits at 16.5% with 6.0x headroom (319 ms), and the
    // pathological configuration is cut off after ~1.4 s.
    expect(FILTER_MAX_MATCH_STEPS).toBe(200_000_000);
  });

  it('charges the per-character cost that clearing live states would otherwise hide', () => {
    // A leading globstar keeps every state live, so clearing them via
    // next.fill(0) costs O(tokens) per character even though charging only
    // O(1) per live state would miss that. The step count must scale with
    // tokens x length, not length, to price the clearing work.
    const wide = compileGlob(`**${'a'.repeat(120)}`);
    const narrow = compileGlob('**a');
    const spend = (compiled: CompiledGlob, value: string): number => {
      const budget = createMatchBudget();
      globMatches(compiled, value, budget);
      return FILTER_MAX_MATCH_STEPS - budget.remaining;
    };
    const value = 'a'.repeat(512);
    // The wide pattern has ~40x the tokens, so it must cost substantially more
    // — charging only O(1) per live state instead of O(tokens) per character
    // would leave the two far closer together
    expect(spend(wide, value)).toBeGreaterThan(spend(narrow, value) * 5);
  });
});

describe('globMatches — differential equivalence with the frozen grammar', () => {
  // The grammar is UNCHANGED by the matcher swap, and this is how that is
  // proved rather than asserted. The original RegExp-based compiler is kept here, in
  // the test file only, as an oracle. It is deliberately not exported from the
  // package: it is the implementation that was found unsafe.
  const oracle = (glob: string): RegExp => {
    const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    let source = '';
    let index = 0;
    while (index < glob.length) {
      const star = glob.indexOf('*', index);
      if (star === -1) {
        source += escape(glob.slice(index));
        break;
      }
      source += escape(glob.slice(index, star));
      let end = star;
      while (glob[end] === '*') {
        end += 1;
      }
      source += end - star === 1 ? '[^/]*' : '[\\s\\S]*';
      index = end;
    }
    return new RegExp(`^${source}$`, 'u');
  };

  const agree = (glob: string, value: string): void => {
    expect(globMatches(compileGlob(glob), value, createMatchBudget())).toBe(
      oracle(glob).test(value),
    );
  };

  it('agrees on every frozen grammar case', () => {
    for (const [glob, value] of [
      ['pets', 'pets'],
      ['pets', 'xpetsx'],
      ['read*', 'read'],
      ['read*', 'readPets'],
      ['/users/*', '/users/list'],
      ['/users/*', '/users/1/pets'],
      ['/users/**', '/users/1/pets'],
      ['/users/**', '/users'],
      ['/users/**', '/users/'],
      ['/users**', '/users'],
      ['*', '/a/b'],
      ['*', 'ab'],
      ['**', ''],
      ['**', '/a/b/c'],
      ['', ''],
      ['', 'a'],
      ['a***b', 'a/x/b'],
      ['a**b', 'a/x/b'],
      ['*Pet*', 'readPetById'],
      ['*Pet*', 'readDogById'],
      ['a.c', 'a.c'],
      ['a.c', 'abc'],
      ['get(v1|v2)', 'get(v1|v2)'],
      ['get(v1|v2)', 'getv1'],
      ['id[0-9]', 'id[0-9]'],
      ['id[0-9]', 'id5'],
      ['a(b', 'a(b'],
      ['a\\d', 'a5'],
      ['a\\d', 'a\\d'],
      ['pets', 'pets\nx'],
      ['/users/{userId}', '/users/{userId}'],
      ['/users/{userId}', '/users/{id}'],
      ['/users/*', '/users/{userId}'],
      ['readPets', 'readpets'],
      ['read*', 'READ_ALL'],
      ['**/**', 'a/b'],
    ] as const) {
      agree(glob, value);
    }
  });

  it('agrees on astral characters', () => {
    // An earlier matcher failed SIX of these eight, including the trivial
    // pattern-equals-value case, because it tokenized UTF-16 code units and
    // matched code points
    const emoji = '\u{1F600}';
    for (const [glob, value] of [
      [`*${emoji}`, emoji],
      [`*${emoji}`, `a${emoji}`],
      [`a*${emoji}`, `ab${emoji}`],
      [`${emoji}*`, `${emoji}b`],
      ['*', emoji],
      ['**', `${emoji}\u{1F601}`],
      [emoji, emoji],
      [`a${emoji}b`, `a${emoji}b`],
    ] as const) {
      agree(glob, value);
    }
  });

  // The fuzz sweep this replaces was HOLLOW. It used a seeded LCG whose low
  // bits are degenerate — probed: rand(4)
  // returned 0 for every draw after the first, so `rand(4) === 0` was almost
  // always true, the generator emitted almost nothing but "*", and NOT ONE of
  // 20,000 generated globs contained a character from the second half of the
  // alphabet. It reported "0 mismatches" against a matcher that provably fails
  // `compileGlob(EMOJI)`. A fuzz test that cannot show what it explored is
  // false assurance, so this version asserts its own corpus coverage.
  const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  const ALPHABET = ['a', 'b', '/', '.', '{', '}', '\u{1F600}', 'é'] as const;

  it('agrees across a deterministic fuzz sweep, and proves what it explored', () => {
    const nextRandom = mulberry32(20_260_720);
    const rand = (n: number): number => Math.floor(nextRandom() * n);
    const randomGlob = (): string => {
      let glob = '';
      for (let k = 0, len = rand(8); k < len; k += 1) {
        glob += rand(4) === 0 ? '*' : (ALPHABET[rand(ALPHABET.length)] as string);
      }
      return glob;
    };
    // A value DERIVED from the glob, so the corpus contains plenty of genuine
    // MATCHES. Independently generated pairs almost never match, and a
    // comparison where both sides answer "false" proves nothing.
    const derive = (glob: string): string => {
      let out = '';
      const points = [...glob];
      for (let i = 0; i < points.length; i += 1) {
        if (points[i] === '*') {
          let end = i;
          while (points[end] === '*') {
            end += 1;
          }
          const deep = end - i > 1;
          for (let k = 0, len = rand(3); k < len; k += 1) {
            const pool = deep ? ALPHABET : ALPHABET.filter((c) => c !== '/');
            out += pool[rand(pool.length)] as string;
          }
          i = end - 1;
          continue;
        }
        out += points[i] as string;
      }
      return out;
    };

    const coverage = { astral: 0, slash: 0, deep: 0, matches: 0, nonMatches: 0, pairs: 0 };
    for (let trial = 0; trial < 20_000; trial += 1) {
      const glob = randomGlob();
      if (([...glob].join('').match(/\*+/gu) ?? []).length > FILTER_PATTERN_MAX_WILDCARDS) {
        continue;
      }
      // Half derived (match-heavy), half independent (rejection-heavy)
      const value = trial % 2 === 0 ? derive(glob) : randomGlob().replaceAll('*', 'z');
      coverage.pairs += 1;
      if (glob.includes('\u{1F600}') || value.includes('\u{1F600}')) {
        coverage.astral += 1;
      }
      if (glob.includes('/') || value.includes('/')) {
        coverage.slash += 1;
      }
      if (glob.includes('**')) {
        coverage.deep += 1;
      }
      if (oracle(glob).test(value)) {
        coverage.matches += 1;
      } else {
        coverage.nonMatches += 1;
      }
      agree(glob, value);
    }

    // The load-bearing part: the corpus must demonstrably contain every
    // construct this test claims to cover. Without these, a degenerate
    // generator silently turns the sweep into 20,000 copies of one trivial case
    // — which is exactly what happened with the fuzz sweep this replaces.
    expect(coverage.pairs).toBeGreaterThan(15_000);
    expect(coverage.astral).toBeGreaterThan(1_000);
    expect(coverage.slash).toBeGreaterThan(1_000);
    expect(coverage.deep).toBeGreaterThan(500);
    expect(coverage.matches).toBeGreaterThan(1_000);
    expect(coverage.nonMatches).toBeGreaterThan(1_000);
  });
});
