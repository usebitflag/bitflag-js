export { BUCKET_ALGORITHM, BUCKET_COUNT } from './evaluation/bucketing.js';
export type { ErrorKind, FlagType, Reason } from './evaluation/types.js';
export { canonicalize } from './protocol/canonical.js';
export { computeChecksum, verifyChecksum } from './protocol/checksum.js';
export { MalformedSnapshot, Problem, type ProblemCode } from './protocol/errors.js';
export { decodeJson, type Json } from './protocol/json.js';
export type * from './protocol/model.js';
export { parseSnapshot, snapshotFromJson } from './protocol/parser.js';
export { PROTOCOL_MAJOR } from './protocol/version.js';
