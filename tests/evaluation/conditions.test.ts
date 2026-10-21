import { describe, expect, it } from 'vitest';
import { Abort, ConditionMatcher, foldAscii } from '../../src/evaluation/conditions.js';
import { readContext, type NormalizedContext } from '../../src/evaluation/context.js';
import type { ConditionOutcome, ConditionTrace } from '../../src/evaluation/trace.js';
import type { Condition, ConditionGroup, ConditionValue, Operator } from '../../src/protocol/model.js';

const cond = (op: Operator, attribute: string | null, values: ConditionValue[] = [], ignoreCase = false): Condition => ({ op, attribute, values, ignoreCase });
const group = (kind: 'all' | 'any', members: (Condition | ConditionGroup)[]): ConditionGroup => ({ kind, members });

function contextOf(attributes: Record<string, unknown> | null, key: string | null = 'u_1'): NormalizedContext {
  const result = readContext({ kind: 'user', ...(key === null ? {} : { key }), ...(attributes === null ? {} : { attributes }) });
  if ('issues' in result) {
    throw new Error(result.issues.join('; '));
  }
  return result.context;
}

const matcherFor = (context: NormalizedContext) => new ConditionMatcher(context, (segment) => segment === 'beta');
const outcomeOf = (condition: Condition, attributes: Record<string, unknown> | null, key: string | null = 'u_1'): ConditionOutcome => matcherFor(contextOf(attributes, key)).outcome(condition);

describe('equality and membership', () => {
  it.each<[string, Condition, unknown, ConditionOutcome]>([
    ['eq string', cond('eq', 'v', ['PH']), 'PH', 'match'],
    ['eq string differs in case', cond('eq', 'v', ['PH']), 'ph', 'no_match'],
    ['eq number as float', cond('eq', 'v', [20]), 20.0, 'match'],
    ['eq number is not a numeral', cond('eq', 'v', [20]), '20', 'wrong_type'],
    ['eq numeral is not a number', cond('eq', 'v', ['20']), 20, 'wrong_type'],
    ['eq boolean', cond('eq', 'v', [true]), true, 'match'],
    ['eq boolean false', cond('eq', 'v', [true]), false, 'no_match'],
    ['eq boolean is not 1', cond('eq', 'v', [true]), 1, 'wrong_type'],
    ['eq negative zero', cond('eq', 'v', [0]), -0, 'match'],
    ['eq unsafe integer', cond('eq', 'v', [9007199254740991]), Number('9007199254740993'), 'wrong_type'],
    ['eq array any', cond('eq', 'v', ['PH']), ['US', 'PH'], 'match'],
    ['eq array none', cond('eq', 'v', ['PH']), ['US'], 'no_match'],
    ['eq empty array', cond('eq', 'v', ['PH']), [], 'no_match'],
    ['neq differs', cond('neq', 'v', ['PH']), 'US', 'match'],
    ['neq equal', cond('neq', 'v', ['PH']), 'PH', 'no_match'],
    ['neq wrong type', cond('neq', 'v', ['PH']), 5, 'wrong_type'],
    ['neq array none equal', cond('neq', 'v', ['PH']), ['US', 'DE'], 'match'],
    ['neq array one equal', cond('neq', 'v', ['PH']), ['US', 'PH'], 'no_match'],
    ['neq empty array', cond('neq', 'v', ['PH']), [], 'match'],
    ['in listed', cond('in', 'v', ['a', 'b']), 'b', 'match'],
    ['in not listed', cond('in', 'v', ['a', 'b']), 'c', 'no_match'],
    ['in numbers', cond('in', 'v', [1, 2, 3]), 2.0, 'match'],
    ['in wrong type', cond('in', 'v', ['a']), true, 'wrong_type'],
    ['not_in not listed', cond('not_in', 'v', ['a']), 'c', 'match'],
    ['not_in listed', cond('not_in', 'v', ['a']), 'a', 'no_match'],
    ['not_in empty array', cond('not_in', 'v', ['a']), [], 'match'],
    ['not_in array with a listed element', cond('not_in', 'v', ['a']), ['x', 'a'], 'no_match'],
  ])('%s', (_name, condition, value, expected) => {
    expect(outcomeOf(condition, { v: value })).toBe(expected);
  });
});

describe('string and numeric operators', () => {
  it.each<[string, Condition, unknown, ConditionOutcome]>([
    ['starts_with', cond('starts_with', 'v', ['ab']), 'abc', 'match'],
    ['starts_with miss', cond('starts_with', 'v', ['bc']), 'abc', 'no_match'],
    ['starts_with any value', cond('starts_with', 'v', ['x', 'ab']), 'abc', 'match'],
    ['starts_with empty value', cond('starts_with', 'v', ['']), 'abc', 'match'],
    ['ends_with', cond('ends_with', 'v', ['bc']), 'abc', 'match'],
    ['ends_with longer than the text', cond('ends_with', 'v', ['abcd']), 'abc', 'no_match'],
    ['contains', cond('contains', 'v', ['b']), 'abc', 'match'],
    ['contains miss', cond('contains', 'v', ['d']), 'abc', 'no_match'],
    ['contains is case-sensitive', cond('contains', 'v', ['B']), 'abc', 'no_match'],
    ['contains ignoring case', cond('contains', 'v', ['B'], true), 'abc', 'match'],
    ['ignore case does not fold accents', cond('contains', 'v', ['é'], true), 'CAFÉ', 'no_match'],
    ['ignore case does not fold the Kelvin sign', cond('contains', 'v', ['k'], true), 'K', 'no_match'],
    ['ignore case does not fold the dotless i', cond('contains', 'v', ['i'], true), 'ı', 'no_match'],
    ['an emoji prefix matches as a whole', cond('starts_with', 'v', ['👨']), '👨‍👩‍👧', 'match'],
    ['a different emoji does not', cond('starts_with', 'v', ['👨']), '👩', 'no_match'],
    ['NFC is not NFD', cond('eq', 'v', ['José']), 'José', 'no_match'],
    ['contains finds a base letter in NFD only', cond('contains', 'v', ['e']), 'é', 'no_match'],
    ['string operator on a number', cond('contains', 'v', ['1']), 1, 'wrong_type'],
    ['string operator on a list of numbers', cond('contains', 'v', ['1']), [1], 'wrong_type'],
    ['gt above', cond('gt', 'v', [18]), 19, 'match'],
    ['gt equal', cond('gt', 'v', [18]), 18, 'no_match'],
    ['gte equal', cond('gte', 'v', [18]), 18.0, 'match'],
    ['lt below', cond('lt', 'v', [18]), 17.5, 'match'],
    ['lt equal', cond('lt', 'v', [18]), 18, 'no_match'],
    ['lte equal', cond('lte', 'v', [18]), 18, 'match'],
    ['lte above', cond('lte', 'v', [18]), 19, 'no_match'],
    ['numeric on a numeral', cond('gte', 'v', [18]), '20', 'wrong_type'],
    ['numeric on a boolean', cond('gte', 'v', [18]), true, 'wrong_type'],
    ['numeric on an unsafe integer', cond('gt', 'v', [1]), Number('9007199254740993'), 'wrong_type'],
    ['numeric on a huge float', cond('gt', 'v', [1]), 1e300, 'wrong_type'],
    ['numeric on a safe integral float', cond('gt', 'v', [1]), 9007199254740991.0, 'match'],
    ['numeric array any', cond('gt', 'v', [18]), [3, 20], 'match'],
    ['numeric array none', cond('gt', 'v', [18]), [3, 4], 'no_match'],
    ['numeric empty array', cond('gt', 'v', [18]), [], 'no_match'],
    ['-0 is not below 0', cond('lt', 'v', [0]), -0, 'no_match'],
  ])('%s', (_name, condition, value, expected) => {
    expect(outcomeOf(condition, { v: value })).toBe(expected);
  });

  it('folds only ASCII letters', () => {
    expect(foldAscii('ABC xyz É İ K')).toBe('abc xyz É İ K');
    expect(foldAscii('ÀB')).toBe('Àb');
  });
});

describe('SemVer and date operators', () => {
  it.each<[string, Condition, unknown, ConditionOutcome]>([
    ['semver_eq with build', cond('semver_eq', 'v', ['1.0.0']), '1.0.0+x', 'match'],
    ['semver_neq equal', cond('semver_neq', 'v', ['1.0.0']), '1.0.0+x', 'no_match'],
    ['semver_neq differs', cond('semver_neq', 'v', ['1.0.0']), '1.0.1', 'match'],
    ['semver_neq invalid', cond('semver_neq', 'v', ['1.0.0']), '1.0', 'invalid_value'],
    ['semver_gt', cond('semver_gt', 'v', ['4.2.0']), '4.10.0', 'match'],
    ['semver_gte', cond('semver_gte', 'v', ['4.2.0']), '4.2.0', 'match'],
    ['semver_lt pre-release', cond('semver_lt', 'v', ['4.2.0']), '4.2.0-rc.1', 'match'],
    ['semver_lte', cond('semver_lte', 'v', ['4.2.0']), '4.2.1', 'no_match'],
    ['semver on a number', cond('semver_gt', 'v', ['4.2.0']), 4.2, 'wrong_type'],
    ['semver array with an invalid element', cond('semver_eq', 'v', ['1.0.0']), ['1.0.0', 'nope'], 'invalid_value'],
    ['semver empty array', cond('semver_neq', 'v', ['1.0.0']), [], 'match'],
    ['before', cond('before', 'v', ['2026-10-06T08:00:00Z']), '2026-10-06T07:59:59Z', 'match'],
    ['before equal', cond('before', 'v', ['2026-10-06T08:00:00Z']), '2026-10-06T16:00:00+08:00', 'no_match'],
    ['after', cond('after', 'v', ['2026-10-06T08:00:00Z']), '2026-10-06T08:00:00.001Z', 'match'],
    ['after equal', cond('after', 'v', ['2026-10-06T08:00:00Z']), '2026-10-06T08:00:00.000Z', 'no_match'],
    ['date invalid', cond('after', 'v', ['2026-10-06T08:00:00Z']), '2026-10-07', 'invalid_value'],
    ['date on epoch seconds', cond('after', 'v', ['2026-10-06T08:00:00Z']), 1791273601, 'wrong_type'],
  ])('%s', (_name, condition, value, expected) => {
    expect(outcomeOf(condition, { v: value })).toBe(expected);
  });
});

describe('missing, null, existence and context fields', () => {
  it('treats missing, null and existence', () => {
    const eq = cond('eq', 'v', ['x']);
    const neq = cond('neq', 'v', ['x']);
    expect(outcomeOf(eq, {})).toBe('missing');
    expect(outcomeOf(neq, {})).toBe('missing');
    expect(outcomeOf(eq, { v: null })).toBe('null');
    expect(outcomeOf(neq, { v: null })).toBe('null');
    expect(outcomeOf(cond('exists', 'v'), { v: null })).toBe('match');
    expect(outcomeOf(cond('exists', 'v'), { v: false })).toBe('match');
    expect(outcomeOf(cond('exists', 'v'), { v: [] })).toBe('match');
    expect(outcomeOf(cond('exists', 'v'), {})).toBe('no_match');
    expect(outcomeOf(cond('not_exists', 'v'), {})).toBe('match');
    expect(outcomeOf(cond('not_exists', 'v'), { v: null })).toBe('no_match');
    expect(outcomeOf(eq, null)).toBe('missing');
  });

  it('reads kind and key as attributes', () => {
    expect(outcomeOf(cond('eq', 'kind', ['user']), {})).toBe('match');
    expect(outcomeOf(cond('eq', 'key', ['u_1']), {})).toBe('match');
    expect(outcomeOf(cond('eq', 'key', ['u_1']), {}, null)).toBe('missing');
    expect(outcomeOf(cond('exists', 'key'), {}, null)).toBe('no_match');
    expect(outcomeOf(cond('not_exists', 'key'), {}, null)).toBe('match');
    expect(outcomeOf(cond('exists', 'kind'), {})).toBe('match');
  });

  it('decides segment conditions through the membership callback', () => {
    expect(outcomeOf(cond('in_segment', null, ['beta']), {})).toBe('match');
    expect(outcomeOf(cond('in_segment', null, ['other']), {})).toBe('no_match');
    expect(outcomeOf(cond('in_segment', null, ['other', 'beta']), {})).toBe('match');
    expect(outcomeOf(cond('not_in_segment', null, ['beta']), {})).toBe('no_match');
    expect(outcomeOf(cond('not_in_segment', null, ['other']), {})).toBe('match');
    expect(outcomeOf(cond('not_in_segment', null, ['other', 'beta']), {})).toBe('no_match');
  });

  it('lets the membership callback abort the evaluation', () => {
    const matcher = new ConditionMatcher(contextOf({}), () => {
      throw new Abort('INVALID_CONFIG');
    });
    expect(() => matcher.outcome(cond('in_segment', null, ['ghost']))).toThrow(Abort);
  });
});

describe('groups', () => {
  const matcher = matcherFor(contextOf({ country: 'PH', plan: 'free' }));
  const eq = (attribute: string, value: string): Condition => cond('eq', attribute, [value]);

  it.each<[string, ConditionGroup, boolean]>([
    ['empty all', group('all', []), true],
    ['empty any', group('any', []), false],
    ['all true', group('all', [eq('country', 'PH'), eq('plan', 'free')]), true],
    ['all one false', group('all', [eq('country', 'PH'), eq('plan', 'pro')]), false],
    ['any one true', group('any', [eq('country', 'US'), eq('plan', 'free')]), true],
    ['any none true', group('any', [eq('country', 'US'), eq('plan', 'pro')]), false],
    ['nested any in all', group('all', [eq('country', 'PH'), group('any', [eq('plan', 'pro'), eq('plan', 'free')])]), true],
    ['nested empty any blocks all', group('all', [eq('country', 'PH'), group('any', [])]), false],
    ['nested empty all in any', group('any', [eq('country', 'US'), group('all', [])]), true],
  ])('%s', (_name, g, expected) => {
    expect(matcher.matches(g)).toBe(expected);
  });

  it('records outcomes with paths and marks skipped conditions as not evaluated', () => {
    const trace: ConditionTrace[] = [];
    const g = group('all', [eq('country', 'US'), group('any', [eq('plan', 'pro'), cond('in_segment', null, ['beta'])]), cond('exists', 'x')]);

    expect(matcher.matches(g, trace)).toBe(false);
    expect(trace.map((t) => [t.path, t.outcome])).toEqual([
      ['/all/0', 'no_match'],
      ['/all/1/any/0', 'not_evaluated'],
      ['/all/1/any/1', 'not_evaluated'],
      ['/all/2', 'not_evaluated'],
    ]);
    expect(trace[2]?.segment).toBe('beta');
    expect(trace[0]?.attribute).toBe('country');
  });

  it('records an any group stopping at the first match', () => {
    const trace: ConditionTrace[] = [];
    matcher.matches(group('any', [eq('country', 'PH'), eq('plan', 'pro')]), trace);
    expect(trace.map((t) => t.outcome)).toEqual(['match', 'not_evaluated']);
  });
});
