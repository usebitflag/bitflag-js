const NUMBER = '(?:0|[1-9]\\d*)';
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const PATTERN = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const MAX_SAFE = '9007199254740991';
/** Longest valid string, in bytes. Only ASCII is valid, so the length in UTF-16 units decides. */
const MAX_LENGTH = 256;

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const isNumeric = (identifier: string): boolean => /^\d+$/.test(identifier);

/** A numeric identifier of at most 2^53 - 1, without leading zeros (the pattern already excludes those). */
const withinSafeRange = (digits: string): boolean => digits.length < MAX_SAFE.length || (digits.length === MAX_SAFE.length && digits <= MAX_SAFE);

/** SemVer 2.0.0 with no `v` prefix and no partial versions, or null. Build metadata is dropped. */
export function parseSemVer(text: string): SemVer | null {
  const match = text.length > MAX_LENGTH ? null : PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const [, major = '', minor = '', patch = '', pre] = match;
  const prerelease = pre === undefined ? [] : pre.split('.');
  for (const digits of [major, minor, patch, ...prerelease.filter(isNumeric)]) {
    if (!withinSafeRange(digits)) {
      return null;
    }
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

/** Negative, zero or positive as `a` has lower, equal or higher precedence than `b` (SemVer 2.0.0, section 11). */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const [x, y] of [[a.major, b.major], [a.minor, b.minor], [a.patch, b.patch]] as const) {
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length === 0 ? 0 : b.prerelease.length === 0 ? -1 : 1;
  }
  const common = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < common; i += 1) {
    const x = a.prerelease[i] ?? '';
    const y = b.prerelease[i] ?? '';
    if (x === y) {
      continue;
    }
    const xNumeric = isNumeric(x);
    const yNumeric = isNumeric(y);
    if (xNumeric && yNumeric) {
      return Number(x) < Number(y) ? -1 : 1;
    }
    if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length < b.prerelease.length ? -1 : 1;
}
