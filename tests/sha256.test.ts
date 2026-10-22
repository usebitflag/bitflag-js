import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256, toHex } from '../src/evaluation/sha256.js';

const reference = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('sha256', () => {
  it('matches the FIPS 180-4 examples', () => {
    const text = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(toHex(sha256(text('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256(text('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes one million a characters', () => {
    expect(toHex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with the platform for every length around the block boundaries', () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) % 256);
      expect(toHex(sha256(bytes))).toBe(reference(bytes));
    }
  });

  it('agrees with the platform for random inputs', () => {
    let seed = 20261006;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 300; i += 1) {
      const bytes = Uint8Array.from({ length: next() % 3000 }, () => next() & 0xff);
      expect(toHex(sha256(bytes))).toBe(reference(bytes));
    }
  });

  it('does not change its input', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    sha256(bytes);
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});
