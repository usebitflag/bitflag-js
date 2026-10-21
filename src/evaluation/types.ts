/** Why an evaluation returned its value. */
export type Reason = 'OFF' | 'PREREQUISITE' | 'OVERRIDE' | 'RULE' | 'DEFAULT' | 'FALLBACK' | 'ERROR';

/** Machine-readable cause of a FALLBACK or ERROR result, and of a rejected snapshot. */
export type ErrorKind =
  | 'FLAG_NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'MISSING_SUBJECT_KEY'
  | 'INVALID_CONFIG'
  | 'INVALID_CONTEXT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MALFORMED_SNAPSHOT'
  | 'SNAPSHOT_TOO_OLD'
  | 'CLIENT_NOT_READY'
  | 'AUTHORIZATION_REJECTED';

export type FlagType = 'boolean' | 'string' | 'number' | 'json';
