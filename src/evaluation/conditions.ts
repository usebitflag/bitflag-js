import { isGroup, type Condition, type ConditionGroup, type ConditionValue } from '../protocol/model.js';
import type { NormalizedContext } from './context.js';
import type { ConditionOutcome, ConditionTrace } from './trace.js';
import { parseInstant } from './values/instant.js';
import { compareSemVer, parseSemVer } from './values/semver.js';

/** Stops an evaluation with an ERROR result. Internal control flow: the evaluator catches it. */
export class Abort extends Error {
  constructor(readonly errorKind: 'INVALID_CONFIG' | 'MISSING_SUBJECT_KEY' | 'UNSUPPORTED_CAPABILITY') {
    super(errorKind);
    this.name = 'Abort';
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type Family = 'string' | 'number' | 'boolean' | 'unsafe' | 'other';

function familyOf(value: unknown): Family {
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return 'other';
    }
    return Math.floor(value) === value && Math.abs(value) > MAX_SAFE ? 'unsafe' : 'number';
  }
  return 'other';
}

/** Folds the ASCII letters A to Z to a to z; no other character changes. */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function expectedFamily(condition: Condition): Family {
  const { op, values } = condition;
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    return 'number';
  }
  if (op === 'starts_with' || op === 'ends_with' || op === 'contains' || op.startsWith('semver_') || op === 'before' || op === 'after') {
    return 'string';
  }
  return familyOf(values[0]);
}

function textMatches(op: Condition['op'], item: string, values: readonly ConditionValue[], ignoreCase: boolean): boolean {
  const subject = ignoreCase ? foldAscii(item) : item;
  return values.some((value) => {
    const needle = ignoreCase ? foldAscii(String(value)) : String(value);
    if (op === 'starts_with') {
      return subject.startsWith(needle);
    }
    return op === 'ends_with' ? subject.endsWith(needle) : subject.includes(needle);
  });
}

function numberMatches(op: Condition['op'], item: number, value: number): boolean {
  switch (op) {
    case 'gt':
      return item > value;
    case 'gte':
      return item >= value;
    case 'lt':
      return item < value;
    default:
      return item <= value;
  }
}

function orderMatches(op: Condition['op'], order: number): boolean {
  switch (op) {
    case 'semver_eq':
    case 'semver_neq':
      return order === 0;
    case 'semver_gt':
    case 'after':
      return order > 0;
    case 'semver_gte':
      return order >= 0;
    case 'semver_lt':
    case 'before':
      return order < 0;
    default:
      return order <= 0;
  }
}

const NEGATED: readonly Condition['op'][] = ['neq', 'not_in', 'semver_neq'];

/** Compares the items of an attribute (one, or the elements of an array value) with a condition. */
function compare(condition: Condition, items: readonly unknown[]): ConditionOutcome {
  const { op, values } = condition;
  const expected = expectedFamily(condition);
  if (items.some((item) => familyOf(item) !== expected)) {
    return 'wrong_type';
  }

  let any: boolean;
  if (op.startsWith('semver_') || op === 'before' || op === 'after') {
    const target = op === 'before' || op === 'after' ? parseInstant(String(values[0])) : parseSemVer(String(values[0]));
    if (target === null) {
      throw new Abort('INVALID_CONFIG');
    }
    const orders: number[] = [];
    for (const item of items as string[]) {
      if (op === 'before' || op === 'after') {
        const instant = parseInstant(item);
        if (instant === null) {
          return 'invalid_value';
        }
        orders.push(instant === target ? 0 : instant < (target as number) ? -1 : 1);
      } else {
        const version = parseSemVer(item);
        if (version === null) {
          return 'invalid_value';
        }
        orders.push(compareSemVer(version, target as Exclude<typeof target, number>));
      }
    }
    any = orders.some((order) => orderMatches(op, order));
  } else if (op === 'eq' || op === 'neq') {
    any = items.some((item) => item === values[0]);
  } else if (op === 'in' || op === 'not_in') {
    any = items.some((item) => values.includes(item as ConditionValue));
  } else if (op === 'starts_with' || op === 'ends_with' || op === 'contains') {
    any = (items as string[]).some((item) => textMatches(op, item, values, condition.ignoreCase));
  } else {
    any = (items as number[]).some((item) => numberMatches(op, item, values[0] as number));
  }

  return (NEGATED.includes(op) ? !any : any) ? 'match' : 'no_match';
}

/**
 * Evaluates condition groups against one context. Groups short-circuit; the conditions they skip are recorded as
 * not evaluated.
 */
export class ConditionMatcher {
  /**
   * @param inSegment membership of the context in a segment; aborts for a missing segment
   */
  constructor(
    private readonly context: NormalizedContext,
    private readonly inSegment: (segmentKey: string) => boolean,
  ) {}

  /** @param trace collects one entry per condition when given */
  matches(group: ConditionGroup, trace: ConditionTrace[] | null = null, path = ''): boolean {
    const all = group.kind === 'all';
    let result = all;
    let decided = false;

    group.members.forEach((member, index) => {
      const memberPath = `${path}/${group.kind}/${String(index)}`;
      if (decided) {
        this.skip(member, memberPath, trace);
        return;
      }
      const matched = isGroup(member) ? this.matches(member, trace, memberPath) : this.recordCondition(member, memberPath, trace);
      if (all && !matched) {
        result = false;
        decided = true;
      } else if (!all && matched) {
        result = true;
        decided = true;
      }
    });
    return result;
  }

  private skip(member: Condition | ConditionGroup, path: string, trace: ConditionTrace[] | null): void {
    if (trace === null) {
      return;
    }
    if (isGroup(member)) {
      member.members.forEach((inner, index) => {
        this.skip(inner, `${path}/${member.kind}/${String(index)}`, trace);
      });
      return;
    }
    trace.push(entry(member, path, 'not_evaluated'));
  }

  private recordCondition(condition: Condition, path: string, trace: ConditionTrace[] | null): boolean {
    const outcome = this.outcome(condition);
    trace?.push(entry(condition, path, outcome));
    return outcome === 'match';
  }

  outcome(condition: Condition): ConditionOutcome {
    const { op } = condition;

    if (op === 'in_segment' || op === 'not_in_segment') {
      const member = condition.values.some((key) => this.inSegment(String(key)));
      return (op === 'in_segment' ? member : !member) ? 'match' : 'no_match';
    }

    const name = condition.attribute ?? '';
    const present = this.has(name);
    if (op === 'exists' || op === 'not_exists') {
      return (op === 'exists' ? present : !present) ? 'match' : 'no_match';
    }
    if (!present) {
      return 'missing';
    }
    const value = this.read(name);
    if (value === null) {
      return 'null';
    }
    return compare(condition, Array.isArray(value) ? (value as unknown[]) : [value]);
  }

  private has(name: string): boolean {
    if (name === 'kind') {
      return true;
    }
    return name === 'key' ? this.context.key !== null : this.context.attributes.has(name);
  }

  private read(name: string): unknown {
    if (name === 'kind') {
      return this.context.kind;
    }
    return name === 'key' ? this.context.key : (this.context.attributes.get(name) ?? null);
  }
}

function entry(condition: Condition, path: string, outcome: ConditionOutcome): ConditionTrace {
  const segment = (condition.op === 'in_segment' || condition.op === 'not_in_segment') && condition.values.length === 1 ? String(condition.values[0]) : undefined;
  return {
    path,
    op: condition.op,
    ...(condition.attribute === null ? {} : { attribute: condition.attribute }),
    ...(segment === undefined ? {} : { segment }),
    outcome,
  };
}
