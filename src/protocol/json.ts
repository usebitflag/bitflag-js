import { isWellFormed, utf8Length } from '../evaluation/values/utf8.js';
import { MalformedSnapshot, Problem } from './errors.js';

/** A decoded JSON value. Objects are plain objects, so a key such as "__proto__" is an ordinary member. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The hard ceiling for a snapshot; publication sets a lower limit. */
export const MAX_BYTES = 5 * 1024 * 1024;

/** Levels of arrays and objects. */
export const MAX_DEPTH = 64;

export const MAX_SAFE_INTEGER = 9007199254740991;

export function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The deepest nesting of arrays and objects in JSON text, without building any structure. */
function nesting(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (char === ']' || char === '}') {
      depth -= 1;
    }
  }
  return deepest;
}

function wellFormed(value: Json): boolean {
  if (typeof value === 'string') {
    return isWellFormed(value);
  }
  if (Array.isArray(value)) {
    return value.every(wellFormed);
  }
  if (isObject(value)) {
    return Object.entries(value).every(([key, member]) => isWellFormed(key) && wellFormed(member));
  }
  return true;
}

export interface DecodeLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

/**
 * Strict JSON decoding with limits on size and nesting. Duplicate members keep the last value.
 *
 * @throws MalformedSnapshot with INVALID_JSON, TOO_DEEP or TOO_LARGE
 */
export function decodeJson(text: string, limits: DecodeLimits = {}): Json {
  const { maxBytes = MAX_BYTES, maxDepth = MAX_DEPTH } = limits;
  if (utf8Length(text) > maxBytes) {
    throw MalformedSnapshot.malformed('', Problem.TOO_LARGE);
  }
  if (nesting(text) > maxDepth) {
    throw MalformedSnapshot.malformed('', Problem.TOO_DEEP);
  }

  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch (error) {
    throw MalformedSnapshot.malformed('', Problem.INVALID_JSON, error instanceof Error ? error.message : '');
  }
  if (!wellFormed(value)) {
    throw MalformedSnapshot.malformed('', Problem.INVALID_JSON, 'a string is not valid Unicode');
  }
  return value;
}

/** Whether a number is not safe: an integer value outside ±(2^53 - 1), however it was written, or too large for binary64. */
export function isUnsafeNumber(value: number): boolean {
  return !Number.isFinite(value) || (Math.floor(value) === value && Math.abs(value) > MAX_SAFE_INTEGER);
}
