import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  localDateOf,
  localDayEnd,
  localDayStart,
  startOfLocalMonth,
  startOfLocalWeek,
} from '../src/stats/time';

const HOUR_MS = 60 * 60 * 1000;

describe('localDateOf', () => {
  it('formats an instant in the given timezone', () => {
    const instant = new Date('2026-10-18T16:30:00Z');
    expect(localDateOf(instant, 'Asia/Shanghai')).toBe('2026-10-19');
    expect(localDateOf(instant, 'America/New_York')).toBe('2026-10-18');
  });

  it('rejects an invalid timezone', () => {
    expect(() => localDateOf(new Date('2026-10-18T16:30:00Z'), 'Mars/Olympus')).toThrow();
  });
});

describe('localDayStart / localDayEnd', () => {
  it('returns the UTC boundaries of a Shanghai local day', () => {
    expect(localDayStart('2026-10-19', 'Asia/Shanghai').toISOString()).toBe(
      '2026-10-18T16:00:00.000Z',
    );
    expect(localDayEnd('2026-10-19', 'Asia/Shanghai').toISOString()).toBe(
      '2026-10-19T16:00:00.000Z',
    );
  });

  it('handles the 23-hour day when New York starts DST', () => {
    const start = localDayStart('2026-03-08', 'America/New_York');
    const end = localDayEnd('2026-03-08', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR_MS);
  });

  it('handles the 25-hour day when Berlin ends DST', () => {
    const start = localDayStart('2026-10-25', 'Europe/Berlin');
    const end = localDayEnd('2026-10-25', 'Europe/Berlin');
    expect(start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR_MS);
  });

  it('round-trips every boundary through localDateOf', () => {
    for (const timezone of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin', 'UTC']) {
      for (const date of ['2026-03-08', '2026-10-25', '2026-12-31', '2026-01-01']) {
        const start = localDayStart(date, timezone);
        expect(localDateOf(start, timezone)).toBe(date);
        expect(localDateOf(new Date(start.getTime() - 1), timezone)).not.toBe(date);
        const end = localDayEnd(date, timezone);
        expect(localDateOf(new Date(end.getTime() - 1), timezone)).toBe(date);
        expect(localDateOf(end, timezone)).toBe(addLocalDays(date, 1));
      }
    }
  });

  it('rejects a malformed local date', () => {
    expect(() => localDayStart('2026-1-9', 'Asia/Shanghai')).toThrow(RangeError);
    expect(() => localDayStart('not-a-date', 'Asia/Shanghai')).toThrow(RangeError);
  });
});

describe('addLocalDays', () => {
  it('crosses year and month boundaries', () => {
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('is a no-op for zero days', () => {
    expect(addLocalDays('2026-10-19', 0)).toBe('2026-10-19');
  });
});

describe('startOfLocalWeek / startOfLocalMonth', () => {
  it('uses Monday as the first day of the week', () => {
    expect(startOfLocalWeek('2026-10-19')).toBe('2026-10-19');
    expect(startOfLocalWeek('2026-10-25')).toBe('2026-10-19');
  });

  it('returns the first day of the month', () => {
    expect(startOfLocalMonth('2026-10-19')).toBe('2026-10-01');
    expect(startOfLocalMonth('2026-01-31')).toBe('2026-01-01');
  });
});
