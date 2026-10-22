import type { Segment, SubjectRef } from '../protocol/model.js';
import { Abort, ConditionMatcher } from './conditions.js';
import type { NormalizedContext } from './context.js';

/**
 * Segment membership: excluded subjects are out, then included subjects are in, then the segment's conditions
 * decide. A context without a key never matches either list.
 */
export class SegmentMatcher {
  private readonly active: string[] = [];
  /** Membership already decided in this evaluation, so a segment shared by many others is evaluated once. */
  private readonly decided = new Map<string, boolean>();

  constructor(
    private readonly segments: ReadonlyMap<string, Segment>,
    private readonly context: NormalizedContext,
  ) {}

  /** @throws Abort when the segment is missing or leads back to itself */
  isMember(key: string): boolean {
    const known = this.decided.get(key);
    if (known !== undefined) {
      return known;
    }
    const segment = this.segments.get(key);
    if (segment === undefined || this.active.includes(key)) {
      throw new Abort('INVALID_CONFIG');
    }
    if (this.listed(segment.exclude)) {
      return this.remember(key, false);
    }
    if (this.listed(segment.include)) {
      return this.remember(key, true);
    }

    this.active.push(key);
    try {
      return this.remember(key, new ConditionMatcher(this.context, (other) => this.isMember(other)).matches(segment.match));
    } finally {
      this.active.pop();
    }
  }

  private remember(key: string, member: boolean): boolean {
    this.decided.set(key, member);
    return member;
  }

  private listed(subjects: readonly SubjectRef[]): boolean {
    const { key, kind } = this.context;
    return key !== null && subjects.some((subject) => subject.kind === kind && subject.key === key);
  }
}
