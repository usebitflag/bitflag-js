import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Bundle } from './conformance.js';

export interface Lock {
  readonly repository: string;
  readonly version: string;
  readonly asset: string;
  readonly sha256: string | null;
}

const root = join(import.meta.dirname, '../..');

export function readLock(): Lock {
  const lock = JSON.parse(readFileSync(join(root, 'protocol.lock.json'), 'utf8')) as Partial<Record<keyof Lock, unknown>>;
  if (typeof lock.repository !== 'string' || typeof lock.version !== 'string' || typeof lock.asset !== 'string') {
    throw new Error('protocol.lock.json is malformed.');
  }
  return { repository: lock.repository, version: lock.version, asset: lock.asset, sha256: typeof lock.sha256 === 'string' ? lock.sha256 : null };
}

/** The directory of the extracted release: BITFLAG_PROTOCOL_DIR, or build/protocol/<version> from the lock file. */
export function releaseDirectory(): string {
  const override = process.env.BITFLAG_PROTOCOL_DIR;
  return override !== undefined && override !== '' ? override : join(root, 'build', 'protocol', readLock().version);
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Every file of the release below `directory`, by path relative to it. */
export function loadRelease(directory = releaseDirectory()): Bundle {
  try {
    statSync(join(directory, 'fixtures', 'manifest.json'));
  } catch {
    throw new Error(`The protocol fixtures are missing at ${directory}. Run scripts/fetch-protocol-fixtures.sh, or set BITFLAG_PROTOCOL_DIR to an extracted release.`);
  }
  return new Map(walk(directory).map((path) => [relative(directory, path).split(sep).join('/'), readFileSync(path, 'utf8')]));
}
