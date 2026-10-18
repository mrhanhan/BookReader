import type { AiAction, AiMessageRole, AiMessageStatus, Locator } from '@bookr/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { aiMessages, aiThreads, type AiMessageRow, type AiThreadRow } from '../db/schema';
import type { ReadingTransaction } from '../reading/repo';

/** Values needed to persist a new thread. */
export interface InsertThreadInput {
  id?: string;
  userId: string;
  bookId: string;
  title: string;
  anchorLocator: Locator | null;
  now: Date;
}

/** Values needed to persist one transcript message. */
export interface InsertMessageInput {
  id?: string;
  threadId: string;
  role: AiMessageRole;
  content?: string;
  status?: AiMessageStatus;
  action?: AiAction | null;
  selectedText?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  now: Date;
}

/** A thread row together with the number of messages it holds. */
export interface ThreadWithCount extends AiThreadRow {
  messageCount: number;
}

/** Inserts a thread owned by `userId`, timestamped with the supplied clock. */
export async function insertThread(
  tx: ReadingTransaction,
  input: InsertThreadInput,
): Promise<AiThreadRow> {
  const [row] = await tx
    .insert(aiThreads)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      userId: input.userId,
      bookId: input.bookId,
      title: input.title,
      anchorLocator: input.anchorLocator,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!row) {
    throw new Error('insertThread could not insert an ai_threads row');
  }
  return row;
}

/** Loads one thread scoped to its owner; another member's row is invisible. */
export async function findThreadRow(
  db: Database,
  userId: string,
  threadId: string,
): Promise<AiThreadRow | undefined> {
  const [row] = await db
    .select()
    .from(aiThreads)
    .where(and(eq(aiThreads.userId, userId), eq(aiThreads.id, threadId)))
    .limit(1);
  return row;
}

/** Lists the caller's threads on one book, most recently updated first. */
export async function listThreadRows(
  db: Database,
  userId: string,
  bookId: string,
): Promise<ThreadWithCount[]> {
  const rows = await db
    .select({
      id: aiThreads.id,
      userId: aiThreads.userId,
      bookId: aiThreads.bookId,
      title: aiThreads.title,
      anchorLocator: aiThreads.anchorLocator,
      createdAt: aiThreads.createdAt,
      updatedAt: aiThreads.updatedAt,
      messageCount: sql<number>`count(${aiMessages.id})::int`,
    })
    .from(aiThreads)
    .leftJoin(aiMessages, eq(aiMessages.threadId, aiThreads.id))
    .where(and(eq(aiThreads.userId, userId), eq(aiThreads.bookId, bookId)))
    .groupBy(aiThreads.id)
    .orderBy(desc(aiThreads.updatedAt), desc(aiThreads.id));

  // Aggregates may arrive as strings on some drivers; the DTO is numeric.
  return rows.map((row) => ({ ...row, messageCount: Number(row.messageCount) }));
}

/** Inserts one transcript message inside the caller's transaction. */
export async function insertMessage(
  tx: ReadingTransaction,
  input: InsertMessageInput,
): Promise<AiMessageRow> {
  const [row] = await tx
    .insert(aiMessages)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      threadId: input.threadId,
      role: input.role,
      content: input.content ?? '',
      status: input.status ?? 'complete',
      action: input.action ?? null,
      selectedText: input.selectedText ?? null,
      model: input.model ?? null,
      promptVersion: input.promptVersion ?? null,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!row) {
    throw new Error('insertMessage could not insert an ai_messages row');
  }
  return row;
}

/** Applies the fields a streaming response may settle on one message. */
export async function updateMessage(
  tx: ReadingTransaction,
  messageId: string,
  patch: Partial<Pick<AiMessageRow, 'content' | 'status' | 'promptTokens' | 'completionTokens'>>,
  now: Date,
): Promise<AiMessageRow | undefined> {
  const [row] = await tx
    .update(aiMessages)
    .set({ ...patch, updatedAt: now })
    .where(eq(aiMessages.id, messageId))
    .returning();
  return row;
}

/**
 * Reads a thread transcript oldest first. Only the newest `limit` rows are
 * selected, ordered stably by creation time and id so identical timestamps do
 * not shuffle the transcript.
 */
export async function listMessageRows(
  db: Database,
  threadId: string,
  limit = 200,
): Promise<AiMessageRow[]> {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.threadId, threadId))
    .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
    .limit(limit);
  return rows.reverse();
}

/** Hard-deletes one owned thread; messages follow via ON DELETE CASCADE. */
export async function deleteThreadRow(
  db: Database,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const rows = await db
    .delete(aiThreads)
    .where(and(eq(aiThreads.userId, userId), eq(aiThreads.id, threadId)))
    .returning({ id: aiThreads.id });
  return rows.length > 0;
}
