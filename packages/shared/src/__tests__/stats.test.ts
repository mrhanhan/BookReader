import { describe, expect, it } from 'vitest';
import {
  EFFECTIVE_READING_SECONDS,
  READING_IDLE_PAUSE_SECONDS,
  READING_SESSION_MAX_ACTIVE_SECONDS,
  READING_SESSION_MAX_PAGES,
  READING_SESSION_MAX_SEGMENT_SECONDS,
  READING_SESSION_MAX_SPAN_SECONDS,
  READING_SESSION_TICK_SECONDS,
  STATS_DAILY_DAYS,
  isValidTimeZone,
  syncReadingSessionPayloadSchema,
  type ReadingSessionPayload,
} from '../stats';
import { SYNC_ENTITY_TYPES, syncPayloadSchemaFor } from '../sync';
import { updateProfileSchema } from '../schemas/auth';

const BOOK = '01a14f19-c2e6-73c7-a934-733f788451cf';
const STARTED_AT = '2026-10-18T08:00:00.000Z';

function payload(over: Partial<ReadingSessionPayload> = {}): ReadingSessionPayload {
  return {
    bookId: BOOK,
    startedAt: STARTED_AT,
    endedAt: '2026-10-18T08:30:00.000Z',
    activeSeconds: 1_500,
    pagesRead: 12,
    ...over,
  };
}

describe('reading stats constants', () => {
  it('matches the agreed timing contract', () => {
    expect(READING_SESSION_TICK_SECONDS).toBe(30);
    expect(READING_IDLE_PAUSE_SECONDS).toBe(120);
    expect(READING_SESSION_MAX_SEGMENT_SECONDS).toBe(1_800);
    expect(READING_SESSION_MAX_ACTIVE_SECONDS).toBe(14_400);
    expect(READING_SESSION_MAX_SPAN_SECONDS).toBe(86_400);
    expect(READING_SESSION_MAX_PAGES).toBe(100_000);
    expect(EFFECTIVE_READING_SECONDS).toBe(600);
    expect(STATS_DAILY_DAYS).toBe(30);
  });
});

describe('syncReadingSessionPayloadSchema', () => {
  it('accepts a well-formed reading session', () => {
    expect(syncReadingSessionPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it('rejects an end before the start', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ startedAt: '2026-10-18T09:00:00.000Z', endedAt: STARTED_AT, activeSeconds: 60 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects spans longer than the maximum', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ endedAt: '2026-10-19T08:00:01.000Z', activeSeconds: 60 }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a span exactly at the maximum', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ endedAt: '2026-10-19T08:00:00.000Z', activeSeconds: 60 }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects active time beyond four hours', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ endedAt: '2026-10-18T13:00:00.000Z', activeSeconds: READING_SESSION_MAX_ACTIVE_SECONDS + 1 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects active time beyond the wall-clock span plus tolerance', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ endedAt: '2026-10-18T08:01:00.000Z', activeSeconds: 66 }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts active time within five seconds of the wall-clock span', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ endedAt: '2026-10-18T08:01:00.000Z', activeSeconds: 65 }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects too many pages', () => {
    const result = syncReadingSessionPayloadSchema.safeParse(
      payload({ pagesRead: READING_SESSION_MAX_PAGES + 1 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects negative counters', () => {
    expect(syncReadingSessionPayloadSchema.safeParse(payload({ activeSeconds: -1 })).success).toBe(false);
    expect(syncReadingSessionPayloadSchema.safeParse(payload({ pagesRead: -1 })).success).toBe(false);
  });

  it('rejects non-ISO timestamps', () => {
    expect(
      syncReadingSessionPayloadSchema.safeParse(payload({ startedAt: '2026-10-18 08:00:00' })).success,
    ).toBe(false);
    expect(syncReadingSessionPayloadSchema.safeParse(payload({ endedAt: 'not-a-date' })).success).toBe(false);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
  });

  it('rejects empty strings and unknown zones', () => {
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('rejects raw UTC offsets', () => {
    expect(isValidTimeZone('+08:00')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  it('trims the timezone before validating it', () => {
    expect(updateProfileSchema.parse({ timezone: ' Asia/Tokyo ' })).toEqual({ timezone: 'Asia/Tokyo' });
  });

  it('rejects an invalid timezone', () => {
    expect(updateProfileSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('rejects an empty timezone', () => {
    expect(updateProfileSchema.safeParse({ timezone: '   ' }).success).toBe(false);
  });
});

describe('sync entity registration', () => {
  it('registers reading_session as an entity type', () => {
    expect(SYNC_ENTITY_TYPES).toContain('reading_session');
  });

  it('resolves the reading session payload schema', () => {
    const schema = syncPayloadSchemaFor('reading_session');
    expect(schema.safeParse(payload()).success).toBe(true);
    expect(schema.safeParse({ ...payload(), activeSeconds: -1 }).success).toBe(false);
  });
});
