import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Evaluator, FallbackTypeError } from '../../src/evaluation/evaluator.js';
import type { FlagType } from '../../src/evaluation/types.js';
import { canonicalize } from '../../src/protocol/canonical.js';
import { MalformedSnapshot } from '../../src/protocol/errors.js';
import { decodeJson, isObject, type Json } from '../../src/protocol/json.js';
import { parseSnapshot } from '../../src/protocol/parser.js';

/**
 * The harness of the protocol's differential fuzz test. It reads the input written by the protocol's
 * tools/fuzz/generate.mjs (FUZZ_INPUT) and writes what this evaluator did with it (FUZZ_OUTPUT); the format is in
 * the protocol's conformance specification. It is skipped when FUZZ_INPUT is not set.
 */
const input = process.env.FUZZ_INPUT;
const output = process.env.FUZZ_OUTPUT ?? 'fuzz-js.json';

type Obj = { [key: string]: Json };
const objects = (value: Json | undefined): Obj[] => (Array.isArray(value) ? value.filter(isObject) : []);
const rejection = (error: MalformedSnapshot): Obj => ({ errorKind: error.errorKind, path: error.path, code: error.problem });
const text = (value: Json | undefined): string => (typeof value === 'string' ? value : JSON.stringify(value));
const canonical = (value: unknown): string => canonicalize(JSON.parse(JSON.stringify(value)) as Json);

describe.skipIf(input === undefined)('differential fuzz harness', () => {
  it('writes the output', () => {
    const data = decodeJson(readFileSync(input ?? '', 'utf8'), { maxBytes: 1_000_000_000, maxDepth: 10_000 });
    if (!isObject(data)) {
      throw new Error('The fuzz input is not an object.');
    }
    const result: { evaluator: string; parse: Record<string, Json>; evaluate: Record<string, Json> } = { evaluator: 'bitflag-js', parse: {}, evaluate: {} };

    for (const item of objects(data.parse)) {
      try {
        parseSnapshot(text(item.text));
        result.parse[text(item.id)] = { accepted: true };
      } catch (error) {
        result.parse[text(item.id)] = error instanceof MalformedSnapshot ? { accepted: false, ...rejection(error) } : { accepted: false, thrown: String(error) };
      }
    }

    for (const item of objects(data.evaluate)) {
      let evaluator: Evaluator;
      try {
        evaluator = new Evaluator(parseSnapshot(text(item.snapshotText)), { clock: { now: () => new Date(0) } });
      } catch (error) {
        if (!(error instanceof MalformedSnapshot)) {
          throw error;
        }
        result.evaluate[text(item.id)] = { rejected: rejection(error) };
        continue;
      }
      const options = (c: Obj): { at: Date; details: boolean; trace: boolean } => ({ at: new Date(text(c.at)), details: c.details === true, trace: c.trace === true });
      const results: Json[] = [];
      for (const c of objects(item.cases)) {
        try {
          results.push(canonical(evaluator.evaluate(text(c.flagKey), c.context, text(c.type) as FlagType, c.fallback ?? null, options(c))));
        } catch (error) {
          results.push(error instanceof FallbackTypeError ? 'THROWS FallbackTypeError' : `CRASH ${String(error)}`);
        }
      }
      for (const c of objects(item.bulk)) {
        try {
          const all = evaluator.evaluateAll(c.context, options(c));
          results.push(canonical({ results: Object.fromEntries(all.results), revision: all.revision, generation: all.generation }));
        } catch (error) {
          results.push(`CRASH ${String(error)}`);
        }
      }
      result.evaluate[text(item.id)] = results;
    }

    writeFileSync(output, JSON.stringify(result));
    expect(Object.keys(result.parse)).toHaveLength(objects(data.parse).length);
  });
});
