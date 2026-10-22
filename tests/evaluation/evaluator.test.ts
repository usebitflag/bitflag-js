import { describe, expect, it } from 'vitest';
import { bucket } from '../../src/evaluation/bucketing.js';
import { Evaluator, FallbackTypeError, type EvaluationResult } from '../../src/evaluation/evaluator.js';
import type { FlagType } from '../../src/evaluation/types.js';
import type { Json } from '../../src/protocol/json.js';
import { parseSnapshot } from '../../src/protocol/parser.js';
import { flag, ruleOn, validText, type Obj } from '../support/snapshots.js';

const NOW = new Date('2026-10-06T08:00:00Z');

function evaluatorFor(flags: Record<string, Obj>, extra: { segments?: Obj; now?: Date; supported?: string[] } = {}): Evaluator {
  const text = validText((s) => ({ ...s, flags, segments: extra.segments ?? {} }));
  return new Evaluator(parseSnapshot(text), {
    clock: { now: () => extra.now ?? NOW },
    ...(extra.supported === undefined ? {} : { supportedCapabilities: extra.supported }),
  });
}

const user = (key: string | null = 'u_1', attributes: Obj = {}, kind = 'user'): Obj => ({ kind, ...(key === null ? {} : { key }), attributes });
const matchAll = (variation = 'on', id = 'r1'): Obj => ruleOn(id, { all: [] }, { variation });
const when = (attribute: string, value: Json, variation = 'on', id = 'r1'): Obj => ruleOn(id, { all: [{ attribute, op: 'eq', values: [value] }] }, { variation });
const rollout = (salt: string, weight: number, extra: Obj = {}): Obj => ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt, slots: [{ variation: 'on', weight }], remainderVariation: 'off', ...extra } });
const override = (key: string, variation = 'on', expiresAt: string | null = null): Obj => ({ kind: 'user', key, variation, expiresAt });

function keyInBucket(salt: string, low: number, high: number): string {
  for (let i = 0; ; i += 1) {
    const value = bucket(salt, 'user', `k_${String(i)}`);
    if (value >= low && value < high) {
      return `k_${String(i)}`;
    }
  }
}

const reasonOf = (result: EvaluationResult): string => result.reason;

describe('precedence', () => {
  it('serves the default variation when no rule matches', () => {
    const result = evaluatorFor({ f: flag({ defaultVariation: 'on' }) }).evaluateBoolean('f', user(), false);
    expect(result).toMatchObject({ value: true, variationKey: 'on', reason: 'DEFAULT', revision: 42, generation: 1, evaluatedAt: '2026-10-06T08:00:00Z' });
  });

  it('serves the off variation of a disabled flag whatever else is configured', () => {
    const result = evaluatorFor({ f: flag({ enabled: false, rules: [matchAll()], overrides: [override('u_1')] }) }).evaluateBoolean('f', user(), true);
    expect(result).toMatchObject({ reason: 'OFF', variationKey: 'off', value: false });
  });

  it('decides in order: override, then the first matching enabled rule, then the default', () => {
    const evaluator = evaluatorFor({
      f: flag({ overrides: [override('u_vip')], rules: [{ ...matchAll('on', 'x'), enabled: false }, when('plan', 'pro', 'on', 'pro'), when('plan', 'pro', 'off', 'shadowed')] }),
    });
    expect(evaluator.evaluateBoolean('f', user('u_vip', { plan: 'pro' }), false).reason).toBe('OVERRIDE');
    expect(evaluator.evaluateBoolean('f', user('u_x', { plan: 'pro' }), false).ruleId).toBe('pro');
    expect(evaluator.evaluateBoolean('f', user('u_x', { plan: 'free' }), true).reason).toBe('DEFAULT');
  });

  it('matches overrides on kind and key exactly and not for a context without a key', () => {
    const evaluator = evaluatorFor({ f: flag({ overrides: [override('u_vip')] }) });
    expect(evaluator.evaluateBoolean('f', user('u_vip'), false).reason).toBe('OVERRIDE');
    expect(evaluator.evaluateBoolean('f', user('U_VIP'), false).reason).toBe('DEFAULT');
    expect(evaluator.evaluateBoolean('f', user('u_vip', {}, 'organization'), false).reason).toBe('DEFAULT');
    expect(evaluator.evaluateBoolean('f', user(null), false).reason).toBe('DEFAULT');
  });

  it.each([
    ['a millisecond before', '2026-10-06T07:59:59.999Z', 'OVERRIDE'],
    ['at the instant', '2026-10-06T08:00:00Z', 'DEFAULT'],
    ['a millisecond after', '2026-10-06T08:00:00.001Z', 'DEFAULT'],
  ])('expires overrides at the instant, strictly: %s', (_name, at, expected) => {
    const evaluator = evaluatorFor({ f: flag({ overrides: [override('u_1', 'on', '2026-10-06T08:00:00Z')] }) });
    expect(evaluator.evaluateBoolean('f', user(), false, { at: new Date(at) }).reason).toBe(expected);
  });

  it('uses the clock when the options give no time and reports the instant it used', () => {
    const f = flag({ overrides: [override('u_1', 'on', '2026-10-06T09:00:00Z')] });
    const before = evaluatorFor({ f }, { now: new Date('2026-10-06T08:59:59.500Z') }).evaluateBoolean('f', user(), false);
    const after = evaluatorFor({ f }, { now: new Date('2026-10-06T09:00:00Z') }).evaluateBoolean('f', user(), false);
    expect(reasonOf(before)).toBe('OVERRIDE');
    expect(before.evaluatedAt).toBe('2026-10-06T08:59:59.500Z');
    expect(reasonOf(after)).toBe('DEFAULT');
  });

  it('rejects an invalid evaluation time', () => {
    expect(() => evaluatorFor({ f: flag() }).evaluateBoolean('f', user(), false, { at: new Date('nonsense') })).toThrow(TypeError);
  });
});

describe('fallbacks and errors', () => {
  it('returns the caller fallback for an unknown flag or the wrong type', () => {
    const evaluator = evaluatorFor({ f: flag() });
    const missing = evaluator.evaluateString('nope', user(), 'x');
    const mismatch = evaluator.evaluateString('f', user(), 'x');
    expect(missing).toMatchObject({ value: 'x', variationKey: null, reason: 'FALLBACK', errorKind: 'FLAG_NOT_FOUND' });
    expect(mismatch).toMatchObject({ value: 'x', errorKind: 'TYPE_MISMATCH', revision: 42 });
  });

  it('returns the fallback with INVALID_CONTEXT for an invalid context, before the flag is looked up', () => {
    const result = evaluatorFor({ f: flag() }).evaluateBoolean('missing', { key: 'u_1' }, true);
    expect(result).toMatchObject({ reason: 'ERROR', errorKind: 'INVALID_CONTEXT', value: true });
  });

  it.each<[string, FlagType, unknown]>([
    ['string for boolean', 'boolean', 'yes'], ['number for boolean', 'boolean', 1], ['null for string', 'string', null], ['number for string', 'string', 5],
    ['text for number', 'number', '5'], ['NaN for number', 'number', Number.NaN], ['infinity for number', 'number', Number.POSITIVE_INFINITY],
    ['a Date for json', 'json', new Date()], ['NaN inside json', 'json', [Number.NaN]], ['undefined for json', 'json', undefined], ['a Map for json', 'json', new Map()],
  ])('throws only for a fallback of the wrong type, before anything else: %s', (_name, type, fallback) => {
    expect(() => evaluatorFor({ f: flag() }).evaluate('missing', { key: 'u_1' }, type, fallback)).toThrow(FallbackTypeError);
  });

  it('accepts fallbacks of every type', () => {
    const evaluator = evaluatorFor({});
    expect(evaluator.evaluateNumber('x', user(), 5).value).toBe(5);
    expect(evaluator.evaluateNumber('x', user(), 5.5).value).toBe(5.5);
    expect(evaluator.evaluateJson('x', user(), { a: [1, null] }).value).toEqual({ a: [1, null] });
    expect(evaluator.evaluateJson('x', user(), null).value).toBeNull();
  });

  it('serves string, number and json values', () => {
    const evaluator = evaluatorFor({
      s: flag({ type: 'string', variations: { hello: 'Hello', off: '' }, defaultVariation: 'hello' }),
      n: flag({ type: 'number', variations: { ten: 10, off: 0 }, defaultVariation: 'ten' }),
      j: flag({ type: 'json', variations: { cfg: { a: [1, 2] }, off: null }, defaultVariation: 'cfg' }),
    });
    expect(evaluator.evaluateString('s', user(), '').value).toBe('Hello');
    expect(evaluator.evaluateNumber('n', user(), 0).value).toBe(10);
    expect(evaluator.evaluateJson('j', user(), null).value).toEqual({ a: [1, 2] });
  });

  it('treats a dangling variation as a configuration error only when it is served', () => {
    const evaluator = evaluatorFor({ f: flag({ defaultVariation: 'ghost', rules: [when('plan', 'pro')] }) });
    expect(evaluator.evaluateBoolean('f', user('u_1', { plan: 'pro' }), false).reason).toBe('RULE');
    expect(evaluator.evaluateBoolean('f', user('u_1', { plan: 'free' }), true).errorKind).toBe('INVALID_CONFIG');
  });

  it('supports exactly the capabilities of protocol version 1 unless told otherwise', () => {
    const flags = { f: flag({ requires: ['future.v9'], defaultVariation: 'on' }), g: flag({ requires: ['segments.v1'], defaultVariation: 'on' }) };
    expect(Evaluator.supportedCapabilities()).toEqual(['operators.v1', 'semver.v1', 'dates.v1', 'segments.v1', 'prerequisites.v1', 'rollouts.v1', 'experiments.v1']);
    expect(evaluatorFor(flags).evaluateBoolean('f', user(), false).errorKind).toBe('UNSUPPORTED_CAPABILITY');
    expect(evaluatorFor(flags).evaluateBoolean('g', user(), false).value).toBe(true);
    expect(evaluatorFor(flags, { supported: [...Evaluator.supportedCapabilities(), 'future.v9'] }).evaluateBoolean('f', user(), false).value).toBe(true);
    expect(evaluatorFor(flags, { supported: [] }).evaluateBoolean('g', user(), true).errorKind).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('segments', () => {
  const segment = { version: 1, match: { all: [{ attribute: 'country', op: 'eq', values: ['PH'] }] }, include: [{ kind: 'user', key: 'u_in' }, { kind: 'user', key: 'u_both' }], exclude: [{ kind: 'user', key: 'u_out' }, { kind: 'user', key: 'u_both' }] };
  const inSegment = (...keys: string[]): Obj => ruleOn('r1', { all: [{ op: 'in_segment', values: keys }] });

  it('decides membership: exclude, then include, then conditions', () => {
    const evaluator = evaluatorFor({ f: flag({ rules: [inSegment('ph')] }) }, { segments: { ph: segment } });
    const isOn = (context: Obj): boolean => evaluator.evaluateBoolean('f', context, false).value === true;
    expect(isOn(user('u_in', { country: 'US' }))).toBe(true);
    expect(isOn(user('u_x', { country: 'PH' }))).toBe(true);
    expect(isOn(user('u_x', { country: 'US' }))).toBe(false);
    expect(isOn(user('u_out', { country: 'PH' }))).toBe(false);
    expect(isOn(user('u_both', { country: 'PH' }))).toBe(false);
    expect(isOn(user(null, { country: 'PH' }))).toBe(true);
    expect(isOn(user('u_in', { country: 'US' }, 'organization'))).toBe(false);
  });

  it('reports a missing segment as a configuration error when it is evaluated', () => {
    const result = evaluatorFor({ f: flag({ rules: [inSegment('ghost')] }) }).evaluateBoolean('f', user(), true);
    expect(result).toMatchObject({ errorKind: 'INVALID_CONFIG', reason: 'ERROR', value: true });
  });

  it('stops a segment that refers back to itself, and allows one to use another', () => {
    const cyclic = { a: { version: 1, match: { all: [{ op: 'in_segment', values: ['b'] }] } }, b: { version: 1, match: { all: [{ op: 'in_segment', values: ['a'] }] } } };
    expect(evaluatorFor({ f: flag({ rules: [inSegment('a')] }) }, { segments: cyclic }).evaluateBoolean('f', user(), false).errorKind).toBe('INVALID_CONFIG');

    const nested = { outer: { version: 1, match: { all: [{ op: 'in_segment', values: ['inner'] }] } }, inner: { version: 1, match: { all: [{ attribute: 'plan', op: 'eq', values: ['pro'] }] } } };
    const evaluator = evaluatorFor({ f: flag({ rules: [inSegment('outer')] }) }, { segments: nested });
    expect(evaluator.evaluateBoolean('f', user('u_1', { plan: 'pro' }), false).value).toBe(true);
    expect(evaluator.evaluateBoolean('f', user('u_1', { plan: 'free' }), true).value).toBe(false);
  });
});

describe('rollouts', () => {
  it('rolls out by bucket and reports the bucket only on request', () => {
    const evaluator = evaluatorFor({ f: flag({ rules: [rollout('s_roll', 50000)] }) });
    const inside = keyInBucket('s_roll', 0, 50000);
    const outside = keyInBucket('s_roll', 50000, 100000);

    const withDetails = evaluator.evaluateBoolean('f', user(inside), false, { details: true });
    expect(withDetails).toMatchObject({ value: true, reason: 'RULE', ruleId: 'r1', bucket: bucket('s_roll', 'user', inside) });
    expect(evaluator.evaluateBoolean('f', user(inside), false).bucket).toBeNull();
    expect(evaluator.evaluateBoolean('f', user(outside), true, { details: true })).toMatchObject({ value: false, variationKey: 'off' });
  });

  it('copies experiment fields from the deciding rollout', () => {
    const evaluator = evaluatorFor({ f: flag({ rules: [rollout('s_exp', 30000, { experimentId: 'exp_1', allocationId: 'alc_1' })] }) });
    for (const key of [keyInBucket('s_exp', 0, 30000), keyInBucket('s_exp', 30000, 100000)]) {
      expect(evaluator.evaluateBoolean('f', user(key), false)).toMatchObject({ experimentId: 'exp_1', allocationId: 'alc_1' });
    }
  });

  it('returns MISSING_SUBJECT_KEY when a rollout cannot bucket', () => {
    const result = evaluatorFor({ f: flag({ rules: [rollout('s_roll', 50000)] }) }).evaluateBoolean('f', { kind: 'user' }, true);
    expect(result).toMatchObject({ reason: 'ERROR', errorKind: 'MISSING_SUBJECT_KEY', value: true, variationKey: null });
  });

  it.each<[string, unknown, boolean]>([
    ['a string', 'acme', true], ['a number', 123, false], ['a boolean', true, false], ['an empty string', '', false], ['null', null, false], ['a list', ['a'], false],
  ])('buckets by an attribute, which must be a non-empty string: %s', (_name, value, ok) => {
    const byOrg = ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'org', salt: 's', slots: [{ variation: 'on', weight: 100000 }] } });
    const result = evaluatorFor({ f: flag({ rules: [byOrg] }) }).evaluateBoolean('f', { kind: 'user', attributes: { org: value } }, false);
    expect(result.errorKind).toBe(ok ? null : 'MISSING_SUBJECT_KEY');
  });
});

describe('prerequisites', () => {
  const needs = (flagKey: string, ...variations: string[]): Obj => ({ flagKey, variations });

  it('serves the off variation for an unmet prerequisite, and a prerequisite error is an error', () => {
    const evaluator = evaluatorFor({
      base: flag({ rules: [when('plan', 'pro')] }),
      child: flag({ defaultVariation: 'on', prerequisites: [needs('base', 'on')] }),
      broken: flag({ defaultVariation: 'on', prerequisites: [needs('ghost', 'on')] }),
      parent: flag({ defaultVariation: 'on', prerequisites: [needs('broken', 'on')] }),
    });
    const unmet = evaluator.evaluateBoolean('child', user('u_1', { plan: 'free' }), true);

    expect(evaluator.evaluateBoolean('child', user('u_1', { plan: 'pro' }), false).reason).toBe('DEFAULT');
    expect(unmet).toMatchObject({ reason: 'PREREQUISITE', prerequisiteKey: 'base', variationKey: 'off', value: false });
    expect(evaluator.evaluateBoolean('parent', user(), true).errorKind).toBe('INVALID_CONFIG');
  });

  it('rejects cycles, self-references and chains that are too deep', () => {
    const link = (to: string): Obj => flag({ defaultVariation: 'on', prerequisites: [needs(to, 'on')] });
    const chain: Record<string, Obj> = {};
    for (let i = 0; i < 12; i += 1) {
      chain[`c${String(i)}`] = i < 11 ? link(`c${String(i + 1)}`) : flag({ defaultVariation: 'on' });
    }
    const evaluator = evaluatorFor({ self: link('self'), a: link('b'), b: link('a'), ...chain });

    expect(evaluator.evaluateBoolean('self', user(), true).errorKind).toBe('INVALID_CONFIG');
    expect(evaluator.evaluateBoolean('a', user(), true).errorKind).toBe('INVALID_CONFIG');
    expect(evaluator.evaluateBoolean('b', user(), true).errorKind).toBe('INVALID_CONFIG');
    expect(evaluator.evaluateBoolean('c1', user(), false).reason).toBe('DEFAULT');
    expect(evaluator.evaluateBoolean('c0', user(), true).errorKind).toBe('INVALID_CONFIG');
  });

  it('does not call a shared prerequisite a cycle', () => {
    const evaluator = evaluatorFor({
      base: flag({ rules: [when('plan', 'pro')] }),
      left: flag({ defaultVariation: 'on', prerequisites: [needs('base', 'on')] }),
      right: flag({ defaultVariation: 'on', prerequisites: [needs('base', 'on')] }),
      top: flag({ defaultVariation: 'on', prerequisites: [needs('left', 'on'), needs('right', 'on')] }),
    });
    expect(evaluator.evaluateBoolean('top', user('u_1', { plan: 'pro' }), false)).toMatchObject({ reason: 'DEFAULT', value: true });
  });
});
