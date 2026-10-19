import { z } from 'zod';

/** How often the reader flushes reading time while the page stays active. */
export const READING_SESSION_TICK_SECONDS = 30;
/** How long the reader may sit idle before the clock pauses. */
export const READING_IDLE_PAUSE_SECONDS = 120;
/** Longest single in-memory segment before a new session is opened. */
export const READING_SESSION_MAX_SEGMENT_SECONDS = 1_800;
/** Upper bound on active time in one session (4 hours). */
export const READING_SESSION_MAX_ACTIVE_SECONDS = 14_400;
/** Upper bound on the wall-clock span of one session (24 hours). */
export const READING_SESSION_MAX_SPAN_SECONDS = 86_400;
/** Upper bound on pages credited to one session. */
export const READING_SESSION_MAX_PAGES = 100_000;
/** Active seconds needed before a day counts towards the streak. */
export const EFFECTIVE_READING_SECONDS = 600;
/** Number of days returned by the stats endpoint for the daily chart. */
export const STATS_DAILY_DAYS = 30;

/** Payload of a `reading_session` sync upsert; the entity id is the session id. */
export interface ReadingSessionPayload {
  bookId: string;
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  activeSeconds: number;
  pagesRead: number;
}

/** Tolerance for client timers running slightly ahead of the wall clock. */
const WALL_CLOCK_TOLERANCE_SECONDS = 5;

export const syncReadingSessionPayloadSchema: z.ZodType<ReadingSessionPayload> = z
  .object({
    bookId: z.uuid(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    activeSeconds: z.number().int().min(0).max(READING_SESSION_MAX_ACTIVE_SECONDS),
    pagesRead: z.number().int().min(0).max(READING_SESSION_MAX_PAGES),
  })
  .superRefine((payload, ctx) => {
    const startedAt = Date.parse(payload.startedAt);
    const endedAt = Date.parse(payload.endedAt);

    if (endedAt < startedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt must not precede startedAt',
      });
      return;
    }

    const spanSeconds = (endedAt - startedAt) / 1000;
    if (spanSeconds > READING_SESSION_MAX_SPAN_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: `session span must not exceed ${READING_SESSION_MAX_SPAN_SECONDS} seconds`,
      });
    }

    if (payload.activeSeconds > spanSeconds + WALL_CLOCK_TOLERANCE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeSeconds'],
        message: 'activeSeconds must not exceed the session span',
      });
    }
  });

export interface DailyReadingStatDto {
  date: string; // YYYY-MM-DD in the user's timezone
  activeSeconds: number;
  qualified: boolean;
}

export interface TopBookStatDto {
  id: string;
  title: string;
  author: string | null;
  activeSeconds: number;
}

export interface ReadingStatsDto {
  timezone: string;
  today: string;
  streakDays: number;
  effectiveDays: number;
  todaySeconds: number;
  weekSeconds: number;
  monthSeconds: number;
  finishedBooks: number;
  topBook: TopBookStatDto | null;
  /** Oldest first, exactly STATS_DAILY_DAYS entries, ending today. */
  daily: DailyReadingStatDto[];
}

/** Whether `Intl` accepts the zone; used by both the API schema and the UI. */
export function isValidTimeZone(timezone: string): boolean {
  // Raw UTC offsets (e.g. "+08:00") are accepted by newer Intl implementations
  // but are not IANA zone names, so reject them explicitly.
  if (timezone.trim() === '' || /^[+-]/.test(timezone)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}
