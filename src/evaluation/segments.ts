import type { Segment, SubjectRef } from '../protocol/model.js';
import { Abort, ConditionMatcher } from './conditions.js';
import type { NormalizedContext } from './context.js';

/**
 * Segment membership: excluded subjects are out, then included subjects are in, then the segment's conditions
 * decide. A context without a key never matches either list.
 */
export class SegmentMatcher {
  private readonly active: string[] = [];

  constructor(
    private readonly segments: ReadonlyMap<string, Segment>,
    private readonly context: NormalizedContext,
  ) {}

  /** @throws Abort when the segment is missing or leads back to itself */
  isMember(key: string): boolean {
    const segment = this.segments.get(key);
    if (segment === undefined || this.active.includes(key)) {
      throw new Abort('INVALID_CONFIG');
    }
    if (this.listed(segment.exclude)) {
      return false;
    }
    if (this.listed(segment.include)) {
      return true;
    }

    this.active.push(key);
    try {
      return new ConditionMatcher(this.context, (other) => this.isMember(other)).matches(segment.match);
    } finally {
      this.active.pop();
    }
  }

  private listed(subjects: readonly SubjectRef[]): boolean {
    const { key, kind } = this.context;
    return key !== null && subjects.some((subject) => subject.kind === kind && subject.key === key);
  }
}
