import { ERROR_CODES, loginSchema, refreshSchema, registerSchema, type MeDto } from '@bookr/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps, Clock } from '../app';
import { books, uploadSessions, users } from '../db/schema';
import { AppError } from '../errors';
import { makeRequireAuth } from './guards';
import { loginUser, logoutSession, refreshSession, registerUser } from './service';

/** Fixed window in which failed logins are counted. */
const RATE_LIMIT_WINDOW_MS = 60_000;

interface FailureWindow {
  count: number;
  resetAt: number;
}

/** Counts failed logins per `${ip}:${username}` in this single server process. */
class LoginRateLimiter {
  private readonly failures = new Map<string, FailureWindow>();

  constructor(
    private readonly limit: number,
    private readonly clock: Clock,
  ) {}

  /** Throws 429 once the window has reached the configured failure limit. */
  assertAllowed(key: string): void {
    const entry = this.failures.get(key);
    if (!entry) {
      return;
    }
    if (entry.resetAt <= this.now()) {
      this.failures.delete(key);
      return;
    }
    if (entry.count >= this.limit) {
      throw new AppError(429, ERROR_CODES.RATE_LIMITED);
    }
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  /** A successful refresh proves valid credentials, so all counters reset. */
  clearAll(): void {
    this.failures.clear();
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}

function deviceNameOf(request: FastifyRequest): string | undefined {
  const userAgent = request.headers['user-agent'];
  return typeof userAgent === 'string' ? userAgent.slice(0, 200) : undefined;
}

function bytesOf(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** Registers every auth route on the application. */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new LoginRateLimiter(deps.config.loginRateLimit, deps.clock);

  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const tokens = await registerUser(deps, {
      ...input,
      deviceName: deviceNameOf(request),
    });
    return reply.status(201).send(tokens);
  });

  app.post('/api/auth/login', async (request) => {
    const input = loginSchema.parse(request.body);
    const key = `${request.ip}:${input.username}`;

    limiter.assertAllowed(key);
    try {
      const tokens = await loginUser(deps, input, deviceNameOf(request));
      limiter.clear(key);
      return tokens;
    } catch (error) {
      // Only credential failures count towards the limit; 403 and server
      // errors must not lock an account out.
      if (error instanceof AppError && error.statusCode === 401) {
        limiter.recordFailure(key);
      }
      throw error;
    }
  });

  app.post('/api/auth/refresh', async (request) => {
    const input = refreshSchema.parse(request.body);
    const tokens = await refreshSession(deps, input.refreshToken);
    limiter.clearAll();
    return tokens;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    await logoutSession(deps, input.refreshToken);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: makeRequireAuth(deps) }, async (request): Promise<MeDto> => {
    const userId = request.user!.id;
    const [user] = await deps.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        timezone: users.timezone,
        aiEnabled: users.aiEnabled,
        uploadQuotaBytes: users.uploadQuotaBytes,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      // The account was removed between the guard and this query.
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED);
    }

    const now = deps.clock.now();
    const [bookUsage] = await deps.db
      .select({
        libraryUsed: sql<string>`coalesce(sum(${books.size}), 0)`,
        uploadUsed: sql<string>`coalesce(sum(case when ${books.uploadedBy} = ${userId} then ${books.size} else 0 end), 0)`,
      })
      .from(books)
      .where(isNull(books.deletedAt));

    const [sessionUsage] = await deps.db
      .select({
        libraryUsed: sql<string>`coalesce(sum(${uploadSessions.size}), 0)`,
        uploadUsed: sql<string>`coalesce(sum(case when ${uploadSessions.userId} = ${userId} then ${uploadSessions.size} else 0 end), 0)`,
      })
      .from(uploadSessions)
      .where(
        and(eq(uploadSessions.status, 'created'), gt(uploadSessions.expiresAt, now)),
      );

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      timezone: user.timezone,
      aiEnabled: user.aiEnabled,
      uploadUsedBytes: bytesOf(bookUsage?.uploadUsed) + bytesOf(sessionUsage?.uploadUsed),
      uploadQuotaBytes: user.uploadQuotaBytes,
      libraryUsedBytes: bytesOf(bookUsage?.libraryUsed) + bytesOf(sessionUsage?.libraryUsed),
      libraryQuotaBytes: deps.config.libraryQuotaBytes,
    };
  });
}
