import { MAX_PREREQUISITE_DEPTH } from '../evaluation/flag-evaluator.js';
import { isGroup, type ConditionGroup, type Flag, type Snapshot } from './model.js';

export const ValidationCode = {
  DANGLING_VARIATION: 'DANGLING_VARIATION',
  DANGLING_SEGMENT: 'DANGLING_SEGMENT',
  DANGLING_PREREQUISITE: 'DANGLING_PREREQUISITE',
  PREREQUISITE_CYCLE: 'PREREQUISITE_CYCLE',
  PREREQUISITE_DEPTH: 'PREREQUISITE_DEPTH',
  SEGMENT_CYCLE: 'SEGMENT_CYCLE',
  CAPABILITY_UNION_MISMATCH: 'CAPABILITY_UNION_MISMATCH',
  DUPLICATE_SALT: 'DUPLICATE_SALT',
} as const;

export type ValidationCodeName = (typeof ValidationCode)[keyof typeof ValidationCode];

/**
 * A problem in a snapshot that does not stop it from loading. Publication treats any issue as blocking;
 * evaluation reports INVALID_CONFIG only for the issues it reaches.
 */
export interface ValidationIssue {
  readonly code: ValidationCodeName;
  /** JSON Pointer to the offending value. */
  readonly path: string;
  readonly message: string;
}

const escapeKey = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Finds the problems a parsed snapshot can have across its own parts: references that do not resolve, prerequisite
 * and segment cycles, a prerequisite chain that is too deep, a capability list that is not the union of the flags'
 * needs, and salts shared by unrelated rollouts.
 */
export function validateSnapshot(snapshot: Snapshot): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: ValidationCodeName, path: string, message: string): void => {
    issues.push({ code, path, message });
  };

  const checkVariation = (flag: Flag, variation: string, path: string): void => {
    if (!flag.variations.has(variation)) {
      add(ValidationCode.DANGLING_VARIATION, path, `The flag "${flag.key}" has no variation "${variation}".`);
    }
  };

  const checkGroup = (group: ConditionGroup, path: string): void => {
    group.members.forEach((member, index) => {
      const memberPath = `${path}/${group.kind}/${String(index)}`;
      if (isGroup(member)) {
        checkGroup(member, memberPath);
      } else if (member.op === 'in_segment' || member.op === 'not_in_segment') {
        member.values.forEach((segment, i) => {
          if (!snapshot.segments.has(String(segment))) {
            add(ValidationCode.DANGLING_SEGMENT, `${memberPath}/values/${String(i)}`, `The segment "${String(segment)}" is not in the snapshot.`);
          }
        });
      }
    });
  };

  for (const [key, flag] of snapshot.flags) {
    const base = `/flags/${escapeKey(key)}`;
    checkVariation(flag, flag.offVariation, `${base}/offVariation`);
    checkVariation(flag, flag.defaultVariation, `${base}/defaultVariation`);

    flag.prerequisites.forEach((prerequisite, index) => {
      const path = `${base}/prerequisites/${String(index)}`;
      const target = snapshot.flags.get(prerequisite.flagKey);
      if (target === undefined) {
        add(ValidationCode.DANGLING_PREREQUISITE, `${path}/flagKey`, `The prerequisite flag "${prerequisite.flagKey}" is not in the snapshot.`);
        return;
      }
      prerequisite.variations.forEach((variation, i) => {
        checkVariation(target, variation, `${path}/variations/${String(i)}`);
      });
    });
    flag.overrides.forEach((override, index) => {
      checkVariation(flag, override.variation, `${base}/overrides/${String(index)}/variation`);
    });
    flag.rules.forEach((rule, index) => {
      const path = `${base}/rules/${String(index)}`;
      checkGroup(rule.match, `${path}/match`);
      if (rule.serve.kind === 'fixed') {
        checkVariation(flag, rule.serve.variation, `${path}/serve/variation`);
      } else {
        rule.serve.slots.forEach((slot, i) => {
          checkVariation(flag, slot.variation, `${path}/serve/rollout/slots/${String(i)}/variation`);
        });
        if (rule.serve.remainderVariation !== null) {
          checkVariation(flag, rule.serve.remainderVariation, `${path}/serve/rollout/remainderVariation`);
        }
      }
    });
  }
  for (const [key, segment] of snapshot.segments) {
    checkGroup(segment.match, `/segments/${escapeKey(key)}/match`);
  }

  prerequisiteGraph(snapshot, add);
  segmentGraph(snapshot, add);
  capabilities(snapshot, add);
  salts(snapshot, add);
  return issues;
}

type Add = (code: ValidationCodeName, path: string, message: string) => void;

function prerequisiteGraph(snapshot: Snapshot, add: Add): void {
  const depth = new Map<string, number>(); // longest chain of links below a flag; -1 while it is being computed
  const reported = new Set<string>();

  const visit = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) {
      return known;
    }
    const flag = snapshot.flags.get(key);
    if (flag === undefined) {
      return 0;
    }
    depth.set(key, -1);
    let longest = 0;
    flag.prerequisites.forEach((prerequisite, index) => {
      if (!snapshot.flags.has(prerequisite.flagKey)) {
        return;
      }
      if (depth.get(prerequisite.flagKey) === -1) {
        const path = `/flags/${escapeKey(key)}/prerequisites/${String(index)}`;
        if (!reported.has(path)) {
          reported.add(path);
          add(ValidationCode.PREREQUISITE_CYCLE, path, `The prerequisite "${prerequisite.flagKey}" leads back to "${key}".`);
        }
        return;
      }
      longest = Math.max(longest, 1 + visit(prerequisite.flagKey));
    });
    depth.set(key, longest);
    return longest;
  };

  for (const key of snapshot.flags.keys()) {
    visit(key);
  }
  for (const [key, links] of depth) {
    if (links > MAX_PREREQUISITE_DEPTH) {
      add(ValidationCode.PREREQUISITE_DEPTH, `/flags/${escapeKey(key)}`, `A chain of ${String(links)} prerequisite links starts here; at most ${String(MAX_PREREQUISITE_DEPTH)} are allowed.`);
    }
  }
}

function segmentReferences(group: ConditionGroup): string[] {
  return group.members.flatMap((member) => {
    if (isGroup(member)) {
      return segmentReferences(member);
    }
    return member.op === 'in_segment' || member.op === 'not_in_segment' ? member.values.map(String) : [];
  });
}

function segmentGraph(snapshot: Snapshot, add: Add): void {
  const state = new Map<string, 1 | 2>();
  const visit = (key: string): void => {
    state.set(key, 1);
    const segment = snapshot.segments.get(key);
    for (const referenced of segment === undefined ? [] : segmentReferences(segment.match)) {
      if (!snapshot.segments.has(referenced)) {
        continue;
      }
      const seen = state.get(referenced);
      if (seen === 1) {
        add(ValidationCode.SEGMENT_CYCLE, `/segments/${escapeKey(key)}/match`, `The segment "${key}" leads back to "${referenced}".`);
      } else if (seen === undefined) {
        visit(referenced);
      }
    }
    state.set(key, 2);
  };
  for (const key of snapshot.segments.keys()) {
    if (!state.has(key)) {
      visit(key);
    }
  }
}

function capabilities(snapshot: Snapshot, add: Add): void {
  const union = new Set<string>();
  for (const flag of snapshot.flags.values()) {
    flag.requires.forEach((capability) => union.add(capability));
  }
  const expected = [...union].sort();
  const stated = [...snapshot.requiredCapabilities].sort();
  if (expected.length !== stated.length || expected.some((capability, index) => capability !== stated[index])) {
    add(ValidationCode.CAPABILITY_UNION_MISMATCH, '/requiredCapabilities', `requiredCapabilities must be the union of the flags' requires: [${expected.join(', ')}].`);
  }
}

/** Two rollouts that share a salt must be explicitly linked, which is to say share an allocationId. */
function salts(snapshot: Snapshot, add: Add): void {
  const seen = new Map<string, { path: string; allocation: string | null }>();
  for (const [key, flag] of snapshot.flags) {
    flag.rules.forEach((rule, index) => {
      if (rule.serve.kind !== 'rollout') {
        return;
      }
      const path = `/flags/${escapeKey(key)}/rules/${String(index)}/serve/rollout/salt`;
      const { salt, allocationId } = rule.serve;
      const first = seen.get(salt);
      if (first !== undefined && (allocationId === null || first.allocation !== allocationId)) {
        add(ValidationCode.DUPLICATE_SALT, path, `The salt is also used at ${first.path}.`);
        return;
      }
      if (first === undefined) {
        seen.set(salt, { path, allocation: allocationId });
      }
    });
  }
}
