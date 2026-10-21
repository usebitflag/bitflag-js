import { describe, expect, it } from 'vitest';
import { MalformedSnapshot, Problem } from '../../src/protocol/errors.js';
import { isGroup } from '../../src/protocol/model.js';
import { parseSnapshot } from '../../src/protocol/parser.js';
import { baseSnapshot, flag, ruleOn, snapshotText, validText, type Obj } from '../support/snapshots.js';

function rejection(mutate: (snapshot: Obj) => Obj | undefined, withChecksum = true): MalformedSnapshot {
  const snapshot = baseSnapshot();
  const changed = mutate(snapshot) ?? snapshot;
  try {
    parseSnapshot(snapshotText(changed, withChecksum));
  } catch (error) {
    if (error instanceof MalformedSnapshot) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the snapshot to be rejected.');
}

const withFlag = (overrides: Obj) => (s: Obj): undefined => {
  s.flags = { checkout: flag(overrides) };
  return undefined;
};
const rules = (...list: Obj[]) => withFlag({ rules: list });
const all = (...members: unknown[]): Obj => ({ all: members as never });

describe('parseSnapshot', () => {
  it('parses a snapshot into models', () => {
    const text = validText((s) => {
      s.flags = {
        checkout: flag({
          requires: ['rollouts.v1'],
          prerequisites: [{ flagKey: 'base', variations: ['on'] }],
          overrides: [{ kind: 'user', key: 'u_vip', variation: 'on', expiresAt: '2026-10-06T09:00:00+01:00' }],
          rules: [
            ruleOn('r1', all({ attribute: 'country', op: 'in', values: ['PH', 'SG'], ignoreCase: true }, { any: [{ op: 'in_segment', values: ['beta'] }] })),
            { id: 'r2', enabled: false, match: { all: [] }, serve: { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 20000 }], remainderVariation: 'off', allocationId: 'alc_1', experimentId: 'exp_1' } } },
          ],
        }),
        base: flag(),
      };
      s.segments = { beta: { version: 3, match: { all: [] }, include: [{ kind: 'user', key: 'u_1' }] } };
      return s;
    });

    const snapshot = parseSnapshot(text);
    const checkout = snapshot.flags.get('checkout');

    expect(snapshot.revision).toBe(42);
    expect(snapshot.projection).toBe('server');
    expect(snapshot.environment.key).toBe('production');
    expect(checkout?.type).toBe('boolean');
    expect([...(checkout?.variations ?? [])]).toEqual([['on', true], ['off', false]]);
    expect(checkout?.requires).toEqual(['rollouts.v1']);
    expect(checkout?.prerequisites[0]?.flagKey).toBe('base');
    expect(checkout?.overrides[0]?.expiresAtMs).toBe(1791273600000);
    expect(checkout?.rules[0]?.match.kind).toBe('all');
    const first = checkout?.rules[0]?.match.members[0];
    expect(first !== undefined && !isGroup(first) ? first.op : null).toBe('in');
    expect(checkout?.rules[0]?.serve.kind).toBe('fixed');
    expect(checkout?.rules[1]?.enabled).toBe(false);
    expect(checkout?.rules[1]?.serve.kind).toBe('rollout');
    expect(snapshot.segments.get('beta')?.include[0]?.key).toBe('u_1');
    expect(snapshot.segments.get('ghost')).toBeUndefined();
  });

  it('accepts an empty snapshot and an integer written with a fraction part', () => {
    expect(parseSnapshot(validText((s) => ({ ...s, flags: {} }))).flags.size).toBe(0);
    expect(parseSnapshot(snapshotText({ ...baseSnapshot(), revision: 42.0 })).revision).toBe(42);
  });

  it('keeps flag keys such as constructor ordinary', () => {
    const snapshot = parseSnapshot(validText((s) => ({ ...s, flags: { constructor: flag(), 'to-string': flag() } })));
    expect([...snapshot.flags.keys()]).toEqual(['constructor', 'to-string']);
    expect(snapshot.flags.get('hasOwnProperty')).toBeUndefined();
  });

  type Case = [string, (s: Obj) => Obj | undefined, string, string, MalformedSnapshot['errorKind']?];
  const cases: Case[] = [
    ['protocol version 2', (s) => ({ ...s, protocolVersion: 2 }), '/protocolVersion', Problem.UNSUPPORTED_VERSION],
    ['protocol version as text', (s) => ({ ...s, protocolVersion: '1' }), '/protocolVersion', Problem.INVALID_TYPE],
    ['unknown algorithm', (s) => ({ ...s, algorithmVersion: 'bucket-sha256-v2' }), '/algorithmVersion', Problem.UNSUPPORTED_ALGORITHM, 'UNSUPPORTED_CAPABILITY'],
    ['missing member', (s) => { delete s.generation; return s; }, '', Problem.MISSING_FIELD],
    ['unknown member', (s) => ({ ...s, extra: 1 }), '/extra', Problem.UNKNOWN_FIELD],
    ['generation 0', (s) => ({ ...s, generation: 0 }), '/generation', Problem.INVALID_VALUE],
    ['revision as fraction', (s) => ({ ...s, revision: 1.5 }), '/revision', Problem.INVALID_TYPE],
    ['revision beyond the safe range', (s) => ({ ...s, revision: Number('9007199254740993') }), '/revision', Problem.UNSAFE_NUMBER],
    ['unknown projection', (s) => ({ ...s, projection: 'both' }), '/projection', Problem.INVALID_VALUE],
    ['published at without time', (s) => ({ ...s, publishedAt: '2026-10-06' }), '/publishedAt', Problem.INVALID_VALUE],
    ['published at on a day that does not exist', (s) => ({ ...s, publishedAt: '2026-02-30T00:00:00Z' }), '/publishedAt', Problem.INVALID_VALUE],
    ['published at with an offset', (s) => ({ ...s, publishedAt: '2026-10-06T08:00:00+01:00' }), '/publishedAt', Problem.INVALID_VALUE],
    ['environment id', (s) => ({ ...s, environment: { id: 'x', key: 'production' } }), '/environment/id', Problem.INVALID_VALUE],
    ['repeated required capability', (s) => ({ ...s, requiredCapabilities: ['segments.v1', 'segments.v1'] }), '/requiredCapabilities/1', Problem.INVALID_VALUE],
    ['capability name', (s) => ({ ...s, requiredCapabilities: ['Segments'] }), '/requiredCapabilities/0', Problem.INVALID_VALUE],
    ['flag key', (s) => ({ ...s, flags: { Bad_Key: flag() } }), '/flags/Bad_Key', Problem.INVALID_VALUE],
    ['flag type', withFlag({ type: 'float' }), '/flags/checkout/type', Problem.INVALID_VALUE],
    ['flag enabled as text', withFlag({ enabled: 'yes' }), '/flags/checkout/enabled', Problem.INVALID_TYPE],
    ['flag member missing', (s) => { s.flags = { checkout: (() => { const f = flag(); delete f.offVariation; return f; })() }; return s; }, '/flags/checkout', Problem.MISSING_FIELD],
    ['flag member unknown', withFlag({ color: 'red' }), '/flags/checkout/color', Problem.UNKNOWN_FIELD],
    ['variation of the wrong type', withFlag({ variations: { on: 'yes', off: false } }), '/flags/checkout/variations/on', Problem.INVALID_TYPE],
    ['variation key', withFlag({ variations: { on: true, '-x': true } }), '/flags/checkout/variations/-x', Problem.INVALID_VALUE],
    ['no variations', withFlag({ variations: {} }), '/flags/checkout/variations', Problem.INVALID_VALUE],
    ['json variation over 32 KB', withFlag({ type: 'json', variations: { big: { t: 'x'.repeat(33000) }, off: null } }), '/flags/checkout/variations/big', Problem.LIMIT_EXCEEDED],
    ['number variation beyond the safe range', withFlag({ type: 'number', variations: { big: 1e300, off: 0 } }), '/flags/checkout/variations/big', Problem.UNSAFE_NUMBER],
    ['too many prerequisites', withFlag({ prerequisites: Array.from({ length: 21 }, () => ({ flagKey: 'a', variations: ['on'] })) }), '/flags/checkout/prerequisites', Problem.LIMIT_EXCEEDED],
    ['prerequisite without variations', withFlag({ prerequisites: [{ flagKey: 'a', variations: [] }] }), '/flags/checkout/prerequisites/0/variations', Problem.INVALID_VALUE],
    ['too many overrides', withFlag({ overrides: Array.from({ length: 501 }, (_, i) => ({ kind: 'user', key: `u_${String(i)}`, variation: 'on', expiresAt: null })) }), '/flags/checkout/overrides', Problem.LIMIT_EXCEEDED],
    ['duplicate override', withFlag({ overrides: [{ kind: 'user', key: 'u_1', variation: 'on', expiresAt: null }, { kind: 'user', key: 'u_1', variation: 'off', expiresAt: null }] }), '/flags/checkout/overrides/1', Problem.DUPLICATE_OVERRIDE],
    ['override key over 256 bytes', withFlag({ overrides: [{ kind: 'user', key: 'é'.repeat(129), variation: 'on', expiresAt: null }] }), '/flags/checkout/overrides/0/key', Problem.INVALID_VALUE],
    ['override expiry', withFlag({ overrides: [{ kind: 'user', key: 'u', variation: 'on', expiresAt: 'tomorrow' }] }), '/flags/checkout/overrides/0/expiresAt', Problem.INVALID_VALUE],
    ['too many rules', withFlag({ rules: Array.from({ length: 201 }, (_, i) => ruleOn(`r${String(i)}`, { all: [] })) }), '/flags/checkout/rules', Problem.LIMIT_EXCEEDED],
    ['rule id over 64 characters', rules(ruleOn('r'.repeat(65), { all: [] })), '/flags/checkout/rules/0/id', Problem.INVALID_VALUE],
    ['group with both all and any', rules(ruleOn('r1', { all: [], any: [] })), '/flags/checkout/rules/0/match', Problem.INVALID_VALUE],
    ['group with neither', rules(ruleOn('r1', {})), '/flags/checkout/rules/0/match', Problem.MISSING_FIELD],
    ['group nested six deep', rules(ruleOn('r1', [1, 2, 3, 4, 5].reduce<Obj>((group) => ({ all: [group] }), { all: [] }))), '/flags/checkout/rules/0/match/all/0/all/0/all/0/all/0/all/0', Problem.LIMIT_EXCEEDED],
    ['group with 51 members', rules(ruleOn('r1', { all: Array.from({ length: 51 }, () => ({ attribute: 'a', op: 'exists' })) })), '/flags/checkout/rules/0/match/all', Problem.LIMIT_EXCEEDED],
    ['unknown operator', rules(ruleOn('r1', all({ attribute: 'a', op: 'like', values: ['x'] }))), '/flags/checkout/rules/0/match/all/0/op', Problem.INVALID_VALUE],
    ['condition without attribute', rules(ruleOn('r1', all({ op: 'eq', values: ['x'] }))), '/flags/checkout/rules/0/match/all/0', Problem.MISSING_FIELD],
    ['condition without values', rules(ruleOn('r1', all({ attribute: 'a', op: 'eq' }))), '/flags/checkout/rules/0/match/all/0', Problem.MISSING_FIELD],
    ['exists with values', rules(ruleOn('r1', all({ attribute: 'a', op: 'exists', values: [1] }))), '/flags/checkout/rules/0/match/all/0/values', Problem.INVALID_VALUE],
    ['segment condition with an attribute', rules(ruleOn('r1', all({ attribute: 'a', op: 'in_segment', values: ['x'] }))), '/flags/checkout/rules/0/match/all/0/attribute', Problem.INVALID_VALUE],
    ['eq with two values', rules(ruleOn('r1', all({ attribute: 'a', op: 'eq', values: ['x', 'y'] }))), '/flags/checkout/rules/0/match/all/0/values', Problem.INVALID_VALUE],
    ['too many values', rules(ruleOn('r1', all({ attribute: 'a', op: 'in', values: Array.from({ length: 1001 }, (_, i) => String(i)) }))), '/flags/checkout/rules/0/match/all/0/values', Problem.LIMIT_EXCEEDED],
    ['mixed in values', rules(ruleOn('r1', all({ attribute: 'a', op: 'in', values: ['x', 1] }))), '/flags/checkout/rules/0/match/all/0/values/1', Problem.INVALID_TYPE],
    ['numeric operator with text', rules(ruleOn('r1', all({ attribute: 'a', op: 'gt', values: ['5'] }))), '/flags/checkout/rules/0/match/all/0/values/0', Problem.INVALID_TYPE],
    ['invalid SemVer literal', rules(ruleOn('r1', all({ attribute: 'v', op: 'semver_gte', values: ['4.2'] }))), '/flags/checkout/rules/0/match/all/0/values/0', Problem.INVALID_VALUE],
    ['invalid date literal', rules(ruleOn('r1', all({ attribute: 'v', op: 'before', values: ['2026-10-06'] }))), '/flags/checkout/rules/0/match/all/0/values/0', Problem.INVALID_VALUE],
    ['serve with both', rules(ruleOn('r1', { all: [] }, { variation: 'on', rollout: {} })), '/flags/checkout/rules/0/serve', Problem.INVALID_VALUE],
    ['rollout weights over 100000', rules(ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 60000 }, { variation: 'off', weight: 50000 }] } })), '/flags/checkout/rules/0/serve/rollout/slots', Problem.WEIGHT_TOTAL_EXCEEDED],
    ['rollout weight 100001', rules(ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 100001 }] } })), '/flags/checkout/rules/0/serve/rollout/slots/0/weight', Problem.INVALID_VALUE],
    ['rollout weight as fraction', rules(ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 50000.5 }], remainderVariation: 'off' } })), '/flags/checkout/rules/0/serve/rollout/slots/0/weight', Problem.INVALID_TYPE],
    ['rollout without remainder', rules(ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 20000 }] } })), '/flags/checkout/rules/0/serve/rollout', Problem.MISSING_REMAINDER],
    ['rollout salt over 128 bytes', rules(ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 'é'.repeat(65), slots: [{ variation: 'on', weight: 100000 }] } })), '/flags/checkout/rules/0/serve/rollout/salt', Problem.INVALID_VALUE],
    ['allocation without experiment', rules(ruleOn('r1', { all: [] }, { rollout: { bucketBy: 'key', salt: 's', slots: [{ variation: 'on', weight: 100000 }], allocationId: 'a' } })), '/flags/checkout/rules/0/serve/rollout', Problem.MISSING_FIELD],
    ['segment version 0', (s) => ({ ...s, segments: { s: { version: 0, match: { all: [] } } } }), '/segments/s/version', Problem.INVALID_VALUE],
    ['segment key', (s) => ({ ...s, segments: { Bad: { version: 1, match: { all: [] } } } }), '/segments/Bad', Problem.INVALID_VALUE],
    ['public projection with overrides', (s) => ({ ...s, projection: 'public', flags: { checkout: flag({ overrides: [{ kind: 'user', key: 'u', variation: 'on', expiresAt: null }] }) } }), '/flags/checkout/overrides', Problem.PROJECTION_VIOLATION],
    ['public projection with an include list', (s) => ({ ...s, projection: 'public', segments: { s: { version: 1, match: { all: [] }, include: [] } } }), '/segments/s/include', Problem.PROJECTION_VIOLATION],
    ['revision 0 with flags', (s) => ({ ...s, revision: 0 }), '/flags', Problem.EMPTY_SNAPSHOT_REQUIRED],
  ];

  it.each(cases)('rejects: %s', (_name, mutate, path, problem, kind = 'MALFORMED_SNAPSHOT') => {
    const error = rejection(mutate);
    expect({ kind: error.errorKind, path: error.path, problem: error.problem }).toEqual({ kind, path, problem });
  });

  it('rejects a checksum that does not match, after the structure was accepted', () => {
    const error = rejection((s) => ({ ...s, checksum: `sha256:${'f'.repeat(64)}` }), false);
    expect([error.problem, error.path]).toEqual([Problem.CHECKSUM_MISMATCH, '/checksum']);
  });

  it('rejects a checksum of the wrong shape and can skip the check', () => {
    expect(rejection((s) => ({ ...s, checksum: 'sha256:ABC' }), false).problem).toBe(Problem.INVALID_VALUE);
    expect(parseSnapshot(snapshotText(baseSnapshot(), false), { verifyChecksum: false }).revision).toBe(42);
  });

  it.each(['[]', '"text"', '5', 'null', '{'])('rejects %s at the top level', (text) => {
    expect(() => parseSnapshot(text)).toThrow(MalformedSnapshot);
  });

  it('reports JSON Pointer escapes in paths', () => {
    const error = rejection(withFlag({ variations: { 'a/b': true, 'c~d': true, '': true } }));
    expect(error.path).toBe('/flags/checkout/variations/a~1b');
  });

  it('accepts the limits exactly', () => {
    const text = validText((s) => {
      s.flags = {
        checkout: flag({ rules: Array.from({ length: 200 }, (_, i) => ruleOn(`r${String(i)}`, all({ attribute: 'a', op: 'in', values: Array.from({ length: 1000 }, (_x, j) => String(j)) }))) }),
        other: flag({ rules: [ruleOn('r1', [1, 2, 3, 4].reduce<Obj>((group) => ({ all: [group] }), { all: [] }))] }),
        nested: flag({ type: 'json', variations: { v: Array.from({ length: 60 }).reduce<unknown>((value) => [value], 0) as never, off: null } }),
      };
      return s;
    });
    expect(parseSnapshot(text).flags.get('checkout')?.rules).toHaveLength(200);
  });
});
