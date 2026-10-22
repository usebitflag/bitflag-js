import { computeChecksum } from '../../src/protocol/checksum.js';
import type { Json } from '../../src/protocol/json.js';

export type Obj = { [key: string]: Json };

/** A valid snapshot document as a plain object. */
export function baseSnapshot(): Obj {
  return {
    protocolVersion: 1,
    algorithmVersion: 'bucket-sha256-v1',
    environment: { id: 'env_1', key: 'production' },
    revision: 42,
    generation: 1,
    projection: 'server',
    publishedAt: '2026-10-06T07:00:00Z',
    requiredCapabilities: [],
    flags: { checkout: flag() },
    segments: {},
    checksum: `sha256:${'0'.repeat(64)}`,
  };
}

export function flag(overrides: Obj = {}): Obj {
  return {
    type: 'boolean',
    enabled: true,
    variations: { on: true, off: false },
    offVariation: 'off',
    defaultVariation: 'off',
    prerequisites: [],
    overrides: [],
    rules: [],
    ...overrides,
  };
}

/** The JSON text of a snapshot, with a correct checksum unless asked not to. */
export function snapshotText(snapshot: Obj, withChecksum = true): string {
  if (!withChecksum) {
    return JSON.stringify(snapshot);
  }
  const copy = JSON.parse(JSON.stringify(snapshot)) as Obj;
  return JSON.stringify({ ...copy, checksum: computeChecksum(copy) });
}

/** A valid snapshot, optionally changed by `mutate` (which receives and returns the document). */
export function validText(mutate?: (snapshot: Obj) => Obj | undefined): string {
  const snapshot = baseSnapshot();
  const changed = mutate?.(snapshot) ?? snapshot;
  return snapshotText(changed);
}

export function ruleOn(id: string, match: Json, serve: Json = { variation: 'on' }): Obj {
  return { id, match, serve };
}
