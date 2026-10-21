import { describe, expect, it } from 'vitest';
import { MalformedSnapshot, Problem } from '../../src/protocol/errors.js';
import { decodeJson, isUnsafeNumber, type Json } from '../../src/protocol/json.js';

function problemOf(text: string, limits?: Parameters<typeof decodeJson>[1]): string {
  try {
    decodeJson(text, limits);
  } catch (error) {
    if (error instanceof MalformedSnapshot) {
      expect(error.path).toBe('');
      return error.problem;
    }
    throw error;
  }
  return 'accepted';
}

describe('decodeJson', () => {
  it('decodes ordinary JSON and keeps the last duplicate', () => {
    expect(decodeJson('{"a":{},"b":[],"a":2}')).toEqual({ a: 2, b: [] });
  });

  it('keeps __proto__ as an ordinary member', () => {
    const value = decodeJson('{"__proto__":{"polluted":true}}') as { [key: string]: Json };
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each(['', '{', '{"a":1,}', "{'a':1}", 'NaN', '[1,]', '{"a":1} x', '"\\ud800"', '{"\\udc00":1}', '["ok","\\ud83d x"]'])('rejects %j as invalid', (text) => {
    expect(problemOf(text)).toBe(Problem.INVALID_JSON);
  });

  it('accepts well-formed surrogate pairs', () => {
    expect(decodeJson('"\\ud83d\\ude00"')).toBe('😀');
  });

  it('allows 64 levels of nesting and rejects 65, without building the structure', () => {
    const nest = (levels: number): string => '['.repeat(levels) + ']'.repeat(levels);
    expect(problemOf(nest(64))).toBe('accepted');
    expect(problemOf(nest(65))).toBe(Problem.TOO_DEEP);
    expect(problemOf(nest(200_000))).toBe(Problem.TOO_DEEP);
  });

  it('ignores brackets inside strings when measuring nesting', () => {
    expect(problemOf(`["${'['.repeat(100)}", "\\"${'['.repeat(100)}"]`)).toBe('accepted');
  });

  it('rejects text over the size limit, counted in bytes', () => {
    expect(problemOf(`"${'a'.repeat(20)}"`, { maxBytes: 10 })).toBe(Problem.TOO_LARGE);
    expect(problemOf(`"${'é'.repeat(6)}"`, { maxBytes: 12 })).toBe(Problem.TOO_LARGE);
    expect(problemOf(`"${'é'.repeat(5)}"`, { maxBytes: 12 })).toBe('accepted');
  });
});

describe('isUnsafeNumber', () => {
  it.each([
    [0, false], [9007199254740991, false], [-9007199254740991, false], [9007199254740992, true], [-9007199254740992, true],
    [1e300, true], [0.5, false], [-0, false], [9007199254740994, true], [Number.POSITIVE_INFINITY, true], [Number.NEGATIVE_INFINITY, true],
  ])('%s is %s', (value, unsafe) => {
    expect(isUnsafeNumber(value)).toBe(unsafe);
  });
});
