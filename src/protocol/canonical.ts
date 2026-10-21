import type { Json } from './json.js';

/**
 * Canonical JSON as defined by RFC 8785 (JSON Canonicalization Scheme), for values from `JSON.parse`.
 * JavaScript already writes numbers and escapes strings the way the scheme requires, and sorts strings by UTF-16
 * code units, which is the order it requires for member names.
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Only finite numbers have a JSON form.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as Json)}`);
  return `{${members.join(',')}}`;
}
