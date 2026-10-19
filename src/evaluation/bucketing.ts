/**
 * Constants of the stable rollout algorithm. The evaluation logic itself is added on top of
 * the conformance fixtures published by bitflag-protocol.
 */

/** Identifier of the bucketing algorithm. */
export const BUCKET_ALGORITHM = 'bucket-sha256-v1';

/** Buckets are numbered 0 through BUCKET_COUNT - 1. */
export const BUCKET_COUNT = 100_000;
