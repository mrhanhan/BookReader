import {
  ERROR_CODES,
  type AiMessageDto,
  type AiThreadDto,
  type AiUsageDto,
} from '@bookr/shared';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { users, type AiMessageRow } from '../db/schema';
import { AppError } from '../errors';
import { requireLiveBook } from '../reading/guards';
import { readAiConfigView } from './config';
import { readQuota } from './quota';
import {
  deleteThreadRow,
  findThreadRow,
  listMessageRows,
  listThreadRows,
  type ThreadWithCount,
} from './repo';

/** Maps a stored thread row to the wire DTO. */
export function toThreadDto(row: ThreadWithCount): AiThreadDto {
  return {
    id: row.id,
    bookId: row.bookId,
    title: row.title,
    anchorLocator: row.anchorLocator ?? null,
    messageCount: Number(row.messageCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps a stored message row to the wire DTO. */
export function toMessageDto(row: AiMessageRow): AiMessageDto {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    status: row.status,
    action: row.action ?? null,
    selectedText: row.selectedText ?? null,
    model: row.model ?? null,
    promptTokens: Number(row.promptTokens),
    completionTokens: Number(row.completionTokens),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Lists the caller's threads on a live book, newest first. */
export async function listThreads(
  deps: AppDeps,
  userId: string,
  bookId: string,
): Promise<AiThreadDto[]> {
  await requireLiveBook(deps, bookId);
  const rows = await listThreadRows(deps.db, userId, bookId);
  return rows.map(toThreadDto);
}

/** Loads one owned thread and its newest 200 messages in reading order. */
export async function getThreadDetail(
  deps: AppDeps,
  userId: string,
  threadId: string,
): Promise<{ thread: AiThreadDto; messages: AiMessageDto[] }> {
  const row = await findThreadRow(deps.db, userId, threadId);
  if (!row) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  const messages = await listMessageRows(deps.db, threadId);
  return {
    thread: toThreadDto({ ...row, messageCount: messages.length }),
    messages: messages.map(toMessageDto),
  };
}

/** Deletes one owned thread, hiding another member's row behind a 404. */
export async function removeThread(
  deps: AppDeps,
  userId: string,
  threadId: string,
): Promise<void> {
  const deleted = await deleteThreadRow(deps.db, userId, threadId);
  if (!deleted) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
}

/** Reports availability, provider configuration and both quota windows. */
export async function getAiUsage(deps: AppDeps, userId: string): Promise<AiUsageDto> {
  const [user] = await deps.db
    .select({
      timezone: users.timezone,
      aiEnabled: users.aiEnabled,
      dailyLimit: users.aiDailyTokenLimit,
      monthlyLimit: users.aiMonthlyTokenLimit,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  const quota = await readQuota(deps.db, {
    userId,
    timezone: user.timezone,
    limits: { daily: user.dailyLimit, monthly: user.monthlyLimit },
    now: deps.clock.now(),
  });
  const config = await readAiConfigView(deps);

  return {
    enabled: user.aiEnabled,
    configured: config.configured,
    fakeProvider: config.fakeProvider,
    model: config.chatModel,
    daily: quota.daily,
    monthly: quota.monthly,
  };
}

/** Persists the user's AI switch and returns its stored value. */
export async function setAiEnabled(
  deps: AppDeps,
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const [row] = await deps.db
    .update(users)
    .set({ aiEnabled: enabled, updatedAt: deps.clock.now() })
    .where(eq(users.id, userId))
    .returning({ aiEnabled: users.aiEnabled });
  if (!row) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return row.aiEnabled;
}
