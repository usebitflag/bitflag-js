import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucket, bucketInput, selectSlot } from '../../src/evaluation/bucketing.js';
import { sha256, toHex } from '../../src/evaluation/sha256.js';

const vectors: [string, string, string, string, number][] = [
  ["s_9f2c", "user", "u_20931", "9f9eda90f9168dca", 76138],
  ["s_9f2c", "user", "Jos\u00e9", "1ebaefa16e2bd815", 60341],
  ["s_9f2c", "user", "Jose\u0301", "7a436b95850c54c4", 99140],
  ["s_edge", "user", "edge_39583", "feb3d030fe02b0e0", 0],
  ["s_edge", "user", "edge_20598", "b5924978038ba9e1", 1],
  ["s_edge", "user", "edge_25328", "4edd27ed6b6388df", 51615],
  ["s_edge", "user", "edge_417199", "29e465c24e13bae0", 51616],
  ["s_edge", "user", "edge_37973", "bbcee41b34a68f5e", 99998],
  ["s_edge", "user", "edge_28533", "e8872bc027301eff", 99999],
  ["s_slot", "user", "slot_49913", "f6dfdbfadbabb9bf", 19999],
  ["s_slot", "user", "slot_54281", "7c126833e7433ca0", 20000],
  ["s_slot", "user", "slot_483823", "e1823fb0f5874d8f", 49999],
  ["s_slot", "user", "slot_50277", "310465671e352df0", 50000],
  ["s_len", "user", 'k'.repeat(1024), "ed5d3c07d222e00d", 50413],
  ["s_text", "user", "\ud83d\ude00", "26ecd6bd9eadc732", 28242],
];

describe('bucket-sha256-v1', () => {
  it.each(vectors)('hashes %s / %s / %j to the known digest and bucket', (salt, kind, value, digestPrefix, expected) => {
    expect(toHex(sha256(bucketInput(salt, kind, value))).slice(0, 16)).toBe(digestPrefix);
    expect(bucket(salt, kind, value)).toBe(expected);
  });

  it('hashes length-prefixed fields so that no split is ambiguous', () => {
    const hex = (salt: string, kind: string, value: string): string => toHex(bucketInput(salt, kind, value));
    expect(new Set([hex('ab', 'c', 'd'), hex('a', 'bc', 'd'), hex('a', 'b', 'cd')]).size).toBe(3);
    expect(hex('s_9f2c', 'user', 'u_20931')).toBe('00000011626974666c61672d6275636b65742d763100000006735f39663263000000047573657200000007755f3230393331');
  });

  it('treats NFC and NFD spellings as different subjects', () => {
    expect(bucket('s_9f2c', 'user', 'José')).not.toBe(bucket('s_9f2c', 'user', 'José'));
  });

  it('depends on the salt, the kind and the value only', () => {
    const base = bucket('salt', 'user', 'u_1');
    expect(bucket('salt', 'user', 'u_1')).toBe(base);
    expect(bucket('salt2', 'user', 'u_1')).not.toBe(base);
    expect(bucket('salt', 'organization', 'u_1')).not.toBe(base);
    expect(bucket('salt', 'user', 'u_2')).not.toBe(base);
  });

  it('uses the whole 64-bit value, including digests whose top bit is set', () => {
    // The first eight digest bytes are above 2^63 for some inputs; a signed or 53-bit reading would get them wrong.
    let seen = 0;
    for (let i = 0; i < 200 && seen < 5; i += 1) {
      const digest = sha256(bucketInput('s_top', 'user', `u_${String(i)}`));
      if ((digest[0] ?? 0) >= 0x80) {
        seen += 1;
        const word = new DataView(digest.buffer).getBigUint64(0);
        expect(bucket('s_top', 'user', `u_${String(i)}`)).toBe(Number(word % 100000n));
      }
    }
    expect(seen).toBe(5);
  });

  it('always lands in range and spreads subjects evenly', () => {
    const counts = Array<number>(20).fill(0);
    for (let i = 0; i < 20_000; i += 1) {
      const value = bucket('s_uniform', 'user', `user_${String(i)}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(BUCKET_COUNT);
      counts[Math.floor(value / 5000)] = (counts[Math.floor(value / 5000)] ?? 0) + 1;
    }
    // Chi-square over 20 equal intervals; 19 degrees of freedom, p = 0.001 is 43.8.
    const chi = counts.reduce((sum, count) => sum + (count - 1000) ** 2 / 1000, 0);
    expect(chi).toBeLessThan(43.8);
  });
});

describe('slots', () => {
  const slots = [{ variation: 'a', weight: 20000 }, { variation: 'zero', weight: 0 }, { variation: 'b', weight: 30000 }];

  it.each([
    [0, 'a', 0, 20000], [19999, 'a', 0, 20000], [20000, 'b', 20000, 50000], [49999, 'b', 20000, 50000], [50000, null, 50000, 100000], [99999, null, 50000, 100000],
  ])('puts bucket %s in %s', (number, variation, start, end) => {
    expect(selectSlot(slots, number)).toEqual({ variation, start, end });
  });

  it('keeps every subject in a slot that only grows', () => {
    const narrow = [{ variation: 'on', weight: 20000 }];
    const wide = [{ variation: 'on', weight: 50000 }];
    let moved = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const number = bucket('s_monotonic', 'user', `u_${String(i)}`);
      const before = selectSlot(narrow, number).variation;
      const after = selectSlot(wide, number).variation;
      if (before === 'on') {
        expect(after).toBe('on');
      }
      if (before === null && after === 'on') {
        moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(2500);
    expect(moved).toBeLessThan(3500);
  });

  it('moves only subjects between the old and new boundary when a weight changes', () => {
    const before = [{ variation: 'a', weight: 30000 }, { variation: 'b', weight: 30000 }];
    const after = [{ variation: 'a', weight: 40000 }, { variation: 'b', weight: 20000 }];
    for (let i = 0; i < 10_000; i += 1) {
      const number = bucket('s_boundary', 'user', `u_${String(i)}`);
      if (selectSlot(before, number).variation !== selectSlot(after, number).variation) {
        expect(number).toBeGreaterThanOrEqual(30000);
        expect(number).toBeLessThan(40000);
      }
    }
  });
});
