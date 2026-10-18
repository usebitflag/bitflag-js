import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDirectories, forbiddenImports, importSpecifiers } from './imports.js';

const root = resolve(import.meta.dirname, '../..');

describe('evaluation and protocol stay inside the package core', () => {
  it('import nothing outside src/evaluation and src/protocol', () => {
    expect(checkDirectories(root, ['src/evaluation', 'src/protocol'])).toEqual([]);
  });
});

describe('import checker', () => {
  const allowed = [resolve(root, 'src/evaluation'), resolve(root, 'src/protocol')];
  const file = resolve(root, 'src/evaluation/example.ts');

  it('finds static, re-export and dynamic imports', () => {
    const source = `
      import a from './a.js';
      export { b } from "../protocol/b.js";
      const c = await import('node:crypto');
      import 'left-pad';
    `;
    expect(importSpecifiers(source)).toEqual(['./a.js', '../protocol/b.js', 'node:crypto', 'left-pad']);
  });

  it('flags packages, built-ins and paths outside the core', () => {
    const source = `
      import a from './a.js';
      import b from '../protocol/b.js';
      import c from 'lodash';
      import d from 'node:crypto';
      import e from '../client/http.js';
    `;
    expect(forbiddenImports(file, source, allowed)).toEqual(['lodash', 'node:crypto', '../client/http.js']);
  });
});
