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
import type { ServerResponse } from 'node:http';
import type { AppDeps } from '../app';
import { aiThreads, books } from '../db/schema';
import { AppError } from '../errors';
import { requireAiActor, requireAiConfig } from './availability';
import { assemblePrompt, estimateTokens } from './context';
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
  type QuotaSnapshot,
} from './quota';
import { writeSseFrame } from './sse';
import type { AiChatMessage, AiClient, AiTokenUsage } from './types';

/** Provider failure copy shown to the reader; upstream text never leaks. */
const UPSTREAM_MESSAGE = 'AI 服务暂时不可用，请稍后重试';
const TIMEOUT_MESSAGE = 'AI 响应超时，请重试';
const MAX_HISTORY_MESSAGES = 200;

/** Everything resolved before the response switches to SSE. */
export interface PreparedChat {
  userId: string;
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

/** Structured logger; only token counts and error names are ever logged. */
export interface ChatLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
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
  // Keep the excerpt short before adding the prefix so the title stays readable.
  return `${prefix}${source.slice(0, 40)}`.slice(0, AI_THREAD_TITLE_MAX_LENGTH);
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
  const actor = await requireAiActor(deps, userId);
  const aiConfig = await requireAiConfig(deps);

  const [book] = await deps.db
    .select({ id: books.id, title: books.title, author: books.author })
    .from(books)
    .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
    .limit(1);
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  let thread = body.threadId ? await findThreadRow(deps.db, userId, body.threadId) : undefined;
  if (body.threadId && (!thread || thread.bookId !== book.id)) {
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

  const limits: QuotaLimits = actor.limits;
  const now = deps.clock.now();
  const reservation = await reserveQuota(deps.db, {
    userId,
    timezone: actor.timezone,
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
        selectedText: body.selectedText ?? null,
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
      userId,
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
      timezone: actor.timezone,
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

/** Fixed user-facing copy for a provider failure; upstream text never leaks. */
export function failurePayload(error: unknown): AiStreamErrorPayload {
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
  logger?: ChatLogger,
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
  let quotaDone = false;
  let messageDone = false;
  let quotaSnapshot: QuotaSnapshot | null = null;
  let aborted = false;
  let errorName: string | null = null;

  const actualUsage = (): AiTokenUsage =>
    usage ?? {
      promptTokens: prepared.promptTokens,
      completionTokens: estimateTokens(answer),
    };

  // Settlement is split into two independently retryable halves: a failed
  // message update must not charge the provider usage a second time.
  const settle = async (
    status: AiMessageStatus,
    actual: AiTokenUsage,
  ): Promise<AiStreamDone | null> => {
    if (!quotaDone) {
      quotaSnapshot = await settleQuota(
        deps.db,
        prepared.reservation,
        actual,
        deps.clock.now(),
      );
      quotaDone = true;
    }
    if (!messageDone) {
      await deps.db.transaction(async (tx) => {
        await updateMessage(tx, prepared.assistantMessageId, {
          content: answer,
          status,
          promptTokens: actual.promptTokens,
          completionTokens: actual.completionTokens,
        }, deps.clock.now());
      });
      messageDone = true;
    }
    if (!quotaSnapshot) return null;
    return {
      assistantMessageId: prepared.assistantMessageId,
      usage: actual,
      quota: { daily: quotaSnapshot.daily, monthly: quotaSnapshot.monthly },
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

    const done = await settle('complete', actualUsage());
    if (done) await sink.done(done);
  } catch (error) {
    aborted = signal.aborted || isAbort(error);
    errorName = error instanceof Error ? error.name : typeof error;
    const actual = actualUsage();
    try {
      const done = await settle(aborted ? 'interrupted' : 'failed', actual);
      if (!aborted && done) {
        await sink.error(failurePayload(error)).catch(() => undefined);
      }
    } catch (settleError) {
      errorName = settleError instanceof Error ? settleError.name : errorName;
      logger?.error(
        {
          userId: prepared.userId,
          threadId: prepared.threadId,
          action: prepared.action,
          errorName,
        },
        'AI chat settlement failed',
      );
    }
  } finally {
    const finalUsage = actualUsage();
    logger?.info(
      {
        userId: prepared.userId,
        threadId: prepared.threadId,
        action: prepared.action,
        promptTokens: finalUsage.promptTokens,
        completionTokens: finalUsage.completionTokens,
        aborted,
        errorName,
      },
      'AI chat finished',
    );
  }
}

/** Builds the SSE sink for a hijacked response; backpressure aborts upstream. */
export function createReplySink(raw: ServerResponse, onBackpressure?: () => void): ChatSink {
  return {
    meta: (meta) => writeSseFrame(raw, 'meta', meta, onBackpressure),
    delta: (text) => writeSseFrame(raw, 'delta', { text }, onBackpressure),
    done: (done) => writeSseFrame(raw, 'done', done, onBackpressure),
    error: (payload) => writeSseFrame(raw, 'error', payload, onBackpressure),
  };
}
