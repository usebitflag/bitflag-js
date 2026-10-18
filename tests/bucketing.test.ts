import { describe, expect, it } from 'vitest';
import { BUCKET_ALGORITHM, BUCKET_COUNT, PROTOCOL_MAJOR } from '../src/index.js';

describe('protocol constants', () => {
  it('identifies the bucketing algorithm and bucket range', () => {
    expect(BUCKET_ALGORITHM).toBe('bucket-sha256-v1');
    expect(BUCKET_COUNT).toBe(100_000);
  });

  it('implements protocol major version 1', () => {
    expect(PROTOCOL_MAJOR).toBe(1);
  });
});
