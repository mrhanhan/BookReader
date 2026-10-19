import {
  ERROR_CODES,
  loginSchema,
  refreshSchema,
  registerSchema,
  updateProfileSchema,
  type MeDto,
  type ProfileUpdateDto,
} from '@bookr/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps, Clock } from '../app';
import { books, uploadSessions, users } from '../db/schema';
import { AppError } from '../errors';
import { rebuildDailyStatsInTransaction } from '../stats/aggregate';
import { lockUserChanges } from '../sync/repo';
import { deviceInfoOf } from './device';
import { makeRequireAuth } from './guards';
import { loginUser, logoutSession, refreshSession, registerUser } from './service';

/** Fixed window in which failed logins are counted. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** How often expired failure entries are swept. */
const RATE_LIMIT_SWEEP_MS = 60_000;

/** Hard cap on tracked keys so a spray of usernames cannot exhaust memory. */
const RATE_LIMIT_MAX_ENTRIES = 10_000;

interface FailureWindow {
  count: number;
  resetAt: number;
}

/** Counts failed logins per `${ip}:${username}` in this single server process. */
class LoginRateLimiter {
  private readonly failures = new Map<string, FailureWindow>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly clock: Clock,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), RATE_LIMIT_SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** Stops the sweep timer when the app closes. */
  dispose(): void {
    clearInterval(this.sweepTimer);
  }

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
    } else {
      entry.count += 1;
    }
    // Keep memory bounded between sweeps as well.
    if (this.failures.size > RATE_LIMIT_MAX_ENTRIES) {
      this.sweep();
    }
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  /** Drops expired entries, then the oldest insertion-order entries over the cap. */
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.failures) {
      if (entry.resetAt <= now) {
        this.failures.delete(key);
      }
    }
    this.evictOverflow();
  }

  private evictOverflow(): void {
    const overflow = this.failures.size - RATE_LIMIT_MAX_ENTRIES;
    if (overflow <= 0) {
      return;
    }
    let dropped = 0;
    for (const key of this.failures.keys()) {
      if (dropped >= overflow) {
        break;
      }
      this.failures.delete(key);
      dropped += 1;
    }
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}

function bytesOf(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** Registers every auth route on the application. */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new LoginRateLimiter(deps.config.loginRateLimit, deps.clock);
  app.addHook('onClose', () => {
    limiter.dispose();
  });

  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const device = deviceInfoOf(request);
    const tokens = await registerUser(deps, {
      ...input,
      deviceName: device.name,
      platform: device.platform,
    });
    return reply.status(201).send(tokens);
  });

  app.post('/api/auth/login', async (request) => {
    const input = loginSchema.parse(request.body);
    const key = `${request.ip}:${input.username}`;

    limiter.assertAllowed(key);
    try {
      const device = deviceInfoOf(request);
      const tokens = await loginUser(deps, input, device.name, device.platform);
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
    const { username, ...tokens } = await refreshSession(deps, input.refreshToken);
    // Clear only the caller's counter; one member must not be able to reset
    // another member's lockout.
    limiter.clear(`${request.ip}:${username}`);
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
    // Soft-deleted books keep their objects until the trash purge, so their
    // bytes still count against both quotas.
    const [bookUsage] = await deps.db
      .select({
        libraryUsed: sql<string>`coalesce(sum(${books.size}), 0)`,
        uploadUsed: sql<string>`coalesce(sum(case when ${books.uploadedBy} = ${userId} then ${books.size} else 0 end), 0)`,
      })
      .from(books);

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

  /**
   * Changes the statistics timezone. Daily aggregates are re-bucketed in the
   * new zone before the response, so the stats page never shows a day counted
   * in the previous zone.
   */
  app.patch(
    '/api/auth/me',
    { preHandler: makeRequireAuth(deps) },
    async (request): Promise<ProfileUpdateDto> => {
      const { timezone } = updateProfileSchema.parse(request.body);
      const userId = request.user!.id;
      // The timezone and its aggregates must switch together; the same per-user
      // lock serialises this against a concurrent sync session write.
      await deps.db.transaction(async (tx) => {
        await lockUserChanges(tx, userId);
        await tx.update(users).set({ timezone }).where(eq(users.id, userId));
        await rebuildDailyStatsInTransaction(tx, userId, timezone, deps.clock.now());
      });
      return { timezone };
    },
  );
}
