import { noteFiltersSchema, noteListQuerySchema } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import {
  encodeContentDispositionFilename,
  notesExportAsciiFilename,
} from './export';
import { exportNotes, listNotes, listNoteTags } from './service';

/** Registers the cross-book notes library endpoints. */
export function registerNotesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.get('/api/notes', { preHandler: requireAuth }, async (request) => {
    const query = noteListQuerySchema.parse(request.query);
    return listNotes(deps, request.user!.id, query);
  });

  app.get('/api/notes/tags', { preHandler: requireAuth }, async (request) => {
    return { items: await listNoteTags(deps, request.user!.id) };
  });

  app.get('/api/notes/export', { preHandler: requireAuth }, async (request, reply) => {
    const filters = noteFiltersSchema.parse(request.query);
    const result = await exportNotes(deps, request.user!.id, filters);
    const disposition = [
      'attachment',
      `filename="${notesExportAsciiFilename(result.filename)}"`,
      `filename*=UTF-8''${encodeContentDispositionFilename(result.filename)}`,
    ].join('; ');
    return reply
      .type('text/markdown; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-disposition', disposition)
      .send(result.markdown);
  });
}
