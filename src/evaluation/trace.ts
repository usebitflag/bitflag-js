/** How one condition came out. */
export type ConditionOutcome = 'match' | 'no_match' | 'missing' | 'null' | 'wrong_type' | 'invalid_value' | 'not_evaluated';

/** One condition of a rule: where it sits, what it tested and the outcome. Never holds context values. */
export interface ConditionTrace {
  readonly path: string;
  readonly op: string;
  readonly attribute?: string;
  readonly segment?: string;
  readonly outcome: ConditionOutcome;
}

export type TraceStepName = 'capability' | 'off' | 'prerequisite' | 'override' | 'rule' | 'default';

/** One step of an evaluation. */
export interface TraceStep {
  readonly step: TraceStepName;
  readonly outcome: string;
  readonly ruleId?: string;
  readonly prerequisitePath?: readonly string[];
  readonly conditions?: readonly ConditionTrace[];
  readonly bucket?: number;
  readonly slot?: { readonly variation: string; readonly start: number; readonly end: number };
  readonly overrideExpiresAt?: string;
}

/** Why a result came out as it did. Names attributes and outcomes, never context values. */
export interface EvaluationTrace {
  readonly steps: readonly TraceStep[];
}
