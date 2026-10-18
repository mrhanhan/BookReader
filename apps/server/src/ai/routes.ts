import { aiChatRequestSchema } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { createReplySink, executeChat, prepareChat } from './chat';
import {
  getAiUsage,
  getThreadDetail,
  listThreads,
  removeThread,
  setAiEnabled,
} from './service';

const bookParamsSchema = z.object({ id: z.uuid() });
const threadParamsSchema = z.object({ id: z.uuid() });
const aiToggleSchema = z.object({ enabled: z.boolean() });

/** Streaming responses must not be buffered by proxies or browsers. */
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

/** Registers the caller-scoped AI thread, usage and preference endpoints. */
export function registerAiRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);
  const auth = { preHandler: requireAuth };

  app.get('/api/books/:id/ai/threads', auth, async (request) => {
    const { id } = bookParamsSchema.parse(request.params);
    return { items: await listThreads(deps, request.user!.id, id) };
  });

  app.get('/api/ai/threads/:id', auth, async (request) => {
    const { id } = threadParamsSchema.parse(request.params);
    return getThreadDetail(deps, request.user!.id, id);
  });

  app.delete('/api/ai/threads/:id', auth, async (request, reply) => {
    const { id } = threadParamsSchema.parse(request.params);
    await removeThread(deps, request.user!.id, id);
    return reply.status(204).send();
  });

  app.get('/api/ai/usage', auth, async (request) => {
    return getAiUsage(deps, request.user!.id);
  });

  app.patch('/api/me/ai', auth, async (request) => {
    const { enabled } = aiToggleSchema.parse(request.body);
    return { enabled: await setAiEnabled(deps, request.user!.id, enabled) };
  });

  // The body may carry up to 60k characters of chapter context; Fastify's
  // 1 MiB default is enough, but the limit is explicit so a future change to
  // the global default cannot silently truncate a legitimate request.
  app.post(
    '/api/books/:id/ai/chat',
    { ...auth, bodyLimit: 1_048_576 },
    async (request, reply) => {
      const { id } = bookParamsSchema.parse(request.params);
      const body = aiChatRequestSchema.parse(request.body);
      const prepared = await prepareChat(deps, request.user!.id, id, body);

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
        await executeChat(
          deps,
          prepared,
          createReplySink(raw, () => controller.abort()),
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
}
