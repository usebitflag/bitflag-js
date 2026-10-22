import { isWellFormed, utf8Length } from './values/utf8.js';

/** A value of a context attribute: a string, a finite number, a boolean, null, or a list of one scalar type. */
export type AttributeValue = string | number | boolean | null | readonly string[] | readonly number[] | readonly boolean[];

/** The subject an evaluation is about. */
export interface Context {
  readonly kind: string;
  readonly key?: string;
  readonly attributes?: { readonly [name: string]: AttributeValue };
}

/** A context that passed validation, with attributes in a Map so that names such as "__proto__" stay ordinary. */
export interface NormalizedContext {
  readonly kind: string;
  readonly key: string | null;
  readonly attributes: ReadonlyMap<string, unknown>;
}

const KIND = /^[a-z][a-z0-9_-]{0,63}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Family = 'string' | 'number' | 'boolean';

function familyOf(item: unknown): Family | null {
  if (typeof item === 'string') {
    return 'string';
  }
  if (typeof item === 'number') {
    return 'number';
  }
  return typeof item === 'boolean' ? 'boolean' : null;
}

function validValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'string') {
    return utf8Length(value) <= 1024 && isWellFormed(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (!Array.isArray(value) || value.length > 100) {
    return false;
  }
  let family: Family | null = null;
  for (const item of value as unknown[]) {
    const itemFamily = familyOf(item);
    if (itemFamily === null || (family !== null && family !== itemFamily) || !validValue(item)) {
      return false;
    }
    family = itemFamily;
  }
  return true;
}

/**
 * Reads anything as a context. Returns what is wrong with it, or the normalized context when nothing is. The
 * evaluator turns a problem into an INVALID_CONTEXT result; nothing here throws.
 */
export function readContext(input: unknown): { context: NormalizedContext } | { issues: string[] } {
  if (!isPlainObject(input)) {
    return { issues: ['a context is an object'] };
  }

  const issues: string[] = [];
  for (const name of Object.keys(input)) {
    if (name !== 'kind' && name !== 'key' && name !== 'attributes') {
      issues.push(`unknown member "${name}"`);
    }
  }

  const kind = input.kind;
  if (typeof kind !== 'string' || !KIND.test(kind)) {
    issues.push('kind must be a string matching ^[a-z][a-z0-9_-]{0,63}$');
  }

  let key: string | null = null;
  if (input.key !== undefined) {
    const raw = input.key;
    if (typeof raw !== 'string') {
      issues.push('key must be a string');
    } else {
      const bytes = utf8Length(raw);
      if (bytes < 1 || bytes > 256 || !isWellFormed(raw)) {
        issues.push('key must be 1 to 256 bytes of valid text');
      }
      key = raw;
    }
  }

  const attributes = new Map<string, unknown>();
  if (input.attributes !== undefined) {
    const raw = input.attributes;
    if (!isPlainObject(raw)) {
      issues.push('attributes must be an object');
    } else {
      const entries = Object.entries(raw);
      if (entries.length > 100) {
        issues.push('at most 100 attributes');
      }
      for (const [name, value] of entries) {
        const bytes = utf8Length(name);
        if (bytes < 1 || bytes > 128 || name === 'kind' || name === 'key' || !isWellFormed(name)) {
          issues.push(`invalid attribute name "${name}"`);
        }
        if (!validValue(value)) {
          issues.push(`invalid value for attribute "${name}"`);
        }
        attributes.set(name, value);
      }
    }
  }

  if (issues.length > 0 || typeof kind !== 'string') {
    return { issues };
  }
  return { context: { kind, key, attributes } };
}

/** The problems with a context; empty when it is valid. */
export function validateContext(input: unknown): string[] {
  const result = readContext(input);
  return 'issues' in result ? result.issues : [];
}
