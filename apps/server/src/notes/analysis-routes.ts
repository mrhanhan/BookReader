import {
  ERROR_CODES,
  noteAnalysisRequestSchema,
  type NoteAnalysisDto,
  type NoteAnalysisSummaryDto,
} from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SSE_HEADERS } from '../ai/sse';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import type { NoteAnalysisRow } from '../db/schema';
import { AppError } from '../errors';
import { createAnalysisSink, executeNoteAnalysis, prepareNoteAnalysis } from './analysis';
import { deleteAnalysisRow, findAnalysisRow, listAnalysisRows } from './analysis-repo';

const analysisParamsSchema = z.object({ id: z.uuid() });
/** Maximum number of saved analyses returned by the list endpoint. */
const ANALYSIS_LIST_LIMIT = 20;
/** Filters are small; the explicit limit keeps a pathological body cheap. */
const ANALYSIS_BODY_LIMIT = 262_144;

function toSummaryDto(row: NoteAnalysisRow): NoteAnalysisSummaryDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    noteCount: row.noteCount,
    analyzedCount: row.analyzedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAnalysisDto(row: NoteAnalysisRow): NoteAnalysisDto {
  return {
    ...toSummaryDto(row),
    content: row.content,
    model: row.model,
    promptVersion: row.promptVersion,
    scope: row.scope,
  };
}

/** Registers the streaming analysis and its saved-result endpoints. */
export function registerNoteAnalysisRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);
  const auth = { preHandler: requireAuth };

  app.post(
    '/api/notes/analyses',
    { ...auth, bodyLimit: ANALYSIS_BODY_LIMIT },
    async (request, reply) => {
      const body = noteAnalysisRequestSchema.parse(request.body);
      const prepared = await prepareNoteAnalysis(deps, request.user!.id, body);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);

      const controller = new AbortController();
      let finished = false;
      raw.on('close', () => {
        if (!finished) controller.abort();
      });
      request.raw.on('aborted', () => {
        if (!finished) controller.abort();
      });

      try {
        await executeNoteAnalysis(
          deps,
          prepared,
          createAnalysisSink(raw, () => controller.abort()),
          controller.signal,
          request.log,
        );
      } finally {
        finished = true;
        if (!raw.writableEnded && !raw.destroyed) raw.end();
      }
      return reply;
    },
  );

  app.get('/api/notes/analyses', auth, async (request) => {
    const rows = await listAnalysisRows(deps.db, request.user!.id, ANALYSIS_LIST_LIMIT);
    return { items: rows.map(toSummaryDto) };
  });

  app.get('/api/notes/analyses/:id', auth, async (request) => {
    const { id } = analysisParamsSchema.parse(request.params);
    const row = await findAnalysisRow(deps.db, request.user!.id, id);
    if (!row) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    return { analysis: toAnalysisDto(row) };
  });

  app.delete('/api/notes/analyses/:id', auth, async (request, reply) => {
    const { id } = analysisParamsSchema.parse(request.params);
    const deleted = await deleteAnalysisRow(deps.db, request.user!.id, id);
    if (!deleted) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    return reply.status(204).send();
  });
}
