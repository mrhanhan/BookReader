import {
  ERROR_CODES,
  NOTE_ANALYSIS_MAX_NOTES,
  type AiStreamErrorPayload,
  type NoteAnalysisKind,
  type NoteAnalysisStatus,
  type NoteAnalysisStreamDone,
  type NoteAnalysisStreamMeta,
  type NoteFilters,
} from '@bookr/shared';
import type { ServerResponse } from 'node:http';
import type { AppDeps } from '../app';
import { requireAiActor, requireAiConfig } from '../ai/availability';
import { failurePayload } from '../ai/chat';
import { estimateTokens } from '../ai/context';
import {
  releaseQuota,
  reserveQuota,
  settleQuota,
  type QuotaLimits,
  type QuotaReservation,
  type QuotaSnapshot,
} from '../ai/quota';
import { writeSseFrame } from '../ai/sse';
import type { AiChatMessage, AiClient, AiTokenUsage } from '../ai/types';
import { AppError } from '../errors';
import {
  analysisTitle,
  buildAnalysisPrompt,
  NOTE_ANALYSIS_MAX_OUTPUT_TOKENS,
  NOTE_ANALYSIS_PROMPT_VERSION,
  type AnalysisSourceNote,
} from './analysis-context';
import { insertAnalysis, updateAnalysis } from './analysis-repo';
import { listNotesForAnalysis, type NoteQueryRow } from './repo';

/** Everything resolved before the response switches to SSE. */
export interface PreparedNoteAnalysis {
  userId: string;
  analysisId: string;
  kind: NoteAnalysisKind;
  model: string;
  promptVersion: string;
  client: AiClient;
  messages: AiChatMessage[];
  promptTokens: number;
  reservation: QuotaReservation;
  timezone: string;
  limits: QuotaLimits;
  noteCount: number;
  analyzedCount: number;
}

/** SSE writer used by the route; methods resolve once the frame is flushed. */
export interface NoteAnalysisSink {
  meta(meta: NoteAnalysisStreamMeta): Promise<void>;
  delta(text: string): Promise<void>;
  done(done: NoteAnalysisStreamDone): Promise<void>;
  error(payload: AiStreamErrorPayload): Promise<void>;
}

/** Structured logger; only token counts and error names are ever logged. */
export interface NoteAnalysisLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function toSourceNote(row: NoteQueryRow): AnalysisSourceNote {
  return {
    bookTitle: row.book.title,
    bookAuthor: row.book.author,
    locator: row.annotation.locator,
    selectedText: row.annotation.selectedText,
    noteText: row.annotation.noteText,
    tags: row.annotation.tags ?? [],
    updatedAt: row.annotation.updatedAt,
  };
}

/** Names the analysis after the book when every included note shares one. */
function singleBookTitle(rows: NoteQueryRow[]): string | null {
  const bookIds = new Set(rows.map((row) => row.book.id));
  return bookIds.size === 1 ? rows[0]!.book.title : null;
}

/**
 * Validates availability, reads the caller's filtered notes, reserves quota and
 * writes the streaming placeholder. Every failure here is still a normal JSON
 * response; nothing has been written to the socket yet.
 */
export async function prepareNoteAnalysis(
  deps: AppDeps,
  userId: string,
  body: { kind: NoteAnalysisKind; filters?: NoteFilters },
): Promise<PreparedNoteAnalysis> {
  const actor = await requireAiActor(deps, userId);
  const aiConfig = await requireAiConfig(deps);
  // Build the client before holding quota or writing a row: a factory failure
  // must not leave a reservation or a streaming placeholder behind.
  const client = deps.aiClientFactory(aiConfig);

  const filters = body.filters ?? {};
  const { rows, total } = await listNotesForAnalysis(deps.db, {
    userId,
    timezone: actor.timezone,
    filters,
    limit: NOTE_ANALYSIS_MAX_NOTES,
  });
  if (total === 0) {
    // Nothing to summarize: reject before any quota is held.
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, { reason: 'no_notes' });
  }

  const prompt = buildAnalysisPrompt({
    kind: body.kind,
    notes: rows.map(toSourceNote),
    total,
    timezone: actor.timezone,
  });
  const title = analysisTitle(
    body.kind,
    singleBookTitle(rows.slice(0, prompt.analyzedCount)),
  );

  const now = deps.clock.now();
  const reservation = await reserveQuota(deps.db, {
    userId,
    timezone: actor.timezone,
    estimate: prompt.promptTokens + NOTE_ANALYSIS_MAX_OUTPUT_TOKENS,
    limits: actor.limits,
    now,
  });

  let analysisId: string;
  try {
    const row = await deps.db.transaction(async (tx) =>
      insertAnalysis(tx, {
        userId,
        kind: body.kind,
        title,
        scope: filters,
        noteCount: total,
        analyzedCount: prompt.analyzedCount,
        model: aiConfig.reasonerModel,
        promptVersion: NOTE_ANALYSIS_PROMPT_VERSION,
        now,
      }),
    );
    analysisId = row.id;
  } catch (error) {
    await releaseQuota(deps.db, reservation, now);
    throw error;
  }

  return {
    userId,
    analysisId,
    kind: body.kind,
    model: aiConfig.reasonerModel,
    promptVersion: NOTE_ANALYSIS_PROMPT_VERSION,
    client,
    messages: prompt.messages,
    promptTokens: prompt.promptTokens,
    reservation,
    timezone: actor.timezone,
    limits: actor.limits,
    noteCount: total,
    analyzedCount: prompt.analyzedCount,
  };
}

/**
 * Streams one prepared analysis to the sink and settles its quota exactly once.
 * A client disconnect keeps the partial content as `interrupted`; an upstream
 * failure keeps it as `failed` and reports a fixed user-facing copy.
 */
export async function executeNoteAnalysis(
  deps: AppDeps,
  prepared: PreparedNoteAnalysis,
  sink: NoteAnalysisSink,
  signal: AbortSignal,
  logger?: NoteAnalysisLogger,
): Promise<void> {
  const meta: NoteAnalysisStreamMeta = {
    analysisId: prepared.analysisId,
    kind: prepared.kind,
    model: prepared.model,
    promptVersion: prepared.promptVersion,
    noteCount: prepared.noteCount,
    analyzedCount: prepared.analyzedCount,
  };

  let answer = '';
  let usage: AiTokenUsage | null = null;
  let quotaDone = false;
  let rowDone = false;
  let quotaSnapshot: QuotaSnapshot | null = null;
  let aborted = false;
  let errorName: string | null = null;

  const actualUsage = (): AiTokenUsage =>
    usage ?? {
      promptTokens: prepared.promptTokens,
      completionTokens: estimateTokens(answer),
    };

  // Settlement is split into two independently retryable halves: a failed row
  // update must not charge the provider usage a second time.
  const settle = async (
    status: NoteAnalysisStatus,
    actual: AiTokenUsage,
  ): Promise<NoteAnalysisStreamDone | null> => {
    if (!quotaDone) {
      quotaSnapshot = await settleQuota(deps.db, prepared.reservation, actual, deps.clock.now());
      quotaDone = true;
    }
    if (!rowDone) {
      await deps.db.transaction(async (tx) => {
        await updateAnalysis(
          tx,
          prepared.analysisId,
          {
            content: answer,
            status,
            promptTokens: actual.promptTokens,
            completionTokens: actual.completionTokens,
          },
          deps.clock.now(),
        );
      });
      rowDone = true;
    }
    if (!quotaSnapshot) return null;
    return {
      analysisId: prepared.analysisId,
      usage: actual,
      quota: { daily: quotaSnapshot.daily, monthly: quotaSnapshot.monthly },
    };
  };

  try {
    await sink.meta(meta);
    for await (const event of prepared.client.streamChat({
      model: prepared.model,
      messages: prepared.messages,
      maxTokens: NOTE_ANALYSIS_MAX_OUTPUT_TOKENS,
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
          analysisId: prepared.analysisId,
          kind: prepared.kind,
          errorName,
        },
        'AI note analysis settlement failed',
      );
    }
  } finally {
    const finalUsage = actualUsage();
    logger?.info(
      {
        userId: prepared.userId,
        analysisId: prepared.analysisId,
        kind: prepared.kind,
        promptTokens: finalUsage.promptTokens,
        completionTokens: finalUsage.completionTokens,
        aborted,
        errorName,
      },
      'AI note analysis finished',
    );
  }
}

/** Builds the SSE sink for a hijacked response; backpressure aborts upstream. */
export function createAnalysisSink(
  raw: ServerResponse,
  onBackpressure?: () => void,
): NoteAnalysisSink {
  return {
    meta: (meta) => writeSseFrame(raw, 'meta', meta, onBackpressure),
    delta: (text) => writeSseFrame(raw, 'delta', { text }, onBackpressure),
    done: (done) => writeSseFrame(raw, 'done', done, onBackpressure),
    error: (payload) => writeSseFrame(raw, 'error', payload, onBackpressure),
  };
}
