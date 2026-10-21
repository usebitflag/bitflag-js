import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '../../src/protocol/parser.js';
import { validateSnapshot, ValidationCode } from '../../src/protocol/validator.js';
import { flag, ruleOn, validText, type Obj } from '../support/snapshots.js';

const issuesOf = (mutate: (s: Obj) => Obj): [string, string][] => validateSnapshot(parseSnapshot(validText(mutate))).map((issue) => [issue.code, issue.path]);
const needs = (...keys: string[]): Obj[] => keys.map((flagKey) => ({ flagKey, variations: ['on'] }));
const rollout = (salt: string, extra: Obj = {}): Obj[] => [ruleOn('r', { all: [] }, { rollout: { bucketBy: 'key', salt, slots: [{ variation: 'on', weight: 10000 }], remainderVariation: 'off', ...extra } })];

describe('validateSnapshot', () => {
  it('finds nothing wrong in a sound snapshot', () => {
    expect(
      issuesOf((s) => ({
        ...s,
        flags: {
          base: flag({ requires: ['rollouts.v1'], rules: [ruleOn('r1', { all: [{ op: 'in_segment', values: ['beta'] }] }, { rollout: { bucketBy: 'key', salt: 's1', slots: [{ variation: 'on', weight: 10000 }], remainderVariation: 'off' } })] }),
          child: flag({ requires: ['prerequisites.v1'], prerequisites: [{ flagKey: 'base', variations: ['on', 'off'] }] }),
        },
        segments: { beta: { version: 1, match: { all: [] } } },
        requiredCapabilities: ['prerequisites.v1', 'rollouts.v1'],
      })),
    ).toEqual([]);
  });

  it('reports a dangling variation wherever one is referenced', () => {
    const issues = issuesOf((s) => ({
      ...s,
      flags: {
        f: flag({
          offVariation: 'x1',
          defaultVariation: 'x2',
          overrides: [{ kind: 'user', key: 'u', variation: 'x3', expiresAt: null }],
          rules: [ruleOn('a', { all: [] }, { variation: 'x4' }), ruleOn('b', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'x5', weight: 10 }], remainderVariation: 'x6' } })],
        }),
        g: flag({ prerequisites: [{ flagKey: 'f', variations: ['on', 'x7'] }] }),
      },
    }));
    expect(issues).toEqual([
      [ValidationCode.DANGLING_VARIATION, '/flags/f/offVariation'],
      [ValidationCode.DANGLING_VARIATION, '/flags/f/defaultVariation'],
      [ValidationCode.DANGLING_VARIATION, '/flags/f/overrides/0/variation'],
      [ValidationCode.DANGLING_VARIATION, '/flags/f/rules/0/serve/variation'],
      [ValidationCode.DANGLING_VARIATION, '/flags/f/rules/1/serve/rollout/slots/0/variation'],
      [ValidationCode.DANGLING_VARIATION, '/flags/f/rules/1/serve/rollout/remainderVariation'],
      [ValidationCode.DANGLING_VARIATION, '/flags/g/prerequisites/0/variations/1'],
    ]);
  });

  it('reports missing segments in rules and in segments', () => {
    const issues = issuesOf((s) => ({
      ...s,
      flags: { f: flag({ rules: [ruleOn('r', { all: [{ any: [{ op: 'in_segment', values: ['ok', 'ghost'] }] }] })] }) },
      segments: { ok: { version: 1, match: { all: [] } }, inner: { version: 1, match: { all: [{ op: 'not_in_segment', values: ['missing'] }] } } },
    }));
    expect(issues).toEqual([
      [ValidationCode.DANGLING_SEGMENT, '/flags/f/rules/0/match/all/0/any/0/values/1'],
      [ValidationCode.DANGLING_SEGMENT, '/segments/inner/match/all/0/values/0'],
    ]);
  });

  it('reports a missing prerequisite flag', () => {
    expect(issuesOf((s) => ({ ...s, flags: { f: flag({ prerequisites: needs('ghost') }) } }))).toEqual([[ValidationCode.DANGLING_PREREQUISITE, '/flags/f/prerequisites/0/flagKey']]);
  });

  it('reports prerequisite cycles, including a flag that requires itself, but not a shared prerequisite', () => {
    const cycles = issuesOf((s) => ({ ...s, flags: { self: flag({ prerequisites: needs('self') }), a: flag({ prerequisites: needs('b') }), b: flag({ prerequisites: needs('c') }), c: flag({ prerequisites: needs('a') }), fine: flag({ prerequisites: needs('self') }) } }));
    expect(cycles).toContainEqual([ValidationCode.PREREQUISITE_CYCLE, '/flags/self/prerequisites/0']);
    expect(cycles).toContainEqual([ValidationCode.PREREQUISITE_CYCLE, '/flags/c/prerequisites/0']);
    expect(cycles.filter(([code]) => code === ValidationCode.PREREQUISITE_CYCLE)).toHaveLength(2);

    expect(issuesOf((s) => ({ ...s, flags: { a: flag(), b: flag({ prerequisites: needs('a') }), c: flag({ prerequisites: needs('a') }), d: flag({ prerequisites: needs('b', 'c') }) } }))).toEqual([]);
  });

  it('reports flags whose prerequisite chain is longer than ten links', () => {
    const chain = (length: number): Record<string, Obj> => Object.fromEntries(Array.from({ length: length + 1 }, (_, i) => [`f${String(i)}`, i < length ? flag({ prerequisites: needs(`f${String(i + 1)}`) }) : flag()]));
    expect(issuesOf((s) => ({ ...s, flags: chain(10) }))).toEqual([]);
    expect(issuesOf((s) => ({ ...s, flags: chain(11) }))).toEqual([[ValidationCode.PREREQUISITE_DEPTH, '/flags/f0']]);
  });

  it('reports segments that lead back to themselves', () => {
    const refer = (to: string): Obj => ({ version: 1, match: { all: [{ op: 'in_segment', values: [to] }] } });
    expect(issuesOf((s) => ({ ...s, segments: { a: refer('b'), b: refer('a'), self: refer('self'), ok: refer('a') } }))).toEqual([
      [ValidationCode.SEGMENT_CYCLE, '/segments/b/match'],
      [ValidationCode.SEGMENT_CYCLE, '/segments/self/match'],
    ]);
  });

  it.each([
    ['exact', ['dates.v1', 'segments.v1'], false], ['other order', ['segments.v1', 'dates.v1'], false], ['missing one', ['segments.v1'], true],
    ['extra one', ['segments.v1', 'dates.v1', 'rollouts.v1'], true], ['empty', [], true],
  ])('requires the capability list to be the union of what flags require: %s', (_name, required, mismatch) => {
    const issues = issuesOf((s) => ({ ...s, flags: { a: flag({ requires: ['segments.v1'] }), b: flag({ requires: ['segments.v1', 'dates.v1'] }) }, requiredCapabilities: required }));
    expect(issues).toEqual(mismatch ? [[ValidationCode.CAPABILITY_UNION_MISMATCH, '/requiredCapabilities']] : []);
  });

  it('reports a salt shared by unrelated rollouts but not by linked ones', () => {
    const linked = { experimentId: 'exp_1', allocationId: 'alc_1' };
    expect(issuesOf((s) => ({ ...s, flags: { a: flag({ rules: rollout('same') }), b: flag({ rules: rollout('same') }), c: flag({ rules: rollout('other') }) } }))).toEqual([[ValidationCode.DUPLICATE_SALT, '/flags/b/rules/0/serve/rollout/salt']]);
    expect(issuesOf((s) => ({ ...s, flags: { a: flag({ rules: rollout('same', linked) }), b: flag({ rules: rollout('same', linked) }) } }))).toEqual([]);
    expect(issuesOf((s) => ({ ...s, flags: { a: flag({ rules: rollout('same', { experimentId: 'e1', allocationId: 'a1' }) }), b: flag({ rules: rollout('same', { experimentId: 'e2', allocationId: 'a2' }) }) } }))).toEqual([[ValidationCode.DUPLICATE_SALT, '/flags/b/rules/0/serve/rollout/salt']]);
  });
});
