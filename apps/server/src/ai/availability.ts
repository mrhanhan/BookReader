import { ERROR_CODES } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { users } from '../db/schema';
import { AppError } from '../errors';
import { readAiConfig, type AiRuntimeConfig } from './config';
import type { QuotaLimits } from './quota';

/** The caller's AI identity, timezone and quota ceilings. */
export interface AiActor {
  userId: string;
  timezone: string;
  limits: QuotaLimits;
}

/**
 * Loads the caller's AI availability settings. A missing account is a 404 and
 * an account with AI switched off is a 403; both are JSON errors before any
 * stream is opened.
 */
export async function requireAiActor(deps: AppDeps, userId: string): Promise<AiActor> {
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

  return {
    userId,
    timezone: user.timezone,
    limits: { daily: user.dailyLimit, monthly: user.monthlyLimit },
  };
}

/** Reads the provider configuration, reporting 503 while it is missing. */
export async function requireAiConfig(deps: AppDeps): Promise<AiRuntimeConfig> {
  const config = await readAiConfig(deps);
  if (!config) {
    throw new AppError(503, ERROR_CODES.AI_NOT_CONFIGURED, { reason: 'missing_config' });
  }
  return config;
}
