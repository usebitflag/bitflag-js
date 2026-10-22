export { BUCKET_ALGORITHM, BUCKET_COUNT, bucket } from './evaluation/bucketing.js';
export type { AttributeValue, Context } from './evaluation/context.js';
export { validateContext } from './evaluation/context.js';
export {
  Evaluator,
  FallbackTypeError,
  type AllFlagsResult,
  type Clock,
  type EvaluationOptions,
  type EvaluationResult,
  type EvaluatorOptions,
} from './evaluation/evaluator.js';
export type { ConditionOutcome, ConditionTrace, EvaluationTrace, TraceStep, TraceStepName } from './evaluation/trace.js';
export type { ErrorKind, FlagType, Reason } from './evaluation/types.js';
export { canonicalize } from './protocol/canonical.js';
export { computeChecksum, verifyChecksum } from './protocol/checksum.js';
export { MalformedSnapshot, Problem, type ProblemCode } from './protocol/errors.js';
export { decodeJson, type Json } from './protocol/json.js';
export type * from './protocol/model.js';
export { parseSnapshot, snapshotFromJson } from './protocol/parser.js';
export { validateSnapshot, ValidationCode, type ValidationIssue } from './protocol/validator.js';
export { PROTOCOL_MAJOR } from './protocol/version.js';
