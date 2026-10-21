const PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Year, month and day of a count of days since 1970-01-01. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/**
 * Epoch milliseconds of an RFC 3339 instant, or null when `text` is not one. The fraction is truncated to
 * milliseconds by its digits. Computed with integer arithmetic, without a date library or Date.parse.
 */
export function parseInstant(text: string, utcOnly = false): number | null {
  const match = PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const zone = match[8] ?? 'Z';
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    if (utcOnly) {
      return null;
    }
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) {
      return null;
    }
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const seconds = ((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute - offsetMinutes) * 60 + second;
  return seconds * 1000 + millis;
}

/** The RFC 3339 UTC text of epoch milliseconds: seconds precision, and ".mmm" only when the milliseconds are not zero. */
export function formatInstant(epochMillis: number): string {
  const millis = ((epochMillis % 1000) + 1000) % 1000;
  const seconds = (epochMillis - millis) / 1000;
  const days = Math.floor(seconds / 86400);
  const secondOfDay = seconds - days * 86400;
  const [year, month, day] = civilFromDays(days);

  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}`;
  const time = `${two(Math.floor(secondOfDay / 3600))}:${two(Math.floor((secondOfDay % 3600) / 60))}:${two(secondOfDay % 60)}`;
  return `${date}T${time}${millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`}Z`;
}
