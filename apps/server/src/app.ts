import cors from '@fastify/cors';
import { ERROR_CODES, type ApiErrorBody } from '@bookr/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config';
import type { Database } from './db/client';
import { AppError } from './errors';
import type { JobQueue } from './jobs/types';
import type { StorageService } from './storage/types';

/** Source of the current time, injected so tests can control it. */
export interface Clock {
  now(): Date;
}

/** Generator for UUIDv7 primary keys. */
export interface IdGenerator {
  newId(): string;
}

/** Everything a request handler or background job needs. */
export interface AppDeps {
  config: AppConfig;
  db: Database;
  storage: StorageService;
  clock: Clock;
  ids: IdGenerator;
  jobs: JobQueue;
}

const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
  'password',
  'token',
  'refreshToken',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.*.password',
  '*.*.token',
  '*.*.refreshToken',
];

function validationErrorBody(error: ZodError): ApiErrorBody {
  return {
    error: {
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Request validation failed',
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    },
  };
}

/** Builds the Fastify application with all cross-cutting concerns configured. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const isTest = process.env.NODE_ENV === 'test';
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
      redact: {
        paths: LOG_REDACT_PATHS,
        censor: '[REDACTED]',
      },
    },
    genReqId: () => deps.ids.newId(),
  });

  app.register(cors, { origin: deps.config.corsOrigin });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(error.toBody());
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send(validationErrorBody(error));
      return;
    }
    // Log the error class only: messages from parsers may contain book text.
    const errorName = error instanceof Error ? error.name : 'unknown';
    request.log.error({ errorName }, 'unhandled request error');
    reply.status(500).send({
      error: {
        code: ERROR_CODES.INTERNAL,
        message: 'Internal server error',
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: 'Route not found',
      },
    });
  });

  return app;
}
