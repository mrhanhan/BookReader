import {
  AI_MAX_OUTPUT_TOKENS,
  AI_THREAD_TITLE_MAX_LENGTH,
  ERROR_CODES,
  type AiAction,
  type AiChatRequest,
  type AiMessageStatus,
  type AiStreamDone,
  type AiStreamErrorPayload,
  type AiStreamMeta,
} from '@bookr/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppDeps } from '../app';
import { aiThreads, books, users } from '../db/schema';
import { AppError } from '../errors';
import { assemblePrompt, estimateTokens } from './context';
import { readAiConfig } from './config';
import { PROMPT_VERSION } from './prompts';
import {
  findThreadRow,
  insertMessage,
  insertThread,
  listMessageRows,
  updateMessage,
} from './repo';
import {
  releaseQuota,
  reserveQuota,
  settleQuota,
  type QuotaLimits,
  type QuotaReservation,
} from './quota';
import type { AiChatMessage, AiClient, AiTokenUsage } from './types';

/** Provider failure copy shown to the reader; upstream text never leaks. */
const UPSTREAM_MESSAGE = 'AI 服务暂时不可用，请稍后重试';
const TIMEOUT_MESSAGE = 'AI 响应超时，请重试';
const MAX_HISTORY_MESSAGES = 200;

/** Everything resolved before the response switches to SSE. */
export interface PreparedChat {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  action: AiAction;
  model: string;
  promptVersion: string;
  client: AiClient;
  messages: AiChatMessage[];
  promptTokens: number;
  reservation: QuotaReservation;
  timezone: string;
  limits: QuotaLimits;
}

/** SSE writer used by the route; methods resolve once the frame is flushed. */
export interface ChatSink {
  meta(meta: AiStreamMeta): Promise<void>;
  delta(text: string): Promise<void>;
  done(done: AiStreamDone): Promise<void>;
  error(payload: AiStreamErrorPayload): Promise<void>;
}

function userContent(body: AiChatRequest): string {
  if (body.action === 'explain') return body.selectedText ?? '';
  if (body.action === 'ask') return body.question ?? '';
  return body.scope === 'chapter' ? '总结本章' : '总结本页';
}

function threadTitle(body: AiChatRequest): string {
  if (body.action === 'summarize') {
    return body.scope === 'chapter' ? '总结本章' : '总结本页';
  }
  const prefix = body.action === 'explain' ? '解释：' : '提问：';
  const source = body.action === 'explain' ? (body.selectedText ?? '') : (body.question ?? '');
  return `${prefix}${source}`.slice(0, AI_THREAD_TITLE_MAX_LENGTH);
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Validates availability, assembles the prompt, reserves quota and writes the
 * user message plus the streaming assistant placeholder. Every failure here is
 * still a normal JSON response; nothing has been written to the socket yet.
 */
export async function prepareChat(
  deps: AppDeps,
  userId: string,
  bookId: string,
  body: AiChatRequest,
): Promise<PreparedChat> {
  const [user] = await deps.db
    .select({
      aiEnabled: users.aiEnabled,
      timezone: users.timezone,
      dailyLimit: users.aiDailyTokenLimit,
      monthlyLimit: users.aiMonthlyTokenLimit,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  if (!user.aiEnabled) {
    throw new AppError(403, ERROR_CODES.AI_DISABLED);
  }

  const aiConfig = await readAiConfig(deps);
  if (!aiConfig) {
    throw new AppError(503, ERROR_CODES.AI_NOT_CONFIGURED);
  }

  const [book] = await deps.db
    .select({ id: books.id, title: books.title, author: books.author })
    .from(books)
    .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
    .limit(1);
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  let thread = body.threadId ? await findThreadRow(deps.db, userId, body.threadId) : undefined;
  if (body.threadId && (!thread || thread.bookId !== bookId)) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  const historyRows = thread
    ? await listMessageRows(deps.db, thread.id, MAX_HISTORY_MESSAGES)
    : [];
  const history = historyRows
    .filter(
      (row) =>
        (row.role === 'user' || row.role === 'assistant') &&
        row.content.length > 0 &&
        (row.status === 'complete' || row.status === 'interrupted'),
    )
    .map((row) => ({ role: row.role, content: row.content }));

  const assembled = assemblePrompt({
    action: body.action,
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
    book: { title: book.title, author: book.author },
    ...(body.locator !== undefined ? { locator: body.locator } : {}),
    ...(body.selectedText !== undefined ? { selectedText: body.selectedText } : {}),
    ...(body.question !== undefined ? { question: body.question } : {}),
    ...(body.context?.pageText !== undefined ? { pageText: body.context.pageText } : {}),
    ...(body.context?.chapterText !== undefined
      ? { chapterText: body.context.chapterText }
      : {}),
    history,
    contextTokenBudget: deps.config.ai.contextTokenBudget,
  });

  const limits: QuotaLimits = { daily: user.dailyLimit, monthly: user.monthlyLimit };
  const now = deps.clock.now();
  const reservation = await reserveQuota(deps.db, {
    userId,
    timezone: user.timezone,
    estimate: assembled.promptTokens + AI_MAX_OUTPUT_TOKENS,
    limits,
    now,
  });

  let createdThreadId = thread?.id ?? null;
  try {
    const written = await deps.db.transaction(async (tx) => {
      const activeThread = thread ?? await insertThread(tx, {
        userId,
        bookId,
        title: threadTitle(body),
        anchorLocator: body.locator ?? null,
        now,
      });
      createdThreadId = activeThread.id;

      const userMessage = await insertMessage(tx, {
        threadId: activeThread.id,
        role: 'user',
        content: userContent(body),
        status: 'complete',
        action: body.action,
        selectedText: body.selectedText ?? null,
        now,
      });
      const assistantMessage = await insertMessage(tx, {
        threadId: activeThread.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        action: body.action,
        model: aiConfig.chatModel,
        promptVersion: PROMPT_VERSION,
        now,
      });
      await tx
        .update(aiThreads)
        .set({ updatedAt: now })
        .where(eq(aiThreads.id, activeThread.id));
      return { threadId: activeThread.id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
    });

    return {
      threadId: written.threadId,
      userMessageId: written.userMessageId,
      assistantMessageId: written.assistantMessageId,
      action: body.action,
      model: aiConfig.chatModel,
      promptVersion: PROMPT_VERSION,
      client: deps.aiClientFactory(aiConfig),
      messages: assembled.messages,
      promptTokens: assembled.promptTokens,
      reservation,
      timezone: user.timezone,
      limits,
    };
  } catch (error) {
    await releaseQuota(deps.db, reservation, now);
    if (createdThreadId && !thread) {
      // A failed first write cannot leave a thread without its messages.
      await deps.db.delete(aiThreads).where(eq(aiThreads.id, createdThreadId));
    }
    throw error;
  }
}

function failurePayload(error: unknown): AiStreamErrorPayload {
  const timeout = error instanceof Error && /timed out/i.test(error.message);
  return {
    code: timeout ? ERROR_CODES.AI_TIMEOUT : ERROR_CODES.AI_UPSTREAM_FAILED,
    message: timeout ? TIMEOUT_MESSAGE : UPSTREAM_MESSAGE,
    retryable: !(error instanceof Error && 'retryable' in error && error.retryable === false),
  };
}

/**
 * Streams one prepared exchange to the sink and settles its quota exactly
 * once. A client disconnect keeps the partial answer as `interrupted`; an
 * upstream failure keeps it as `failed` and reports a fixed user-facing copy.
 */
export async function executeChat(
  deps: AppDeps,
  prepared: PreparedChat,
  sink: ChatSink,
  signal: AbortSignal,
): Promise<void> {
  const meta: AiStreamMeta = {
    threadId: prepared.threadId,
    userMessageId: prepared.userMessageId,
    assistantMessageId: prepared.assistantMessageId,
    action: prepared.action,
    model: prepared.model,
    promptVersion: prepared.promptVersion,
  };

  let answer = '';
  let usage: AiTokenUsage | null = null;
  let settled = false;

  const settle = async (
    status: AiMessageStatus,
    actual: AiTokenUsage,
  ): Promise<AiStreamDone | null> => {
    if (settled) return null;
    settled = true;
    const quota = await settleQuota(deps.db, prepared.reservation, actual, deps.clock.now());
    await deps.db.transaction(async (tx) => {
      await updateMessage(tx, prepared.assistantMessageId, {
        content: answer,
        status,
        promptTokens: actual.promptTokens,
        completionTokens: actual.completionTokens,
      }, deps.clock.now());
    });
    return {
      assistantMessageId: prepared.assistantMessageId,
      usage: actual,
      quota: { daily: quota.daily, monthly: quota.monthly },
    };
  };

  try {
    await sink.meta(meta);
    for await (const event of prepared.client.streamChat({
      model: prepared.model,
      messages: prepared.messages,
      maxTokens: AI_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      signal,
    })) {
      if (event.type === 'usage') {
        usage = event.usage;
        continue;
      }
      answer += event.text;
      await sink.delta(event.text);
    }

    const actual = usage ?? {
      promptTokens: prepared.promptTokens,
      completionTokens: estimateTokens(answer),
    };
    const done = await settle('complete', actual);
    if (done) await sink.done(done);
  } catch (error) {
    const aborted = signal.aborted || isAbort(error);
    const actual = usage ?? {
      promptTokens: prepared.promptTokens,
      completionTokens: estimateTokens(answer),
    };
    const done = await settle(aborted ? 'interrupted' : 'failed', actual);
    if (!aborted && done) {
      try {
        await sink.error(failurePayload(error));
      } catch {
        // The connection died while reporting the failure; persistence is done.
      }
    }
  }
}

/** Writes one SSE frame, waiting for drain when the socket applies backpressure. */
async function writeFrame(
  raw: NodeJS.WritableStream & { writableEnded?: boolean; destroyed?: boolean },
  event: string,
  data: unknown,
): Promise<void> {
  if (raw.writableEnded || raw.destroyed) {
    throw abortError();
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (raw.write(frame)) return;
  await Promise.race([
    once(raw, 'drain'),
    delay(5_000).then(() => {
      throw new Error('AI stream backpressure timed out');
    }),
  ]);
}

/** Builds the SSE sink for a hijacked Fastify response. */
export function createReplySink(raw: NodeJS.WritableStream): ChatSink {
  return {
    meta: (meta) => writeFrame(raw, 'meta', meta),
    delta: (text) => writeFrame(raw, 'delta', { text }),
    done: (done) => writeFrame(raw, 'done', done),
    error: (payload) => writeFrame(raw, 'error', payload),
  };
}
