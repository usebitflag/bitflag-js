import { describe, expect, it } from 'vitest';
import { readContext, validateContext } from '../../src/evaluation/context.js';

const parse = (json: string): unknown => JSON.parse(json);

describe('contexts', () => {
  it('accepts a minimal and a full context', () => {
    expect(validateContext({ kind: 'user' })).toEqual([]);
    expect(validateContext({ kind: 'user', key: 'u_1', attributes: { plan: 'pro', n: 1.5, b: false, z: null, tags: ['a', 'b'] } })).toEqual([]);
  });

  it('exposes kind, key and attributes as a normalized context', () => {
    const result = readContext({ kind: 'user', key: 'u_1', attributes: { plan: 'pro', __proto__: 'x' } });
    expect('context' in result && result.context.kind).toBe('user');
    expect('context' in result && result.context.key).toBe('u_1');
    expect('context' in result && result.context.attributes.get('plan')).toBe('pro');
    expect(readContext({ kind: 'user' })).toEqual({ context: { kind: 'user', key: null, attributes: new Map() } });
  });

  it.each<[string, string]>([
    ['no kind', '{"key":"u_1"}'], ['empty object', '{}'], ['kind is null', '{"kind":null}'], ['kind is a number', '{"kind":1}'], ['kind in upper case', '{"kind":"User"}'],
    ['kind starts with a digit', '{"kind":"1user"}'], ['empty kind', '{"kind":""}'], ['kind of 65 characters', `{"kind":"${'a'.repeat(65)}"}`],
    ['type instead of kind', '{"type":"user","key":"u_1"}'], ['unknown member', '{"kind":"user","email":"x"}'], ['numeric key', '{"kind":"user","key":20931}'],
    ['boolean key', '{"kind":"user","key":true}'], ['null key', '{"kind":"user","key":null}'], ['empty key', '{"kind":"user","key":""}'],
    ['key of 257 bytes', `{"kind":"user","key":"${'k'.repeat(257)}"}`], ['key of 258 bytes in 129 characters', `{"kind":"user","key":"${'é'.repeat(129)}"}`],
    ['attributes as a list', '{"kind":"user","attributes":[]}'], ['attributes as text', '{"kind":"user","attributes":"a"}'], ['attributes null', '{"kind":"user","attributes":null}'],
    ['attribute named key', '{"kind":"user","attributes":{"key":"x"}}'], ['attribute named kind', '{"kind":"user","attributes":{"kind":"x"}}'],
    ['empty attribute name', '{"kind":"user","attributes":{"":1}}'], ['attribute name of 129 bytes', `{"kind":"user","attributes":{"${'n'.repeat(129)}":1}}`],
    ['attribute name of 130 bytes in 65 characters', `{"kind":"user","attributes":{"${'é'.repeat(65)}":1}}`], ['object value', '{"kind":"user","attributes":{"v":{"a":1}}}'],
    ['empty object value', '{"kind":"user","attributes":{"v":{}}}'], ['mixed array', '{"kind":"user","attributes":{"v":["a",1]}}'],
    ['number and boolean array', '{"kind":"user","attributes":{"v":[1,true]}}'], ['array with null', '{"kind":"user","attributes":{"v":["a",null]}}'],
    ['nested array', '{"kind":"user","attributes":{"v":[["a"]]}}'], ['array of objects', '{"kind":"user","attributes":{"v":[{"a":1}]}}'],
    ['string of 1025 bytes', `{"kind":"user","attributes":{"v":"${'s'.repeat(1025)}"}}`], ['string of 1026 bytes in 513 characters', `{"kind":"user","attributes":{"v":"${'é'.repeat(513)}"}}`],
    ['array of 101 items', `{"kind":"user","attributes":{"v":[${Array(101).fill('1').join(',')}]}}`], ['array item over 1024 bytes', `{"kind":"user","attributes":{"v":["${'s'.repeat(1025)}"]}}`],
    ['not an object: null', 'null'], ['not an object: text', '"u_1"'], ['not an object: list', '[{"kind":"user"}]'], ['not an object: number', '7'],
  ])('rejects: %s', (_name, json) => {
    expect(validateContext(parse(json))).not.toEqual([]);
  });

  it.each<[string, string]>([
    ['kind of 64 characters', `{"kind":"${'a'.repeat(64)}"}`], ['key of 256 bytes', `{"kind":"user","key":"${'k'.repeat(256)}"}`],
    ['key of 128 two-byte characters', `{"kind":"user","key":"${'é'.repeat(128)}"}`], ['key of 64 four-byte characters', `{"kind":"user","key":"${'😀'.repeat(64)}"}`],
    ['attribute name of 128 bytes', `{"kind":"user","attributes":{"${'n'.repeat(128)}":1}}`], ['string of 1024 bytes', `{"kind":"user","attributes":{"v":"${'s'.repeat(1024)}"}}`],
    ['array of 100 items', `{"kind":"user","attributes":{"v":[${Array(100).fill('"a"').join(',')}]}}`], ['empty array value', '{"kind":"user","attributes":{"v":[]}}'],
    ['integers beyond the safe range are valid values', '{"kind":"user","attributes":{"v":9007199254740993}}'], ['Key and Kind are ordinary names', '{"kind":"user","attributes":{"Key":"a","Kind":"b"}}'],
  ])('accepts: %s', (_name, json) => {
    expect(validateContext(parse(json))).toEqual([]);
  });

  it('accepts 100 attributes and rejects 101', () => {
    const attributes = (count: number): Record<string, number> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${String(i)}`, i]));
    expect(validateContext({ kind: 'user', attributes: attributes(100) })).toEqual([]);
    expect(validateContext({ kind: 'user', attributes: attributes(101) })).not.toEqual([]);
  });

  it('rejects what JSON cannot hold', () => {
    expect(validateContext({ kind: 'user', attributes: { v: Number.NaN } })).not.toEqual([]);
    expect(validateContext({ kind: 'user', attributes: { v: Number.POSITIVE_INFINITY } })).not.toEqual([]);
    expect(validateContext({ kind: 'user', attributes: { v: undefined } })).not.toEqual([]);
    expect(validateContext({ kind: 'user', attributes: { v: new Date() } })).not.toEqual([]);
    expect(validateContext({ kind: 'user', attributes: { v: [Number.NaN] } })).not.toEqual([]);
  });

  it('rejects unpaired surrogates, which have no UTF-8 form', () => {
    expect(validateContext({ kind: 'user', key: 'a\ud800' })).not.toEqual([]);
    expect(validateContext({ kind: 'user', attributes: { v: '\udc00' } })).not.toEqual([]);
    expect(validateContext({ kind: 'user', attributes: { ['n\ud800']: 1 } })).not.toEqual([]);
    expect(validateContext({ kind: 'user', key: '😀' })).toEqual([]);
  });

  it('treats an absent key and an undefined key alike, and keeps __proto__ ordinary', () => {
    expect(validateContext({ kind: 'user', key: undefined })).toEqual([]);
    expect(validateContext(parse('{"kind":"user","attributes":{"__proto__":"x"}}'))).toEqual([]);
  });
});
