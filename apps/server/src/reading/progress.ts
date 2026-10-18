import type { Locator, ReadingProgressDto } from '@bookr/shared';
import type { AppDeps } from '../app';
import { toProgressDto } from './dto';
import { assertLocatorKind, requireLiveBook, type ReadingActor } from './guards';
import { findProgressRow, upsertProgress } from './repo';

/** Returns the caller's latest position for a live book, or null when unread. */
export async function getProgress(
  deps: AppDeps,
  userId: string,
  bookId: string,
): Promise<ReadingProgressDto | null> {
  await requireLiveBook(deps, bookId);
  const row = await findProgressRow(deps.db, userId, bookId);
  return row ? toProgressDto(row) : null;
}

/**
 * Stores the caller's latest position. Percent is derived from the locator so
 * the two can never disagree, and the issuing device is recorded for later
 * sync diagnostics.
 */
export async function saveProgress(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  locator: Locator,
): Promise<ReadingProgressDto> {
  const book = await requireLiveBook(deps, bookId);
  assertLocatorKind(book, locator);

  const row = await upsertProgress(deps.db, {
    userId: actor.id,
    bookId,
    locator,
    percent: locator.percent,
    deviceId: actor.deviceId ?? null,
    updatedAt: deps.clock.now(),
  });
  return toProgressDto(row);
}
