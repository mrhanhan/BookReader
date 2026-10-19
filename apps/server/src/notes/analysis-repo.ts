import type { NoteAnalysisKind, NoteAnalysisStatus, NoteFilters } from '@bookr/shared';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { noteAnalyses, type NoteAnalysisRow } from '../db/schema';

/** Creates the streaming placeholder that a running analysis fills in. */
export async function insertAnalysis(
  tx: Transaction,
  input: {
    userId: string;
    kind: NoteAnalysisKind;
    title: string;
    scope: NoteFilters;
    noteCount: number;
    analyzedCount: number;
    model: string;
    promptVersion: string;
    now: Date;
  },
): Promise<NoteAnalysisRow> {
  const [row] = await tx
    .insert(noteAnalyses)
    .values({
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      status: 'streaming',
      scope: input.scope,
      noteCount: input.noteCount,
      analyzedCount: input.analyzedCount,
      content: '',
      model: input.model,
      promptVersion: input.promptVersion,
      promptTokens: 0,
      completionTokens: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!row) {
    throw new Error('insertAnalysis could not insert a row');
  }
  return row;
}

/** Applies a partial update; only the supplied fields and `updatedAt` change. */
export async function updateAnalysis(
  tx: Transaction,
  id: string,
  patch: {
    content?: string;
    status?: NoteAnalysisStatus;
    promptTokens?: number;
    completionTokens?: number;
  },
  now: Date,
): Promise<void> {
  await tx
    .update(noteAnalyses)
    .set({
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.promptTokens !== undefined ? { promptTokens: patch.promptTokens } : {}),
      ...(patch.completionTokens !== undefined
        ? { completionTokens: patch.completionTokens }
        : {}),
      updatedAt: now,
    })
    .where(eq(noteAnalyses.id, id));
}

/** Saved analyses for one reader, newest first; streaming rows stay hidden. */
export async function listAnalysisRows(
  db: Database,
  userId: string,
  limit: number,
): Promise<NoteAnalysisRow[]> {
  return db
    .select()
    .from(noteAnalyses)
    .where(and(eq(noteAnalyses.userId, userId), ne(noteAnalyses.status, 'streaming')))
    .orderBy(desc(noteAnalyses.createdAt), desc(noteAnalyses.id))
    .limit(limit);
}

/** One analysis owned by the reader; other owners' rows are indistinguishable. */
export async function findAnalysisRow(
  db: Database,
  userId: string,
  id: string,
): Promise<NoteAnalysisRow | undefined> {
  const [row] = await db
    .select()
    .from(noteAnalyses)
    .where(and(eq(noteAnalyses.userId, userId), eq(noteAnalyses.id, id)))
    .limit(1);
  return row;
}

/** Deletes an owned analysis and reports whether a row was removed. */
export async function deleteAnalysisRow(
  db: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(noteAnalyses)
    .where(and(eq(noteAnalyses.userId, userId), eq(noteAnalyses.id, id)))
    .returning({ id: noteAnalyses.id });
  return rows.length > 0;
}
