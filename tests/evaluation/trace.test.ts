import { describe, expect, it } from 'vitest';
import { bucket } from '../../src/evaluation/bucketing.js';
import { Evaluator } from '../../src/evaluation/evaluator.js';
import { parseSnapshot } from '../../src/protocol/parser.js';
import { flag, ruleOn, validText, type Obj } from '../support/snapshots.js';

function evaluatorFor(flags: Record<string, Obj>): Evaluator {
  return new Evaluator(parseSnapshot(validText((s) => ({ ...s, flags }))), { clock: { now: () => new Date('2026-10-06T08:00:00Z') } });
}

const steps = (evaluator: Evaluator, key: string, context: unknown): unknown => evaluator.evaluateBoolean(key, context, false, { trace: true }).trace?.steps;

describe('traces', () => {
  it('are attached only on request', () => {
    const evaluator = evaluatorFor({ f: flag() });
    expect(evaluator.evaluateBoolean('f', { kind: 'user', key: 'u_1' }, false).trace).toBeUndefined();
    expect(evaluator.evaluateBoolean('f', { kind: 'user', key: 'u_1' }, false, { details: true }).trace).toBeUndefined();
  });

  it('record the steps of a default decision', () => {
    const rule = ruleOn('r1', { all: [{ attribute: 'plan', op: 'eq', values: ['pro'] }] });
    expect(steps(evaluatorFor({ f: flag({ rules: [rule] }) }), 'f', { kind: 'user', key: 'u_1', attributes: { plan: 'free' } })).toEqual([
      { step: 'rule', outcome: 'not_matched', ruleId: 'r1', conditions: [{ path: '/all/0', op: 'eq', attribute: 'plan', outcome: 'no_match' }] },
      { step: 'default', outcome: 'served' },
    ]);
  });

  it('record capability, off, prerequisite and override steps', () => {
    const evaluator = evaluatorFor({
      base: flag({ defaultVariation: 'on' }),
      off: flag({ enabled: false, requires: ['operators.v1'] }),
      child: flag({ defaultVariation: 'on', prerequisites: [{ flagKey: 'base', variations: ['on'] }], overrides: [{ kind: 'user', key: 'u_1', variation: 'off', expiresAt: '2026-10-06T07:00:00Z' }] }),
      live: flag({ overrides: [{ kind: 'user', key: 'u_1', variation: 'on', expiresAt: '2026-10-06T09:00:00Z' }] }),
    });
    const context = { kind: 'user', key: 'u_1' };

    expect(steps(evaluator, 'off', context)).toEqual([{ step: 'capability', outcome: 'supported' }, { step: 'off', outcome: 'served' }]);
    expect(steps(evaluator, 'child', context)).toEqual([
      { step: 'prerequisite', outcome: 'met', prerequisitePath: ['base'] },
      { step: 'override', outcome: 'expired', overrideExpiresAt: '2026-10-06T07:00:00Z' },
      { step: 'default', outcome: 'served' },
    ]);
    expect(steps(evaluator, 'live', context)).toEqual([{ step: 'override', outcome: 'applied', overrideExpiresAt: '2026-10-06T09:00:00Z' }]);
  });

  it('record the bucket and the slot of a rollout', () => {
    const rule = ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's_trace', slots: [{ variation: 'on', weight: 20000 }], remainderVariation: 'off' } });
    const number = bucket('s_trace', 'user', 'u_20931');
    const result = steps(evaluatorFor({ f: flag({ rules: [rule] }) }), 'f', { kind: 'user', key: 'u_20931' }) as { bucket: number; slot: unknown }[];

    expect(result).toHaveLength(1);
    expect(result[0]?.bucket).toBe(number);
    expect(result[0]?.slot).toEqual(number < 20000 ? { variation: 'on', start: 0, end: 20000 } : { variation: 'off', start: 20000, end: 100000 });
  });

  it('keep the steps taken before an error', () => {
    const rule = ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 100000 }] } });
    const result = evaluatorFor({ f: flag({ rules: [rule] }) }).evaluateBoolean('f', { kind: 'user' }, true, { trace: true });

    expect(result.errorKind).toBe('MISSING_SUBJECT_KEY');
    expect(result.trace?.steps).toEqual([{ step: 'rule', outcome: 'matched', ruleId: 'r1', conditions: [] }]);
  });

  it('record disabled rules without evaluating them', () => {
    const rules = [{ ...ruleOn('off', { all: [] }), enabled: false }];
    expect(steps(evaluatorFor({ f: flag({ rules }) }), 'f', { kind: 'user', key: 'u_1' })).toEqual([{ step: 'rule', outcome: 'disabled', ruleId: 'off' }, { step: 'default', outcome: 'served' }]);
  });

  it('never put context values in a trace', () => {
    const rule = ruleOn('r1', { all: [{ attribute: 'email', op: 'ends_with', values: ['@acme.dev'] }, { attribute: 'plan', op: 'in', values: ['pro'] }] });
    const result = evaluatorFor({ f: flag({ rules: [rule] }) }).evaluateBoolean('f', { kind: 'user', key: 'SECRET-KEY', attributes: { email: 'secret.person@acme.dev', plan: 'SECRET-PLAN' } }, false, { trace: true });
    const json = JSON.stringify(result.trace);

    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('secret.person');
  });
});

describe('evaluateAll', () => {
  const flags = {
    b: flag({ defaultVariation: 'on' }),
    s: flag({ type: 'string', variations: { hello: 'Hello', off: '' }, defaultVariation: 'hello' }),
    broken: flag({ defaultVariation: 'ghost' }),
    cycle: flag({ prerequisites: [{ flagKey: 'cycle', variations: ['on'] }] }),
  };

  it('evaluates every flag as its declared type', () => {
    const all = evaluatorFor(flags).evaluateAll({ kind: 'user', key: 'u_1' });

    expect([...all.results.keys()]).toEqual(['b', 's', 'broken', 'cycle']);
    expect([all.revision, all.generation]).toEqual([42, 1]);
    expect(all.results.get('b')?.value).toBe(true);
    expect(all.results.get('s')?.value).toBe('Hello');
    expect(all.results.get('broken')).toMatchObject({ reason: 'ERROR', value: null, variationKey: null, errorKind: 'INVALID_CONFIG' });
    expect(all.results.get('cycle')?.errorKind).toBe('INVALID_CONFIG');
  });

  it('evaluates nothing for an invalid context and lists no fallback results', () => {
    const all = evaluatorFor({ b: flag() }).evaluateAll({ key: 'u_1' });
    expect(all.results.get('b')).toMatchObject({ errorKind: 'INVALID_CONTEXT', value: null });
  });

  it('honours the details and trace options', () => {
    const rule = ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 100000 }] } });
    const all = evaluatorFor({ f: flag({ rules: [rule] }) }).evaluateAll({ kind: 'user', key: 'u_1' }, { details: true, trace: true });
    expect(all.results.get('f')?.bucket).toBe(bucket('s', 'user', 'u_1'));
    expect(all.results.get('f')?.trace).toBeDefined();
  });
});
