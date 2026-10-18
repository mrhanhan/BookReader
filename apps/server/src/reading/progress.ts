import type { Locator, ReadingProgressDto } from '@bookr/shared';
import type { AppDeps } from '../app';
import { lockUserChanges } from '../sync/repo';
import { progressChangePayload, recordChange } from '../sync/service';
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
 * the two can never disagree, the issuing device is recorded for later sync
 * diagnostics, and the write is appended to the user's change log.
 */
export async function saveProgress(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  locator: Locator,
): Promise<ReadingProgressDto> {
  const book = await requireLiveBook(deps, bookId);
  assertLocatorKind(book, locator);
  const now = deps.clock.now();

  const row = await deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await upsertProgress(tx, {
      userId: actor.id,
      bookId,
      locator,
      percent: locator.percent,
      deviceId: actor.deviceId ?? null,
      updatedAt: now,
      clientUpdatedAt: now,
    });
    const dto = toProgressDto(stored);
    await recordChange(tx, {
      userId: actor.id,
      entityType: 'reading_progress',
      entityId: bookId,
      op: 'upsert',
      payload: progressChangePayload(dto, now),
      clientUpdatedAt: now,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return stored;
  });
  return toProgressDto(row);
}
