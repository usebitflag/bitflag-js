import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../src/protocol/canonical.js';
import { computeChecksum, verifyChecksum } from '../../src/protocol/checksum.js';
import { MalformedSnapshot, Problem } from '../../src/protocol/errors.js';
import { decodeJson, type Json } from '../../src/protocol/json.js';
import { sha256, toHex } from '../../src/evaluation/sha256.js';

const parse = (text: string): Json => decodeJson(text);

describe('canonicalize', () => {
  it('writes the RFC 8785 sample', () => {
    const input = parse('{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}');
    expect(canonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  it('sorts member names by UTF-16 code units', () => {
    const input = parse('{"\\u20ac":"Euro","\\r":"CR","\\ufb33":"Dalet","1":"One","\\ud83d\\ude00":"Emoji","\\u0080":"Control","\\u00f6":"O"}');
    expect(canonicalize(input)).toBe('{"\\r":"CR","1":"One","\u0080":"Control","\u00f6":"O","\u20ac":"Euro","\ud83d\ude00":"Emoji","\ufb33":"Dalet"}');
  });

  it('sorts shorter names first only after the common prefix', () => {
    expect(canonicalize(parse('{"ab":1,"a":2,"b":3,"aa":4,"10":5,"9":6}'))).toBe('{"10":5,"9":6,"a":2,"aa":4,"ab":1,"b":3}');
  });

  it.each([
    [0, '0'], [-0, '0'], [1, '1'], [-1, '-1'], [100, '100'], [0.5, '0.5'], [0.1 + 0.2, '0.30000000000000004'], [1e20, '100000000000000000000'], [1e21, '1e+21'],
    [999999999999999900000, '999999999999999900000'], [1e-6, '0.000001'], [1e-7, '1e-7'], [1.5e-7, '1.5e-7'], [1.7976931348623157e308, '1.7976931348623157e+308'],
    [5e-324, '5e-324'], [9007199254740992, '9007199254740992'], [Number('1424953923781206.2'), '1424953923781206.2'], [-1.5e-10, '-1.5e-10'], [1e23, '1e+23'],
  ])('writes the number %s as %s', (value, expected) => {
    expect(canonicalize(value)).toBe(expected);
  });

  it('escapes strings minimally', () => {
    expect(canonicalize('a"b\\c/d\b\t\n\f\r\u0000\u001f\u007f\u2028')).toBe('"a\\"b\\\\c/d\\b\\t\\n\\f\\r\\u0000\\u001f\u007f\u2028"');
  });

  it('writes non-ASCII text as UTF-8, not as escapes', () => {
    expect(canonicalize('é日本語😀')).toBe('"é日本語😀"');
  });

  it('keeps list order and nests', () => {
    expect(canonicalize(parse('[[3,2,1],[{"b":1,"a":2}],"b","a",{}, []]'))).toBe('[[3,2,1],[{"a":2,"b":1}],"b","a",{},[]]');
  });

  it('refuses numbers without a JSON form', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('checksum', () => {
  const object = (text: string): { [key: string]: Json } => parse(text) as { [key: string]: Json };

  it('is sha256: and the hash of the canonical form without the checksum member', () => {
    const expected = toHex(sha256(new TextEncoder().encode('{"a":[true],"b":1}')));
    expect(computeChecksum(object('{"b":1,"a":[true],"checksum":"sha256:ignored"}'))).toBe(`sha256:${expected}`);
  });

  it('does not depend on member order, whitespace or the checksum itself', () => {
    expect(computeChecksum(object('{"a":1,"b":{"c":2,"d":3}}'))).toBe(computeChecksum(object(' {\n "b" : {"d":3, "c":2}, "a":1.0, "checksum":"x" }')));
  });

  it('changes when any other member changes, and keeps a nested checksum member', () => {
    expect(computeChecksum(object('{"revision":42}'))).not.toBe(computeChecksum(object('{"revision":43}')));
    expect(computeChecksum(object('{"a":{"checksum":"x"}}'))).not.toBe(computeChecksum(object('{"a":{}}')));
  });

  it('verifies a matching checksum and rejects anything else', () => {
    const snapshot = object('{"a":1}');
    snapshot.checksum = computeChecksum(snapshot);
    expect(() => {
      verifyChecksum(snapshot);
    }).not.toThrow();

    for (const bad of ['{"a":1,"checksum":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}', '{"a":1}', '{"a":1,"checksum":5}']) {
      try {
        verifyChecksum(object(bad));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(MalformedSnapshot);
        expect((error as MalformedSnapshot).problem).toBe(Problem.CHECKSUM_MISMATCH);
        expect((error as MalformedSnapshot).path).toBe('/checksum');
      }
    }
  });
});
