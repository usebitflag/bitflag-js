import { describe, expect, it } from 'vitest';
import { formatInstant, parseInstant } from '../../src/evaluation/values/instant.js';
import { compareSemVer, parseSemVer, type SemVer } from '../../src/evaluation/values/semver.js';
import { codePointLength, isWellFormed, utf8Length } from '../../src/evaluation/values/utf8.js';

describe('utf8', () => {
  it('counts bytes, not characters', () => {
    expect(utf8Length('')).toBe(0);
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('日本語')).toBe(9);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('é')).toBe(3);
    expect(utf8Length('\ud800')).toBe(3);
  });

  it('agrees with the platform encoder', () => {
    for (const text of ['', 'a', 'é', 'ࠀ', '￿', '😀😀', 'mixed é 日 😀 text']) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it('counts code points', () => {
    expect(codePointLength('a😀é')).toBe(3);
  });

  it('knows unpaired surrogates', () => {
    expect(isWellFormed('😀')).toBe(true);
    expect(isWellFormed('\ud800')).toBe(false);
    expect(isWellFormed('\udc00x')).toBe(false);
    expect(isWellFormed('\ud800x')).toBe(false);
    expect(isWellFormed('')).toBe(true);
  });
});

describe('instants', () => {
  it.each([
    ['1970-01-01T00:00:00Z', 0],
    ['1970-01-01T00:00:00.001Z', 1],
    ['1969-12-31T23:59:59.999Z', -1],
    ['1969-12-31T23:59:59.9999Z', -1],
    ['1970-01-01T00:00:00.123999999Z', 123],
    ['1970-01-01T08:00:00+08:00', 0],
    ['1969-12-31T19:00:00-05:00', 0],
    ['2026-10-06T08:00:00Z', 1791273600000],
    ['2028-02-29T00:00:00Z', 1835395200000],
    ['0000-01-01T00:00:00Z', -62167219200000],
    ['9999-12-31T23:59:59.999Z', 253402300799999],
  ])('parses %s', (text, expected) => {
    expect(parseInstant(text)).toBe(expected);
  });

  it.each([
    '2026-10-06', '2026-10-06T08:00:00', '2026-10-06t08:00:00Z', '2026-10-06T08:00:00z', '2026-10-06 08:00:00Z', '2016-12-31T23:59:60Z',
    '2026-10-06T24:00:00Z', '2026-10-06T08:60:00Z', '2026-13-01T00:00:00Z', '2026-01-32T00:00:00Z', '2026-04-31T00:00:00Z',
    '2026-02-30T00:00:00Z', '2027-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2026-10-06T00:00:00+24:00', '2026-10-06T00:00:00+08:60',
    '2026-10-06T00:00:00+0800', '2026-10-06T08:00:00.1234567890Z', '2026-10-06T08:00:00.Z', '2026-10-06T08:00:00Z\n', ' 2026-10-06T08:00:00Z', '',
  ])('rejects %j', (text) => {
    expect(parseInstant(text)).toBeNull();
  });

  it('can require UTC', () => {
    expect(parseInstant('2026-10-06T08:00:00Z', true)).toBe(1791273600000);
    expect(parseInstant('2026-10-06T08:00:00+00:00', true)).toBeNull();
  });

  it('agrees with Date over many instants and formats them back', () => {
    let seed = 8785;
    const next = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    for (let i = 0; i < 3000; i += 1) {
      const year = 1 + next(9999);
      const month = 1 + next(12);
      const day = 1 + next(28);
      const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
      const hours = next(24);
      const text = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(next(60))}:${pad(next(60))}.${pad(next(1000), 3)}Z`;
      const expected = new Date(text);
      // Date maps years 0 to 99 differently; years from 100 on are unambiguous.
      if (year >= 100) {
        expect(parseInstant(text)).toBe(expected.getTime());
      }
      const millis = parseInstant(text);
      expect(millis).not.toBeNull();
      expect(parseInstant(formatInstant(millis ?? 0))).toBe(millis);
    }
  });

  it('formats epoch milliseconds', () => {
    expect(formatInstant(0)).toBe('1970-01-01T00:00:00Z');
    expect(formatInstant(1)).toBe('1970-01-01T00:00:00.001Z');
    expect(formatInstant(-1)).toBe('1969-12-31T23:59:59.999Z');
    expect(formatInstant(1791273600000)).toBe('2026-10-06T08:00:00Z');
    expect(formatInstant(-62167219200000)).toBe('0000-01-01T00:00:00Z');
    expect(formatInstant(253402300799999)).toBe('9999-12-31T23:59:59.999Z');
  });
});

describe('semver', () => {
  const v = (text: string): SemVer => {
    const parsed = parseSemVer(text);
    if (parsed === null) {
      throw new Error(`Not a valid SemVer: ${text}`);
    }
    return parsed;
  };

  it('orders versions by SemVer 2.0.0 precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '2.1.0', '2.1.1', '10.0.0'];
    ordered.forEach((a, i) => {
      ordered.forEach((b, j) => {
        expect(Math.sign(compareSemVer(v(a), v(b)))).toBe(Math.sign(i - j));
      });
    });
  });

  it('compares numeric parts as numbers', () => {
    expect(compareSemVer(v('4.10.0'), v('4.9.0'))).toBeGreaterThan(0);
    expect(compareSemVer(v('9007199254740991.0.0'), v('9007199254740990.0.0'))).toBeGreaterThan(0);
  });

  it('ignores build metadata', () => {
    expect(compareSemVer(v('1.0.0+a'), v('1.0.0+b'))).toBe(0);
    expect(compareSemVer(v('1.0.0-rc.1+x'), v('1.0.0-rc.1'))).toBe(0);
  });

  it('puts upper case before lower case and numbers before words', () => {
    expect(compareSemVer(v('1.0.0-Beta'), v('1.0.0-beta'))).toBeLessThan(0);
    expect(compareSemVer(v('1.0.0-99'), v('1.0.0-0a'))).toBeLessThan(0);
  });

  it.each([
    '4.2', '4', '4.2.0.1', '4.2.0.', 'v4.2.0', 'V4.2.0', '04.2.0', '4.02.0', '4.2.00', '4.2.0-01', '1.0.0-', '1.0.0-a..b', '1.0.0+', '1.0.0+a..b',
    ' 4.2.0', '4.2.0 ', '4.2.0\n', '4.2.0-rc_1', '4.2.٣', '+4.2.0', '-1.2.3', '4.2.0-béta', '9007199254740992.0.0', '99999999999999999999.0.0',
    '1.0.0-9007199254740992', '', 'latest', `1.0.0-${'a'.repeat(251)}`,
  ])('rejects %j', (text) => {
    expect(parseSemVer(text)).toBeNull();
  });

  it.each(['0.0.0', '1.2.3', '1.0.0-0', '1.0.0-0a', '1.0.0-alpha-1', '1.0.0+build.5', '1.0.0-rc.1+sha.5114f85', '9007199254740991.9007199254740991.9007199254740991', '1.0.0-9007199254740991', `1.0.0-${'a'.repeat(250)}`])('accepts %s', (text) => {
    expect(parseSemVer(text)).not.toBeNull();
  });
});
