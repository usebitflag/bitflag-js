import type { ErrorKind } from '../evaluation/types.js';

/** Codes that say why a snapshot was rejected. */
export const Problem = {
  INVALID_JSON: 'INVALID_JSON',
  TOO_DEEP: 'TOO_DEEP',
  TOO_LARGE: 'TOO_LARGE',
  INVALID_TYPE: 'INVALID_TYPE',
  MISSING_FIELD: 'MISSING_FIELD',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  INVALID_VALUE: 'INVALID_VALUE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  UNSAFE_NUMBER: 'UNSAFE_NUMBER',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNSUPPORTED_ALGORITHM: 'UNSUPPORTED_ALGORITHM',
  WEIGHT_TOTAL_EXCEEDED: 'WEIGHT_TOTAL_EXCEEDED',
  MISSING_REMAINDER: 'MISSING_REMAINDER',
  DUPLICATE_OVERRIDE: 'DUPLICATE_OVERRIDE',
  PROJECTION_VIOLATION: 'PROJECTION_VIOLATION',
  EMPTY_SNAPSHOT_REQUIRED: 'EMPTY_SNAPSHOT_REQUIRED',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
} as const;

export type ProblemCode = (typeof Problem)[keyof typeof Problem];

/** A snapshot was rejected: the error kind, a JSON Pointer to the offending value and a problem code. */
export class MalformedSnapshot extends Error {
  constructor(
    readonly errorKind: Extract<ErrorKind, 'MALFORMED_SNAPSHOT' | 'UNSUPPORTED_CAPABILITY'>,
    readonly path: string,
    readonly problem: ProblemCode,
    detail = '',
  ) {
    super(`${errorKind} at "${path}" (${problem})${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'MalformedSnapshot';
  }

  static malformed(path: string, problem: ProblemCode, detail = ''): MalformedSnapshot {
    return new MalformedSnapshot('MALFORMED_SNAPSHOT', path, problem, detail);
  }
}
