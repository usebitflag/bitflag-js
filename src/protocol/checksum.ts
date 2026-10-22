import { sha256, toHex } from '../evaluation/sha256.js';
import { utf8Bytes } from '../evaluation/values/utf8.js';
import { canonicalize } from './canonical.js';
import { MalformedSnapshot, Problem } from './errors.js';
import type { Json } from './json.js';

/** "sha256:" and the SHA-256 of the canonical form of every member except the top-level "checksum". */
export function computeChecksum(snapshot: { [key: string]: Json }): string {
  const members: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== 'checksum') {
      members[key] = value;
    }
  }
  return `sha256:${toHex(sha256(utf8Bytes(canonicalize(members))))}`;
}

/** @throws MalformedSnapshot with CHECKSUM_MISMATCH */
export function verifyChecksum(snapshot: { [key: string]: Json }): void {
  if (snapshot.checksum !== computeChecksum(snapshot)) {
    throw MalformedSnapshot.malformed('/checksum', Problem.CHECKSUM_MISMATCH);
  }
}
