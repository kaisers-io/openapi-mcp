import { ANY, NONE, overlaps, readClass, readEscape, single, union } from './pattern-chars.ts';
import type { CharSet } from './pattern-chars.ts';
import { groupOpenLength, readQuantifier } from './pattern-syntax.ts';

// Response `pattern` safety, second check (see pattern-safety.ts). Quantifiers
// at star height 1 can backtrack too: in `^a*a*a*b$` or `\d+\d+\d+x` each
// quantified atom can match the characters of its neighbour, so a failing
// match tries every way to split the input among them, about n^k steps for k
// of them (80 characters took more than a second). A pattern is refused when,
// in one alternative (at any depth), two unbounded quantifiers can trade
// characters, or bounded ones can in more than CHOICE_BUDGET ways (as for
// nested quantifiers): `^[01]?\d\d?$` (2 x 2 ways) stays, `\d{1,9}\d{1,9}\d{1,9}`
// (729) does not. One unbounded quantifier next to bounded ones costs no more
// than one alone, so `^[a-z.-]+\.[a-z]{2,4}$` stays.
//
// A quantifier stops trading at the first mandatory item (one that cannot
// match empty) whose first character it cannot match: its match must end
// right before that item. `^\w+@\w+\.\w+$` and `^[a-z]+-[0-9]+$` stay. A
// mandatory item it can match, or an optional one, does not stop it, so
// `^a*aa*b$` and `^\d*\.?\d+$` are refused.
//
// Two items trade only where a split can move: the earlier one's characters
// meet the later one's first characters, and the earlier one's last
// characters meet the later one's characters. So `^[A-Z0-9]+(?:-[A-Z0-9]+)*$`
// (the group starts with `-`) and `^(\d{1,3}\.){3}\d{1,3}$` (the group ends
// with `.`) stay advertised.
//
// Without `^` the engine retries at every start: an unbounded quantifier that
// trades with that retry is quadratic when anything after it can fail (`\s+$`,
// 8 s on 100k characters), so nothing mandatory and no `$` may follow it.
// `.*` and `abc\d+x` stay; `[a-z]+@x` and a mandatory group (`(?:\d+)`) do not.
// Not detected, as for nested quantifiers: overlapping alternation (`(a|a)`)
// beyond the ways it adds. Conservative: `.*\S.*` is refused, although no
// failing match backtracks into a final `.*`, which matches any rest.

const CHOICE_BUDGET = 64;

// What an item or sequence can match: `first` and `last` hold its first and
// last characters, `min` and `max` its length. `run` lists the entries still
// open at its end. An entry stands for a quantifier (or an alternation) whose
// match can grow or shrink at that end: the characters it and the mandatory
// items after it can give away, its last characters, how many unbounded
// quantifiers its chain holds and the product of the bounded ranges.
// `unbounded` and `ways` are the most any chain inside the item reached.
// `anywhere` marks the retry entry; `trailing`, a quantifier open after it.
type Entry = { chars: CharSet; last: CharSet; unbounded: number; ways: number; anywhere?: boolean };
type Item = Entry & { first: CharSet; min: number; max: number; run: readonly Entry[] };
type Sequence = Item & { trailing?: boolean };

const MAX_ENTRIES = 8;
const EMPTY: Item = {
  first: NONE,
  chars: NONE,
  last: NONE,
  min: 0,
  max: 0,
  run: [],
  unbounded: 0,
  ways: 1,
};
// Where an alternative of the whole pattern starts, before a `^`
const RETRY: Entry = { chars: ANY, last: ANY, unbounded: 1, ways: 1, anywhere: true };
const ANYWHERE: Sequence = { ...EMPTY, run: [RETRY] };
const atom = (chars: CharSet): Item => ({
  ...EMPTY,
  first: chars,
  chars,
  last: chars,
  min: 1,
  max: 1,
});

type Count = { unbounded: number; ways: number };

const most = (left: Count, right: Count): Count => ({
  unbounded: Math.max(left.unbounded, right.unbounded),
  ways: Math.max(left.ways, right.ways),
});

// Past MAX_ENTRIES, one entry that covers them all.
const capped = (run: readonly Entry[]): readonly Entry[] =>
  run.length <= MAX_ENTRIES
    ? run
    : [
        run.reduce((left, right) => ({
          chars: union(left.chars, right.chars),
          last: union(left.last, right.last),
          ...most(left, right),
        })),
      ];

// A chain of two unbounded quantifiers, or with more ways than CHOICE_BUDGET.
const refused = (chain: Count): boolean => chain.unbounded > 1 || !(chain.ways <= CHOICE_BUDGET);

// The chain `entry` and a following variable-length `item` form, or
// `undefined` when they cannot trade characters.
const chain = (entry: Entry, item: Item): Entry | undefined =>
  overlaps(entry.chars, item.first) && overlaps(entry.last, item.chars)
    ? {
        chars: entry.chars,
        last: entry.last,
        unbounded: entry.unbounded + item.unbounded,
        ways: entry.ways * item.ways,
      }
    : undefined;

// `item` appended to `sequence`, or `undefined` when that forms a refused
// chain. `quantified` says that `item` is one quantified character or class.
const append = (sequence: Sequence, item: Item, quantified: boolean): Sequence | undefined => {
  if (item.max === 0) {
    return sequence;
  }
  if (sequence.trailing === true && item.min > 0) {
    return undefined;
  }
  // The longest chain `item` joins, raised onto the entries it leaves open.
  let reached: Count = { unbounded: 0, ways: 1 };
  let { trailing } = sequence;
  if (item.min !== item.max) {
    for (const entry of sequence.run) {
      const chained = chain(entry, item);
      if (chained !== undefined && entry.anywhere === true) {
        // Bounded steps per start; an optional group cannot fail
        if (item.unbounded > 0 && item.min > 0 && !quantified) {
          return undefined;
        }
        trailing = item.unbounded > 0 ? true : trailing;
      } else if (chained !== undefined && refused(chained)) {
        return undefined;
      } else {
        reached = chained === undefined ? reached : most(reached, chained);
      }
    }
  }
  // A mandatory item ends each entry that cannot match its first character;
  // the others can trade through it, and what they give away now ends with
  // it: in `[a-z.]+\.[a-z]+` the second quantifier never takes a dot.
  const kept =
    item.min === 0
      ? sequence.run
      : sequence.run
          .filter((entry) => overlaps(entry.chars, item.first))
          .map((entry) => ({
            chars: union(entry.chars, item.chars),
            last: item.last,
            unbounded: entry.unbounded,
            ways: entry.ways,
            anywhere: entry.anywhere,
          }));
  return {
    first: sequence.min === 0 ? union(sequence.first, item.first) : sequence.first,
    chars: union(sequence.chars, item.chars),
    last: item.min === 0 ? union(sequence.last, item.last) : item.last,
    min: sequence.min + item.min,
    max: sequence.max + item.max,
    run: capped([
      ...kept,
      ...item.run.map((entry) => ({
        chars: entry.chars,
        last: entry.last,
        ...most(entry, reached),
      })),
    ]),
    ...most(most(sequence, item), reached),
    trailing: trailing === true,
  };
};

// One more alternative of a group.
const alternative = (group: Item | undefined, sequence: Item): Item =>
  group === undefined
    ? sequence
    : {
        first: union(group.first, sequence.first),
        chars: union(group.chars, sequence.chars),
        last: union(group.last, sequence.last),
        min: Math.min(group.min, sequence.min),
        max: Math.max(group.max, sequence.max),
        run: capped([...group.run, ...sequence.run]),
        ...most(group, sequence),
      };

// A closed group of `count` alternatives: one of different lengths can end
// at as many places.
const closeGroup = (group: Item, count: number): Item =>
  count > 1 && group.min !== group.max
    ? {
        ...group,
        run: capped([
          ...group.run,
          { chars: group.chars, last: group.last, unbounded: 0, ways: count },
        ]),
        ways: Math.max(group.ways, count),
      }
    : group;

// `item` repeated `min` to `max` times, or `undefined` when the run at the end
// of one repetition forms a refused chain with the next one.
const repeat = (item: Item, min: number, max: number): Item | undefined => {
  if (
    max > 1 &&
    item.run.some((entry) => {
      const chained = chain(entry, item);
      return chained !== undefined && refused(chained);
    })
  ) {
    return undefined;
  }
  if (item.max === 0 || max === 0) {
    return EMPTY;
  }
  const count: Entry = {
    chars: item.chars,
    last: item.last,
    unbounded: max === Infinity ? 1 : 0,
    ways: max === Infinity ? 1 : max - min + 1,
  };
  return {
    ...item,
    min: item.min * min,
    max: item.max * max,
    ...(min === max ? {} : { run: capped([...item.run, count]), ...most(item, count) }),
  };
};

type Frame = { sequence: Sequence; group: Item | undefined; count: number };

export const hasAmbiguousSequence = (pattern: string): boolean => {
  const stack: Frame[] = [{ sequence: ANYWHERE, group: undefined, count: 0 }];
  // The item a following quantifier applies to, not yet appended, and
  // whether it is a character or class rather than a group.
  let pending: Item | undefined;
  let quantified = false;
  let index = 0;
  const flush = (): boolean => {
    const frame = stack.at(-1) as Frame;
    const next =
      pending === undefined ? frame.sequence : append(frame.sequence, pending, quantified);
    pending = undefined;
    if (next === undefined) {
      return false;
    }
    frame.sequence = next;
    return true;
  };
  while (index < pattern.length) {
    const read = pending === undefined ? undefined : readQuantifier(pattern, index);
    if (read !== undefined && pending !== undefined) {
      const { min, max } = read.quantifier;
      const repeated = repeat(pending, min, max);
      if (repeated === undefined) {
        return true;
      }
      index += read.length;
      // A lazy (`?`) suffix belongs to this quantifier.
      index += pattern[index] === '?' ? 1 : 0;
      pending = repeated;
      continue;
    }
    if (!flush()) {
      return true;
    }
    const char = pattern[index];
    const frame = stack.at(-1) as Frame;
    quantified = char !== ')';
    if (char === '(') {
      index += groupOpenLength(pattern, index);
      stack.push({ sequence: EMPTY, group: undefined, count: 0 });
    } else if (char === ')' && stack.length > 1) {
      stack.pop();
      pending = closeGroup(alternative(frame.group, frame.sequence), frame.count + 1);
      index += 1;
    } else if (char === '|') {
      frame.group = alternative(frame.group, frame.sequence);
      frame.sequence = stack.length === 1 ? ANYWHERE : EMPTY;
      frame.count += 1;
      index += 1;
    } else if (char === '^' && stack.length === 1) {
      frame.sequence = { ...frame.sequence, run: [] };
      index += 1;
    } else if (char === '$' && frame.sequence.trailing === true) {
      return true;
    } else if (char === '^' || char === '$') {
      index += 1;
    } else if (char === '\\') {
      const escape = readEscape(pattern, index, false);
      pending = escape.chars === undefined ? undefined : atom(escape.chars);
      ({ end: index } = escape);
    } else if (char === '[') {
      const parsed = readClass(pattern, index);
      pending = atom(parsed.chars);
      ({ end: index } = parsed);
    } else {
      const code = pattern.codePointAt(index) ?? 0;
      pending = atom(char === '.' ? ANY : single(code));
      index += String.fromCodePoint(code).length;
    }
  }
  return !flush();
};
