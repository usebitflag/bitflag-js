import type { Flag, Snapshot } from '../protocol/model.js';
import { bucket as bucketFor, selectSlot } from './bucketing.js';
import { Abort, ConditionMatcher } from './conditions.js';
import type { NormalizedContext } from './context.js';
import { SegmentMatcher } from './segments.js';
import type { ConditionTrace, TraceStep } from './trace.js';
import type { Reason } from './types.js';

/** What the evaluation of one flag decided, before it becomes a result. */
export interface Decision {
  readonly variation: string;
  readonly reason: Reason;
  readonly ruleId: string | null;
  readonly prerequisiteKey: string | null;
  readonly bucket: number | null;
  readonly experimentId: string | null;
  readonly allocationId: string | null;
}

/** The deepest chain of prerequisites: the evaluated flag plus this many levels below it. */
export const MAX_PREREQUISITE_DEPTH = 10;

const decision = (variation: string, reason: Reason, extra: Partial<Decision> = {}): Decision => ({
  variation,
  reason,
  ruleId: null,
  prerequisiteKey: null,
  bucket: null,
  experimentId: null,
  allocationId: null,
  ...extra,
});

/**
 * Decides which variation one flag serves for one context at one instant: capabilities, enabled, prerequisites,
 * overrides, rules, default. Aborts with an error kind when the configuration or the input is unusable.
 *
 * One instance serves one top-level evaluation and remembers what each prerequisite flag served. When asked to
 * trace, it records the steps of the evaluated flag, not those of its prerequisites.
 */
export class FlagEvaluator {
  private readonly served = new Map<string, string>();
  private readonly recorded: TraceStep[] = [];
  private readonly matcher: ConditionMatcher;

  constructor(
    private readonly snapshot: Snapshot,
    private readonly context: NormalizedContext,
    private readonly atMs: number,
    private readonly supportedCapabilities: readonly string[],
    private readonly trace = false,
  ) {
    const segments = new SegmentMatcher(snapshot.segments, context);
    this.matcher = new ConditionMatcher(context, (key) => segments.isMember(key));
  }

  /** The steps recorded so far for the evaluated flag; useful after an abort. */
  steps(): readonly TraceStep[] {
    return this.recorded;
  }

  /**
   * @param visiting keys of the flags on the path from the evaluated flag to this one
   * @throws Abort
   */
  decide(flag: Flag, visiting: readonly string[]): Decision {
    const record = this.trace && visiting.length === 1;

    if (flag.requires.length > 0) {
      const unsupported = flag.requires.some((capability) => !this.supportedCapabilities.includes(capability));
      if (record) {
        this.recorded.push({ step: 'capability', outcome: unsupported ? 'unsupported' : 'supported' });
      }
      if (unsupported) {
        throw new Abort('UNSUPPORTED_CAPABILITY');
      }
    }

    if (!flag.enabled) {
      if (record) {
        this.recorded.push({ step: 'off', outcome: 'served' });
      }
      return decision(this.variation(flag, flag.offVariation), 'OFF');
    }

    for (const prerequisite of flag.prerequisites) {
      if (visiting.includes(prerequisite.flagKey) || visiting.length > MAX_PREREQUISITE_DEPTH) {
        throw new Abort('INVALID_CONFIG');
      }
      const path = [...visiting, prerequisite.flagKey];
      const served = this.servedBy(prerequisite.flagKey, path);
      const met = prerequisite.variations.includes(served);
      if (record) {
        this.recorded.push({ step: 'prerequisite', outcome: met ? 'met' : 'unmet', prerequisitePath: path.slice(1) });
      }
      if (!met) {
        return decision(this.variation(flag, flag.offVariation), 'PREREQUISITE', { prerequisiteKey: prerequisite.flagKey });
      }
    }

    for (const override of flag.overrides) {
      if (this.context.key === null || override.kind !== this.context.kind || override.key !== this.context.key) {
        continue;
      }
      const active = override.expiresAtMs === null || this.atMs < override.expiresAtMs;
      if (record) {
        this.recorded.push({ step: 'override', outcome: active ? 'applied' : 'expired', ...(override.expiresAt === null ? {} : { overrideExpiresAt: override.expiresAt }) });
      }
      if (active) {
        return decision(this.variation(flag, override.variation), 'OVERRIDE');
      }
    }

    for (const rule of flag.rules) {
      if (!rule.enabled) {
        if (record) {
          this.recorded.push({ step: 'rule', outcome: 'disabled', ruleId: rule.id });
        }
        continue;
      }

      const conditions: ConditionTrace[] | null = record ? [] : null;
      if (!this.matcher.matches(rule.match, conditions)) {
        if (record) {
          this.recorded.push({ step: 'rule', outcome: 'not_matched', ruleId: rule.id, ...(conditions === null ? {} : { conditions }) });
        }
        continue;
      }

      if (rule.serve.kind === 'fixed') {
        if (record) {
          this.recorded.push({ step: 'rule', outcome: 'matched', ruleId: rule.id, ...(conditions === null ? {} : { conditions }) });
        }
        return decision(this.variation(flag, rule.serve.variation), 'RULE', { ruleId: rule.id });
      }

      const { serve } = rule;
      const subject = serve.bucketBy === 'key' ? this.context.key : this.context.attributes.get(serve.bucketBy);
      if (typeof subject !== 'string' || subject === '') {
        if (record) {
          this.recorded.push({ step: 'rule', outcome: 'matched', ruleId: rule.id, ...(conditions === null ? {} : { conditions }) });
        }
        throw new Abort('MISSING_SUBJECT_KEY');
      }
      const bucket = bucketFor(serve.salt, this.context.kind, subject);
      const slot = selectSlot(serve.slots, bucket);
      const variation = slot.variation ?? serve.remainderVariation;
      if (variation === null) {
        if (record) {
          this.recorded.push({ step: 'rule', outcome: 'matched', ruleId: rule.id, ...(conditions === null ? {} : { conditions }), bucket });
        }
        throw new Abort('INVALID_CONFIG');
      }
      if (record) {
        this.recorded.push({
          step: 'rule',
          outcome: 'matched',
          ruleId: rule.id,
          ...(conditions === null ? {} : { conditions }),
          bucket,
          slot: { variation, start: slot.start, end: slot.end },
        });
      }
      return decision(this.variation(flag, variation), 'RULE', { ruleId: rule.id, bucket, experimentId: serve.experimentId, allocationId: serve.allocationId });
    }

    if (record) {
      this.recorded.push({ step: 'default', outcome: 'served' });
    }
    return decision(this.variation(flag, flag.defaultVariation), 'DEFAULT');
  }

  /** What a prerequisite flag serves, computed once per top-level call. */
  private servedBy(flagKey: string, visiting: readonly string[]): string {
    const known = this.served.get(flagKey);
    if (known !== undefined) {
      return known;
    }
    const flag = this.snapshot.flags.get(flagKey);
    if (flag === undefined) {
      throw new Abort('INVALID_CONFIG');
    }
    const { variation } = this.decide(flag, visiting);
    this.served.set(flagKey, variation);
    return variation;
  }

  private variation(flag: Flag, key: string): string {
    if (!flag.variations.has(key)) {
      throw new Abort('INVALID_CONFIG');
    }
    return key;
  }
}
