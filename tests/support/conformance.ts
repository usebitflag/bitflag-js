import { BUCKET_COUNT, bucket, bucketInput } from '../../src/evaluation/bucketing.js';
import { sha256, toHex } from '../../src/evaluation/sha256.js';
import { utf8Bytes } from '../../src/evaluation/values/utf8.js';
import { Evaluator, FallbackTypeError } from '../../src/evaluation/evaluator.js';
import { canonicalize } from '../../src/protocol/canonical.js';
import { decodeJson, isObject, type Json } from '../../src/protocol/json.js';
import { MalformedSnapshot } from '../../src/protocol/errors.js';
import { parseSnapshot } from '../../src/protocol/parser.js';
import type { Snapshot } from '../../src/protocol/model.js';
import type { FlagType } from '../../src/evaluation/types.js';

/** An extracted protocol release: file path relative to the release root to the text of the file. */
export type Bundle = ReadonlyMap<string, string>;

type Obj = { [key: string]: Json };

export interface Outcome {
  readonly fixture: string;
  readonly name: string;
  readonly failures: readonly string[];
  /** The report entry for the case. */
  readonly actual?: Obj;
}

export interface Report {
  protocol: string;
  evaluator: { name: string; version: string };
  results: Obj[];
  snapshots: Obj[];
  failures: string[];
}

const BIG = { maxBytes: 1_000_000_000, maxDepth: 10_000 };

const same = (a: unknown, b: unknown): boolean => canonicalize((a ?? null) as Json) === canonicalize((b ?? null) as Json);
const obj = (value: unknown): Obj | null => (isObject(value) ? value : null);
const objects = (values: readonly unknown[]): Obj[] => values.filter(isObject);
const text = (object: Obj, field: string): string => {
  const value = object[field];
  if (typeof value !== 'string') {
    throw new Error(`Expected a string "${field}" in a fixture.`);
  }
  return value;
};

/**
 * Runs a release of the protocol's conformance fixtures against this evaluator. The release is an in-memory map of
 * its files, so that the same runner works in Node and in a browser.
 */
export class FixtureRunner {
  private readonly parsed = new Map<string, Json>();
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly files: Bundle) {}

  private json(path: string): Json {
    const known = this.parsed.get(path);
    if (known !== undefined) {
      return known;
    }
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`The release has no file ${path}.`);
    }
    const value = decodeJson(content, BIG);
    this.parsed.set(path, value);
    return value;
  }

  private paths(prefix: string): string[] {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix) && path.endsWith('.json')).sort();
  }

  /** Checks that the fixture files are the ones the manifest lists. */
  verifyManifest(): string[] {
    const manifest = obj(this.json('fixtures/manifest.json'));
    const list = manifest?.files;
    if (manifest === null || !Array.isArray(list)) {
      return ['fixtures/manifest.json has no file list.'];
    }
    const problems: string[] = [];
    const listed: string[] = [];
    let lines = '';
    for (const entry of list) {
      const item = obj(entry);
      if (item === null || typeof item.path !== 'string' || typeof item.sha256 !== 'string') {
        return ['fixtures/manifest.json has a malformed entry.'];
      }
      listed.push(item.path);
      const content = this.files.get(`fixtures/${item.path}`);
      if (content === undefined) {
        problems.push(`Missing fixture file: ${item.path}`);
        continue;
      }
      if (toHex(sha256(utf8Bytes(content))) !== item.sha256) {
        problems.push(`Fixture file changed: ${item.path}`);
      }
      lines += `${item.path}:${item.sha256}\n`;
    }
    if (toHex(sha256(utf8Bytes(lines))) !== manifest.checksum) {
      problems.push('The manifest checksum does not match its file list.');
    }
    for (const path of this.files.keys()) {
      if (path.startsWith('fixtures/') && path !== 'fixtures/manifest.json' && !listed.includes(path.slice('fixtures/'.length))) {
        problems.push(`Fixture file not in the manifest: ${path.slice('fixtures/'.length)}`);
      }
    }
    return problems;
  }

  private evaluationFixtures(): Obj[] {
    return objects(this.paths('fixtures/evaluation/').map((path) => this.json(path)));
  }

  private snapshotFixtures(): Obj[] {
    return objects(this.paths('fixtures/snapshot/').map((path) => this.json(path)));
  }

  private cases(fixture: Obj): Obj[] {
    return Array.isArray(fixture.cases) ? objects(fixture.cases) : [];
  }

  evaluationCaseIds(): { fixture: string; case: string }[] {
    return this.evaluationFixtures().flatMap((fixture) => this.cases(fixture).map((c) => ({ fixture: text(fixture, 'id'), case: text(c, 'name') })));
  }

  snapshotFixtureIds(): string[] {
    return this.snapshotFixtures().map((fixture) => text(fixture, 'id'));
  }

  runEvaluationCase(fixtureId: string, caseName: string): Outcome {
    for (const fixture of this.evaluationFixtures()) {
      if (text(fixture, 'id') !== fixtureId) {
        continue;
      }
      for (const c of this.cases(fixture)) {
        if (text(c, 'name') === caseName) {
          return this.evaluate(fixture, c);
        }
      }
    }
    throw new Error(`No case "${caseName}" in fixture "${fixtureId}".`);
  }

  runSnapshotFixture(fixtureId: string): Outcome {
    for (const fixture of this.snapshotFixtures()) {
      if (text(fixture, 'id') === fixtureId) {
        return this.parseFixture(fixture);
      }
    }
    throw new Error(`No snapshot fixture "${fixtureId}".`);
  }

  private snapshotFor(fixture: Obj, c: Obj): Snapshot {
    const ref = c.snapshotRef ?? fixture.snapshotRef;
    if (typeof ref === 'string') {
      let known = this.snapshots.get(ref);
      if (known === undefined) {
        known = parseSnapshot(this.files.get(`fixtures/${ref}`) ?? '');
        this.snapshots.set(ref, known);
      }
      return known;
    }
    const key = `inline:${text(fixture, 'id')}`;
    let known = this.snapshots.get(key);
    if (known === undefined) {
      known = parseSnapshot(JSON.stringify(fixture.snapshot));
      this.snapshots.set(key, known);
    }
    return known;
  }

  private evaluate(fixture: Obj, c: Obj): Outcome {
    const fixtureId = text(fixture, 'id');
    const name = text(c, 'name');
    const expect = obj(c.expect);
    if (expect === null) {
      return { fixture: fixtureId, name, failures: ['the case has no expect'] };
    }

    const caseOptions = obj(c.options);
    const evaluator = new Evaluator(this.snapshotFor(fixture, c), { clock: { now: () => new Date(0) } });
    const failures: string[] = [];

    let result;
    try {
      result = evaluator.evaluate(text(c, 'flagKey'), c.context, text(c, 'type') as FlagType, c.fallback, {
        at: new Date(text(c, 'evaluatedAt')),
        details: caseOptions?.details === true,
        trace: caseOptions?.trace === true,
      });
    } catch (error) {
      if (error instanceof FallbackTypeError) {
        if (expect.throws !== 'FALLBACK_TYPE_ERROR') {
          failures.push('threw FALLBACK_TYPE_ERROR');
        }
        return { fixture: fixtureId, name, failures, actual: { threw: 'FALLBACK_TYPE_ERROR' } };
      }
      throw error;
    }

    const actual = { ...result } as unknown as Obj;
    const reported: Obj = {
      value: result.value,
      variationKey: result.variationKey,
      reason: result.reason,
      ruleId: result.ruleId,
      prerequisiteKey: result.prerequisiteKey,
      errorKind: result.errorKind,
      revision: result.revision,
      generation: result.generation,
      bucket: result.bucket,
      experimentId: result.experimentId,
      allocationId: result.allocationId,
    };
    if (expect.throws !== undefined) {
      return { fixture: fixtureId, name, failures: [`expected ${JSON.stringify(expect.throws)} to be thrown`], actual: { result: reported } };
    }
    for (const [field, expected] of Object.entries(expect)) {
      if (!same(actual[field], expected)) {
        failures.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual[field] ?? null)}`);
      }
    }
    if (Array.isArray(c.expectTrace)) {
      const problem = traceProblem(c.expectTrace, result.trace);
      if (problem !== null) {
        failures.push(`trace: ${problem}`);
      }
    }
    if (Array.isArray(c.expectTraceSteps)) {
      const trace = result.trace as unknown;
      const steps = isObject(trace) && Array.isArray(trace.steps) ? (trace.steps as unknown[]) : [];
      const names = steps.map((step) => (isObject(step) ? step.step : null));
      if (!same(names, c.expectTraceSteps)) {
        failures.push(`trace steps: expected ${JSON.stringify(c.expectTraceSteps)}, got ${JSON.stringify(names)}`);
      }
    }
    return { fixture: fixtureId, name, failures, actual: { result: reported } };
  }

  private parseFixture(fixture: Obj): Outcome {
    const id = text(fixture, 'id');
    const expect = obj(fixture.expect);
    if (expect === null) {
      return { fixture: id, name: 'snapshot', failures: ['the fixture has no expect'] };
    }
    const raw = typeof fixture.snapshotRaw === 'string' ? fixture.snapshotRaw : JSON.stringify(fixture.snapshot);

    let actual: Obj;
    try {
      parseSnapshot(raw);
      actual = { accepted: true, errorKind: null, path: null, code: null };
    } catch (error) {
      if (!(error instanceof MalformedSnapshot)) {
        throw error;
      }
      actual = { accepted: false, errorKind: error.errorKind, path: error.path, code: error.problem };
    }

    const failures: string[] = [];
    if (actual.accepted !== expect.accept) {
      failures.push(actual.accepted === true ? 'the snapshot was accepted' : `the snapshot was rejected: ${JSON.stringify(actual)}`);
    } else if (actual.accepted === false) {
      for (const field of ['errorKind', 'path', 'code']) {
        if (expect[field] !== undefined && expect[field] !== actual[field]) {
          failures.push(`${field}: expected ${JSON.stringify(expect[field])}, got ${JSON.stringify(actual[field])}`);
        }
      }
    }
    return { fixture: id, name: 'snapshot', failures, actual };
  }

  runBucketVectors(): Outcome[] {
    const vectors = this.json('fixtures/bucketing/bucket-sha256-v1.json');
    if (!Array.isArray(vectors)) {
      throw new Error('The bucket vectors file is not a list.');
    }
    return vectors.flatMap((item, index) => {
      const vector = obj(item);
      if (vector === null) {
        return [];
      }
      const [salt, kind, value] = [text(vector, 'salt'), text(vector, 'kind'), text(vector, 'value')];
      const failures: string[] = [];
      const input = bucketInput(salt, kind, value);
      if (toHex(input) !== vector.inputHex) {
        failures.push('hashed bytes differ');
      }
      if (toHex(sha256(input)).slice(0, 16) !== vector.digestPrefixHex) {
        failures.push('digest prefix differs');
      }
      const computed = bucket(salt, kind, value);
      if (computed !== vector.bucket) {
        failures.push(`bucket is ${String(computed)}, expected ${JSON.stringify(vector.bucket)}`);
      }
      if (computed < 0 || computed >= BUCKET_COUNT) {
        failures.push('bucket out of range');
      }
      return [{ fixture: 'bucketing/bucket-sha256-v1', name: `#${String(index)} ${salt}/${kind}`, failures, actual: { bucket: computed } }];
    });
  }

  runCanonicalVectors(): Outcome[] {
    return this.paths('fixtures/canonical/').map((path) => {
      const vector = obj(this.json(path));
      const failures: string[] = [];
      let canonical = '';
      try {
        canonical = canonicalize(vector?.input ?? null);
      } catch (error) {
        failures.push(`cannot canonicalize: ${String(error)}`);
      }
      if (vector !== null) {
        if (canonical !== vector.canonical) {
          failures.push(`canonical form is ${canonical}`);
        }
        if (`sha256:${toHex(sha256(utf8Bytes(canonical)))}` !== vector.checksum) {
          failures.push('checksum differs');
        }
      }
      return { fixture: 'canonical', name: path.slice('fixtures/canonical/'.length), failures, actual: { canonical } };
    });
  }

  /** Runs everything and returns a conformance report in the format of the protocol's conformance specification. */
  report(evaluatorName: string, evaluatorVersion: string): Report {
    const report: Report = {
      protocol: (this.files.get('VERSION') ?? 'unversioned').trim(),
      evaluator: { name: evaluatorName, version: evaluatorVersion },
      results: [],
      snapshots: [],
      failures: [],
    };
    const describe = (o: Outcome): string => `${o.fixture} / ${o.name}:\n  - ${o.failures.join('\n  - ')}`;

    for (const id of this.evaluationCaseIds()) {
      const outcome = this.runEvaluationCase(id.fixture, id.case);
      report.results.push({ fixture: id.fixture, case: id.case, ...outcome.actual });
      if (outcome.failures.length > 0) {
        report.failures.push(describe(outcome));
      }
    }
    for (const id of this.snapshotFixtureIds()) {
      const outcome = this.runSnapshotFixture(id);
      report.snapshots.push({ fixture: id, ...outcome.actual });
      if (outcome.failures.length > 0) {
        report.failures.push(describe(outcome));
      }
    }
    for (const outcome of [...this.runBucketVectors(), ...this.runCanonicalVectors()]) {
      if (outcome.failures.length > 0) {
        report.failures.push(describe(outcome));
      }
    }
    return report;
  }
}

/**
 * Each listed step must appear in the trace in order, with every listed field equal; listed conditions are matched
 * by path. Extra steps and fields are allowed.
 */
function traceProblem(expected: Json[], trace: unknown): string | null {
  const steps = isObject(trace) && Array.isArray(trace.steps) ? (trace.steps as unknown[]) : [];
  let position = 0;
  for (const wanted of expected) {
    const want = obj(wanted);
    if (want === null) {
      return 'a listed step is not an object';
    }
    let found = false;
    for (; position < steps.length; position += 1) {
      const step = obj(steps[position]);
      if (step !== null && stepMatches(want, step)) {
        found = true;
        position += 1;
        break;
      }
    }
    if (!found) {
      return `no step matches ${JSON.stringify(want)}`;
    }
  }
  return null;
}

function stepMatches(want: Obj, step: Obj): boolean {
  for (const [field, value] of Object.entries(want)) {
    if (field === 'conditions') {
      const have = Array.isArray(step.conditions) ? objects(step.conditions) : [];
      for (const listed of Array.isArray(value) ? value : []) {
        const wantedCondition = obj(listed);
        const present = have.find((c) => c.path === wantedCondition?.path);
        if (wantedCondition === null || present === undefined || Object.entries(wantedCondition).some(([k, v]) => present[k] !== v)) {
          return false;
        }
      }
    } else if (!same(step[field], value)) {
      return false;
    }
  }
  return true;
}
