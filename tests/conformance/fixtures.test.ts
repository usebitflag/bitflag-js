import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FixtureRunner, type Bundle } from '../support/conformance.js';
import { loadRelease, readLock } from '../support/node-release.js';

/*
 * Runs every fixture of the pinned protocol release. The release comes from build/protocol/<version>, filled by
 * scripts/fetch-protocol-fixtures.sh, or from the directory in BITFLAG_PROTOCOL_DIR. When it is missing the suite
 * fails; it never skips.
 */
let release: Bundle | null = null;
let missing = '';
try {
  release = loadRelease();
} catch (error) {
  missing = error instanceof Error ? error.message : String(error);
}

describe('conformance', () => {
  if (release === null) {
    it('has the protocol release', () => {
      expect.fail(missing);
    });
    return;
  }

  const runner = new FixtureRunner(release);

  it('uses an intact release', () => {
    expect(runner.verifyManifest()).toEqual([]);
  });

  describe('evaluation fixtures', () => {
    it.each(runner.evaluationCaseIds().map((id) => [`${id.fixture} / ${id.case}`, id.fixture, id.case] as const))('%s', (_label, fixture, name) => {
      const outcome = runner.runEvaluationCase(fixture, name);
      expect(outcome.failures, outcome.fixture + ' / ' + outcome.name).toEqual([]);
    });
  });

  describe('snapshot fixtures', () => {
    it.each(runner.snapshotFixtureIds())('%s', (id) => {
      expect(runner.runSnapshotFixture(id).failures).toEqual([]);
    });
  });

  it('computes every bucket vector', () => {
    const outcomes = runner.runBucketVectors();
    expect(outcomes.length).toBeGreaterThanOrEqual(200);
    expect(outcomes.flatMap((o) => o.failures.map((f) => `${o.name}: ${f}`))).toEqual([]);
  });

  it('canonicalizes every canonical vector', () => {
    const outcomes = runner.runCanonicalVectors();
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.flatMap((o) => o.failures.map((f) => `${o.name}: ${f}`))).toEqual([]);
  });

  it('covers every reason and error kind in at least one fixture', () => {
    const report = runner.report('bitflag-js', 'test');
    const reasons = new Set<unknown>();
    const errors = new Set<unknown>();
    for (const entry of report.results) {
      const result = entry.result;
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        reasons.add(result.reason);
        if (result.errorKind !== null) {
          errors.add(result.errorKind);
        }
      }
    }
    for (const entry of report.snapshots) {
      if (entry.errorKind !== null && entry.errorKind !== undefined) {
        errors.add(entry.errorKind);
      }
    }
    // SNAPSHOT_TOO_OLD, CLIENT_NOT_READY and AUTHORIZATION_REJECTED are produced by SDK clients, not by the evaluator.
    expect([...reasons]).toEqual(expect.arrayContaining(['OFF', 'PREREQUISITE', 'OVERRIDE', 'RULE', 'DEFAULT', 'FALLBACK', 'ERROR']));
    expect([...errors]).toEqual(
      expect.arrayContaining(['FLAG_NOT_FOUND', 'TYPE_MISMATCH', 'MISSING_SUBJECT_KEY', 'INVALID_CONFIG', 'INVALID_CONTEXT', 'UNSUPPORTED_CAPABILITY', 'MALFORMED_SNAPSHOT']),
    );
  });

  it.runIf(process.env.CONFORMANCE_REPORT !== undefined)('writes the conformance report', () => {
    const { failures, ...report } = runner.report('bitflag-js', readLock().version);
    writeFileSync(process.env.CONFORMANCE_REPORT ?? '', `${JSON.stringify(report, null, 2)}\n`);
    expect(failures).toEqual([]);
  });
});
