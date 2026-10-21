import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './imports.js';

const root = resolve(import.meta.dirname, '../..');

/** Globals and calls that would give the evaluation or the protocol code a side effect or a source of change. */
const FORBIDDEN: [string, RegExp][] = [
  ['randomness', /\bMath\.random\b|\bcrypto\.(getRandomValues|randomUUID|subtle)\b/],
  ['the wall clock', /\bDate\.now\s*\(|\bperformance\.now\b|\bnew Date\s*\(\s*\)/],
  ['the network', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnavigator\b/],
  ['the environment', /\bprocess\.(env|argv|cwd|exit|hrtime)\b|\blocalStorage\b|\bsessionStorage\b|\bdocument\b|\bwindow\b|\brequire\s*\(/],
  ['timers', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/],
  ['the console', /\bconsole\./],
];

/** Where reading the clock is the point: the default clock of the evaluator. */
const ALLOWED = new Map([['src/evaluation/evaluator.ts', ['the wall clock']]]);

function violations(file: string, source: string): string[] {
  const allowed = ALLOWED.get(file) ?? [];
  return FORBIDDEN.filter(([name, pattern]) => !allowed.includes(name) && pattern.test(source)).map(([name]) => `${file} uses ${name}`);
}

describe('evaluation and protocol stay pure', () => {
  it('use no randomness, clocks, network, environment, timers or console', () => {
    const found = ['src/evaluation', 'src/protocol'].flatMap((dir) =>
      sourceFiles(resolve(root, dir)).flatMap((path) => {
        const file = path.slice(root.length + 1);
        const source = readFileSync(path, 'utf8');
        // Mutation testing instruments the sources with code that uses globals of its own.
        return source.includes('stryNS_') ? [] : violations(file, source);
      }),
    );
    expect(found).toEqual([]);
  });

  it('notices what it is looking for', () => {
    expect(violations('x.ts', 'const r = Math.random();')).toEqual(['x.ts uses randomness']);
    expect(violations('x.ts', 'const t = Date.now(); await fetch("/")')).toEqual(['x.ts uses the wall clock', 'x.ts uses the network']);
    expect(violations('x.ts', 'if (process.env.X) console.log(1)')).toEqual(['x.ts uses the environment', 'x.ts uses the console']);
    expect(violations('x.ts', 'const ok = 1 + 1;')).toEqual([]);
  });
});
