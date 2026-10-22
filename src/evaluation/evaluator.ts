import type { Json } from '../protocol/json.js';
import { CAPABILITIES, type Snapshot } from '../protocol/model.js';
import { readContext, type NormalizedContext } from './context.js';
import { FlagEvaluator } from './flag-evaluator.js';
import type { EvaluationTrace } from './trace.js';
import type { ErrorKind, FlagType, Reason } from './types.js';
import { formatInstant } from './values/instant.js';
import { Abort } from './conditions.js';

/** The outcome of evaluating one flag for one context. */
export interface EvaluationResult {
  readonly flagKey: string;
  /** The served value, or the caller's fallback for FALLBACK and ERROR. */
  readonly value: Json;
  /** Null when the fallback was returned. */
  readonly variationKey: string | null;
  readonly reason: Reason;
  readonly ruleId: string | null;
  readonly prerequisiteKey: string | null;
  readonly revision: number;
  readonly generation: number;
  /** Set only when a rollout decided and details were requested. */
  readonly bucket: number | null;
  readonly experimentId: string | null;
  readonly allocationId: string | null;
  readonly errorKind: ErrorKind | null;
  /** The evaluation instant, RFC 3339 UTC. */
  readonly evaluatedAt: string;
  readonly trace?: EvaluationTrace;
}

/**
 * Every flag of a snapshot evaluated for one context, each as its declared type. A result has the fields of an
 * EvaluationResult, except that value and variationKey are null whenever the reason is ERROR, because there is no
 * caller fallback to return. FALLBACK cannot occur. For bootstrapping and debugging only: never feed these values
 * into typed reads.
 */
export interface AllFlagsResult {
  readonly results: ReadonlyMap<string, EvaluationResult>;
  readonly revision: number;
  readonly generation: number;
}

export interface EvaluationOptions {
  /** Evaluate at this instant instead of the clock's now (fixtures, the simulator). */
  readonly at?: Date;
  /** Report the bucket of a rollout decision. */
  readonly details?: boolean;
  /** Attach the trace. For trusted callers only; never on a public path. */
  readonly trace?: boolean;
}

export interface Clock {
  now(): Date;
}

export interface EvaluatorOptions {
  readonly clock?: Clock;
  /** Defaults to every capability of protocol version 1. */
  readonly supportedCapabilities?: readonly string[];
}

/** The caller passed a fallback whose type differs from the requested type. A programming error, never a result. */
export class FallbackTypeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'FallbackTypeError';
  }
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.values(value).every(isJson);
  }
  return false;
}

function hasType(value: unknown, type: FlagType): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return isJson(value);
  }
}

/**
 * Evaluates the flags of one snapshot. Pure: no I/O, no randomness; the only clock is the one given to the
 * constructor, and a time in the options overrides it.
 *
 * It throws only FallbackTypeError, for a fallback that does not have the requested type. Every other problem is
 * a result with a reason and an error kind.
 */
export class Evaluator {
  private readonly clock: Clock;
  private readonly supported: readonly string[];

  constructor(
    private readonly snapshot: Snapshot,
    options: EvaluatorOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.supported = options.supportedCapabilities ?? CAPABILITIES;
  }

  /** The capabilities of protocol version 1. */
  static supportedCapabilities(): readonly string[] {
    return CAPABILITIES;
  }

  /** @throws FallbackTypeError when `fallback` does not have the requested type */
  evaluate(flagKey: string, context: unknown, type: FlagType, fallback: unknown, options: EvaluationOptions = {}): EvaluationResult {
    if (!hasType(fallback, type)) {
      throw new FallbackTypeError(`The fallback for "${flagKey}" must be of type ${type}.`);
    }
    const atMs = this.time(options);
    const value = fallback as Json;

    const read = readContext(context);
    if ('issues' in read) {
      return this.failure(flagKey, value, 'ERROR', 'INVALID_CONTEXT', atMs);
    }
    const flag = this.snapshot.flags.get(flagKey);
    if (flag === undefined) {
      return this.failure(flagKey, value, 'FALLBACK', 'FLAG_NOT_FOUND', atMs);
    }
    if (flag.type !== type) {
      return this.failure(flagKey, value, 'FALLBACK', 'TYPE_MISMATCH', atMs);
    }
    return this.evaluateFlag(flagKey, read.context, value, options, atMs);
  }

  evaluateBoolean(flagKey: string, context: unknown, fallback: boolean, options?: EvaluationOptions): EvaluationResult {
    return this.evaluate(flagKey, context, 'boolean', fallback, options);
  }

  evaluateString(flagKey: string, context: unknown, fallback: string, options?: EvaluationOptions): EvaluationResult {
    return this.evaluate(flagKey, context, 'string', fallback, options);
  }

  evaluateNumber(flagKey: string, context: unknown, fallback: number, options?: EvaluationOptions): EvaluationResult {
    return this.evaluate(flagKey, context, 'number', fallback, options);
  }

  evaluateJson(flagKey: string, context: unknown, fallback: Json, options?: EvaluationOptions): EvaluationResult {
    return this.evaluate(flagKey, context, 'json', fallback, options);
  }

  /**
   * Evaluates every flag of the snapshot as its declared type. There is no caller fallback, so a flag that cannot
   * be served has a null value and a null variation key.
   */
  evaluateAll(context: unknown, options: EvaluationOptions = {}): AllFlagsResult {
    const atMs = this.time(options);
    const read = readContext(context);
    const results = new Map<string, EvaluationResult>();
    for (const key of this.snapshot.flags.keys()) {
      results.set(key, 'issues' in read ? this.failure(key, null, 'ERROR', 'INVALID_CONTEXT', atMs) : this.evaluateFlag(key, read.context, null, options, atMs));
    }
    return { results, revision: this.snapshot.revision, generation: this.snapshot.generation };
  }

  private time(options: EvaluationOptions): number {
    const at = (options.at ?? this.clock.now()).getTime();
    if (Number.isNaN(at)) {
      throw new TypeError('The evaluation time is not a valid date.');
    }
    return at;
  }

  private evaluateFlag(flagKey: string, context: NormalizedContext, fallback: Json, options: EvaluationOptions, atMs: number): EvaluationResult {
    const flag = this.snapshot.flags.get(flagKey);
    if (flag === undefined) {
      return this.failure(flagKey, fallback, 'FALLBACK', 'FLAG_NOT_FOUND', atMs);
    }
    const evaluator = new FlagEvaluator(this.snapshot, context, atMs, this.supported, options.trace === true);
    const trace = (): { trace?: EvaluationTrace } => (options.trace === true ? { trace: { steps: evaluator.steps() } } : {});

    try {
      const decided = evaluator.decide(flag, [flagKey]);
      return {
        flagKey,
        value: flag.variations.get(decided.variation) ?? null,
        variationKey: decided.variation,
        reason: decided.reason,
        ruleId: decided.ruleId,
        prerequisiteKey: decided.prerequisiteKey,
        revision: this.snapshot.revision,
        generation: this.snapshot.generation,
        bucket: options.details === true ? decided.bucket : null,
        experimentId: decided.experimentId,
        allocationId: decided.allocationId,
        errorKind: null,
        evaluatedAt: formatInstant(atMs),
        ...trace(),
      };
    } catch (error) {
      if (error instanceof Abort) {
        return { ...this.failure(flagKey, fallback, 'ERROR', error.errorKind, atMs), ...trace() };
      }
      throw error;
    }
  }

  private failure(flagKey: string, value: Json, reason: Reason, errorKind: ErrorKind, atMs: number): EvaluationResult {
    return {
      flagKey,
      value,
      variationKey: null,
      reason,
      ruleId: null,
      prerequisiteKey: null,
      revision: this.snapshot.revision,
      generation: this.snapshot.generation,
      bucket: null,
      experimentId: null,
      allocationId: null,
      errorKind,
      evaluatedAt: formatInstant(atMs),
    };
  }
}
