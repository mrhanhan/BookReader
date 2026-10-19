/** Milliseconds in one hour, used by the DST correction search. */
const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds in one calendar day; local-date arithmetic ignores timezones. */
const DAY_MS = 24 * HOUR_MS;

/** Correction step used when the offset guess misses the local date. */
const CORRECTION_STEP_MS = 15 * 60 * 1000;

/**
 * Some zones shift by 30 or 45 minutes (for example Australia/Lord_Howe), so
 * the correction search walks in 15-minute steps. Twelve steps cover ±3 hours.
 */
const MAX_CORRECTION_STEPS = 12;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Parses `YYYY-MM-DD` strictly, rejecting impossible calendar dates. */
function parseLocalDate(localDate: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new RangeError(`Invalid local date: ${localDate}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid local date: ${localDate}`);
  }
  return { year, month, day };
}

/** Formats a UTC instant as `YYYY-MM-DD` without involving a timezone. */
function formatUtcDate(ms: number): string {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** YYYY-MM-DD of `instant` in `timezone`. */
export function localDateOf(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: 'year' | 'month' | 'day'): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) {
    throw new RangeError(`Cannot format ${instant.toISOString()} in ${timezone}`);
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Offset of `timezone` at `instant`, in milliseconds east of UTC. */
function offsetMsAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  if (name === 'GMT' || name === 'UTC') {
    return 0;
  }
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name);
  if (!match) {
    throw new RangeError(`Unsupported offset "${name}" for ${timezone}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4] ?? 0);
  return sign * (hours * 60 * 60 + minutes * 60 + seconds) * 1000;
}

/** First UTC instant whose local date is `localDate`. */
export function localDayStart(localDate: string, timezone: string): Date {
  const { year, month, day } = parseLocalDate(localDate);
  // Treat local midnight as if it were UTC, then shift by the offset in effect
  // near that time. DST transitions can leave the guess on the wrong side of
  // the boundary (and the boundary can sit at a non-hour offset), so verify
  // with `localDateOf` and search nearby quarter hours for the earliest match.
  const guess = Date.UTC(year, month - 1, day);
  const base = guess - offsetMsAt(new Date(guess), timezone);
  for (let step = -MAX_CORRECTION_STEPS; step <= MAX_CORRECTION_STEPS; step += 1) {
    const candidate = new Date(base + step * CORRECTION_STEP_MS);
    if (localDateOf(candidate, timezone) === localDate) {
      return candidate;
    }
  }
  throw new RangeError(`Cannot resolve start of ${localDate} in ${timezone}`);
}

/** First UTC instant of the next local date. */
export function localDayEnd(localDate: string, timezone: string): Date {
  return localDayStart(addLocalDays(localDate, 1), timezone);
}

/** Calendar arithmetic on YYYY-MM-DD strings (no timezone involved). */
export function addLocalDays(localDate: string, days: number): string {
  const { year, month, day } = parseLocalDate(localDate);
  if (!Number.isInteger(days)) {
    throw new RangeError(`Invalid day offset: ${days}`);
  }
  return formatUtcDate(Date.UTC(year, month - 1, day) + days * DAY_MS);
}

/** Monday of the week containing `localDate`. */
export function startOfLocalWeek(localDate: string): string {
  const { year, month, day } = parseLocalDate(localDate);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addLocalDays(localDate, -((weekday + 6) % 7));
}

/** First day of the month of `localDate`. */
export function startOfLocalMonth(localDate: string): string {
  parseLocalDate(localDate);
  return `${localDate.slice(0, 7)}-01`;
}
