import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@bookr/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { registerAdminRoutes } from './admin/routes';
import { registerAuthRoutes } from './auth/routes';
import type { Converter } from './books/conversion';
import { registerBookRoutes } from './books/routes';
import { COVER_MAX_BYTES } from './books/service';
import type { MetadataRunner } from './books/metadata-runner';
import { registerCategoryRoutes } from './categories/routes';
import type { AppConfig } from './config';
import type { Database } from './db/client';
import { registerDeviceRoutes } from './devices/routes';
import { AppError, defaultMessageFor } from './errors';
import type { JobQueue } from './jobs/types';
import { registerReadingRoutes } from './reading/routes';
import type { StorageService } from './storage/types';
import type { SyncHub } from './sync/hub';
import { registerSyncRoutes } from './sync/routes';
import { registerUploadRoutes } from './uploads/routes';

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
  /** Turns MOBI/AZW3 originals into EPUBs for the reader. */
  converter: Converter;
  /** Parses EPUB/PDF metadata, in-process in tests and isolated in production. */
  metadataRunner: MetadataRunner;
  /** Fans committed changes out to open sync streams. */
  syncHub: SyncHub;
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
  '*.authorization',
  '*.*.password',
  '*.*.token',
  '*.*.refreshToken',
];

const CLIENT_ERROR_CODES: Partial<Record<number, ErrorCode>> = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHORIZED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.VALIDATION_FAILED,
  415: ERROR_CODES.VALIDATION_FAILED,
  422: ERROR_CODES.VALIDATION_FAILED,
  429: ERROR_CODES.RATE_LIMITED,
};

function clientErrorCode(statusCode: number): ErrorCode {
  return CLIENT_ERROR_CODES[statusCode] ?? ERROR_CODES.VALIDATION_FAILED;
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Fastify 5.12 fails closed when `trustProxy` is a number, so express the hop
 * count as a predicate instead: trust exactly the first `hops` proxies. With
 * one hop this trusts only the immediate Caddy peer and reads the rightmost
 * `X-Forwarded-For` entry, which Caddy appends as the real client IP.
 */
function trustProxyOption(hops: number | false): false | ((address: string, hop: number) => boolean) {
  if (hops === false) {
    return false;
  }
  return (_address, hop) => hop < hops;
}

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

/** Optional hooks used by tests that need to observe request logging. */
export interface BuildAppOptions {
  /** Destination for request logs; enabling it turns logging on in tests. */
  logStream?: NodeJS.WritableStream;
  /** Overrides the sync stream ping/revalidation period; tests shorten it. */
  streamPingIntervalMs?: number;
}

/**
 * Removes every `token` query parameter from a URL before it is logged.
 * Parsing rather than pattern matching handles percent-encoded names such as
 * `%74oken=` and duplicate occurrences. Malformed request targets (Node passes
 * them through) must never reach the logger as exceptions or raw text.
 */
export function redactRequestUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    parsed.searchParams.delete('token');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '[unparseable-url]';
  }
}

/** Builds the Fastify application with all cross-cutting concerns configured. */
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const isTest = process.env.NODE_ENV === 'test';
  const app: FastifyInstance = Fastify({
    logger: {
      level:
        options.logStream !== undefined
          ? 'info'
          : (process.env.LOG_LEVEL ?? (isTest ? 'silent' : 'info')),
      redact: {
        paths: LOG_REDACT_PATHS,
        censor: '[REDACTED]',
      },
      serializers: {
        req: (request: FastifyRequest) => {
          const acceptVersion = request.raw.headers['accept-version'];
          return {
            method: request.method,
            url: redactRequestUrl(request.url),
            version: Array.isArray(acceptVersion) ? acceptVersion[0] : acceptVersion,
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.raw.socket.remotePort,
          };
        },
      },
      ...(options.logStream !== undefined ? { stream: options.logStream } : {}),
    },
    trustProxy: trustProxyOption(deps.config.trustProxy),
    genReqId: () => deps.ids.newId(),
  });

  app.register(cors, { origin: deps.config.corsOrigins });

  // Cover uploads accept a single image capped at 5 MiB; the service checks
  // the bytes themselves before anything is stored.
  app.register(multipart, { limits: { fileSize: COVER_MAX_BYTES, files: 1 } });

  app.get('/healthz', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerUploadRoutes(app, deps);
  registerBookRoutes(app, deps);
  registerReadingRoutes(app, deps);
  registerSyncRoutes(
    app,
    deps,
    options.streamPingIntervalMs !== undefined
      ? { pingIntervalMs: options.streamPingIntervalMs }
      : {},
  );
  registerDeviceRoutes(app, deps);
  registerCategoryRoutes(app, deps);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(error.toBody());
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send(validationErrorBody(error));
      return;
    }
    const statusCode = statusCodeOf(error);
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      // Fastify's own 4xx errors (bad JSON, payload too large, rate limit)
      // already carry a status; keep it and expose only a generic message.
      const code = clientErrorCode(statusCode);
      reply.status(statusCode).send({ error: { code, message: defaultMessageFor(code) } });
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
