import {
  ERROR_CODES,
  createAnnotationSchema,
  updateAnnotationSchema,
  type AnnotationDto,
  type AnnotationMutationResult,
} from '@bookr/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app';
import { AppError } from '../errors';
import { toAnnotationDto } from './dto';
import { assertLocatorKind, requireLiveBook, type ReadingActor } from './progress';
import {
  findOwnedAnnotationForUpdate,
  insertAnnotation,
  insertAnnotationHistory,
  listAnnotationRows,
  softDeleteAnnotation,
  updateAnnotationRow,
} from './repo';

type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>;
type UpdateAnnotationInput = z.infer<typeof updateAnnotationSchema>;

/** Lists the caller's live annotations on a live book, newest edit first. */
export async function listAnnotations(
  deps: AppDeps,
  userId: string,
  bookId: string,
): Promise<AnnotationDto[]> {
  await requireLiveBook(deps, bookId);
  const rows = await listAnnotationRows(deps.db, userId, bookId);
  return rows.map(toAnnotationDto);
}

/** Creates an annotation owned by the caller on a live book. */
export async function createAnnotation(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  input: CreateAnnotationInput,
): Promise<AnnotationDto> {
  const book = await requireLiveBook(deps, bookId);
  assertLocatorKind(book, input.locator);

  const row = await insertAnnotation(deps.db, {
    userId: actor.id,
    bookId,
    type: input.type,
    color: input.color,
    locator: input.locator,
    selectedText: input.selectedText,
    noteText: input.noteText ?? null,
    tags: input.tags,
    now: deps.clock.now(),
  });
  return toAnnotationDto(row);
}

/**
 * Applies an annotation edit under a row lock. A stale `revision` is not an
 * error: the edit still lands and the caller is told via `conflict` so it can
 * refresh its copy. The replaced note text is archived first.
 */
export async function updateAnnotation(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  annotationId: string,
  input: UpdateAnnotationInput,
): Promise<AnnotationMutationResult> {
  await requireLiveBook(deps, bookId);
  const now = deps.clock.now();

  return deps.db.transaction(async (tx) => {
    const row = await findOwnedAnnotationForUpdate(tx, annotationId, bookId, actor.id);
    // Missing, deleted and another member's row are all 404 so ownership is
    // never revealed through the status code.
    if (!row) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }

    const conflict = input.revision !== row.revision;
    const requestedNoteText = input.noteText;
    const replacesNote = requestedNoteText !== undefined && requestedNoteText !== row.noteText;
    const oldNoteText = row.noteText;

    if (row.type === 'note' && requestedNoteText !== undefined && requestedNoteText === null) {
      throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, { noteText: 'required' });
    }

    if (replacesNote && oldNoteText !== null && oldNoteText.trim() !== '') {
      await insertAnnotationHistory(tx, {
        annotationId,
        noteText: oldNoteText,
        editedAt: now,
        deviceId: actor.deviceId ?? null,
      });
    }

    const updated = await updateAnnotationRow(tx, annotationId, {
      color: input.color ?? row.color,
      noteText: requestedNoteText !== undefined ? requestedNoteText : oldNoteText,
      tags: input.tags ?? row.tags,
      revision: row.revision + 1,
      now,
    });
    return { annotation: toAnnotationDto(updated), conflict };
  });
}

/** Soft-deletes the caller's annotation; any other target is a 404. */
export async function deleteAnnotation(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  annotationId: string,
): Promise<void> {
  await requireLiveBook(deps, bookId);
  const deleted = await softDeleteAnnotation(
    deps.db,
    annotationId,
    bookId,
    actor.id,
    deps.clock.now(),
  );
  if (!deleted) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
}
