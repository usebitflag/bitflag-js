import { sha256 } from './sha256.js';
import { utf8Bytes } from './values/utf8.js';

/** Identifier of the bucketing algorithm. */
export const BUCKET_ALGORITHM = 'bucket-sha256-v1';

/** Buckets are numbered 0 through BUCKET_COUNT - 1. */
export const BUCKET_COUNT = 100_000;

const DOMAIN_TAG = 'bitflag-bucket-v1';

/** A field of the hashed input: the byte length as four big-endian bytes, then the UTF-8 bytes. */
function field(text: string): Uint8Array {
  const bytes = utf8Bytes(text);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/** The bytes that are hashed for a bucket: the four fields, each prefixed with its byte length. */
export function bucketInput(salt: string, kind: string, value: string): Uint8Array {
  const fields = [field(DOMAIN_TAG), field(salt), field(kind), field(value)];
  const out = new Uint8Array(fields.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of fields) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The stable rollout algorithm bucket-sha256-v1: SHA-256 over the length-prefixed fields, the first eight digest
 * bytes as an unsigned big-endian 64-bit integer, modulo 100,000. A `Number` cannot hold that integer, so the
 * arithmetic is done with `BigInt`.
 */
export function bucket(salt: string, kind: string, value: string): number {
  const digest = sha256(bucketInput(salt, kind, value));
  const word = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0);
  return Number(word % BigInt(BUCKET_COUNT));
}

export interface SlotInterval {
  /** The variation of the slot, or null when the bucket is beyond the total weight (the remainder). */
  readonly variation: string | null;
  readonly start: number;
  readonly end: number;
}

/**
 * Finds the slot whose half-open interval contains the bucket. Slot i covers [sum of earlier weights, sum including
 * its own weight); a bucket at or beyond the total weight gets the remainder, reported as the interval up to 100,000.
 */
export function selectSlot(slots: readonly { readonly variation: string; readonly weight: number }[], bucketNumber: number): SlotInterval {
  let start = 0;
  for (const slot of slots) {
    const end = start + slot.weight;
    if (bucketNumber >= start && bucketNumber < end) {
      return { variation: slot.variation, start, end };
    }
    start = end;
  }
  return { variation: null, start, end: BUCKET_COUNT };
}
