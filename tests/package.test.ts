import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLock } from './support/node-release.js';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: object; peerDependencies?: object; bitflag?: { protocol?: string } };

describe('package', () => {
  it('has no runtime dependencies', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it('records the protocol release it is tested against, and the lock agrees', () => {
    expect(pkg.bitflag?.protocol).toBe(readLock().version);
  });

  it('pins the protocol release by checksum once it is published', () => {
    const lock = readLock();
    expect(lock.sha256 === null || /^[0-9a-f]{64}$/.test(lock.sha256)).toBe(true);
    expect(lock.asset).toBe(`bitflag-protocol-${lock.version}.tar.gz`);
  });
});
