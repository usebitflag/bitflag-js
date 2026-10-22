import { commands } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { FixtureRunner } from '../support/conformance.js';

// The same checks as tests/conformance, run in a browser against the same pinned release.
describe('conformance in the browser', async () => {
  const runner = new FixtureRunner(new Map(Object.entries(await commands.loadRelease())));

  it('uses an intact release', () => {
    expect(runner.verifyManifest()).toEqual([]);
  });

  it('passes every evaluation fixture', () => {
    const ids = runner.evaluationCaseIds();
    expect(ids.length).toBeGreaterThan(900);
    const failures = ids.flatMap((id) => {
      const outcome = runner.runEvaluationCase(id.fixture, id.case);
      return outcome.failures.length === 0 ? [] : [`${outcome.fixture} / ${outcome.name}: ${outcome.failures.join('; ')}`];
    });
    expect(failures).toEqual([]);
  });

  it('handles every snapshot fixture', () => {
    const ids = runner.snapshotFixtureIds();
    expect(ids.length).toBeGreaterThan(50);
    expect(ids.flatMap((id) => runner.runSnapshotFixture(id).failures.map((failure) => `${id}: ${failure}`))).toEqual([]);
  });

  it('computes every bucket and canonical vector', () => {
    const outcomes = [...runner.runBucketVectors(), ...runner.runCanonicalVectors()];
    expect(outcomes.length).toBeGreaterThan(200);
    expect(outcomes.flatMap((o) => o.failures.map((failure) => `${o.fixture} / ${o.name}: ${failure}`))).toEqual([]);
  });

  it('is the browser, not Node', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('object');
    expect(typeof (globalThis as { process?: unknown }).process).not.toBe('object');
  });
});
