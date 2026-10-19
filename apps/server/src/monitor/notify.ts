import type { AppDeps } from '../app';
import {
  insertAlertEvent,
  readMonitorState,
  upsertMonitorState,
} from '../backup/repo';

/** Conditions the background monitor can raise. */
export type AlertKey = 'backup-stale' | 'backup-pc-silent' | 'disk-low' | 'backup-failure';

/** One alertable observation, independent of delivery state. */
export interface AlertCondition {
  key: AlertKey;
  severity: 'warning' | 'critical';
  message: string;
}

/** A continuous incident reminds at most once per this window. */
export const ALERT_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Webhook receivers must answer quickly; the monitor loop cannot block. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Posts one alert to the configured webhook. Only a 2xx response counts as
 * success. Thrown errors deliberately carry no response body, because a
 * receiver's error page is outside our control.
 */
export async function postAlertWebhook(
  url: string,
  condition: AlertCondition,
  at: Date,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'bookr',
      key: condition.key,
      severity: condition.severity,
      message: condition.message,
      at: at.toISOString(),
    }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  if (!response.ok) {
    const error = new Error(`webhook responded with status ${response.status}`);
    error.name = 'WebhookHttpError';
    throw error;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Runs the alert state machine for one condition that is currently true.
 *
 * - Outside an incident (inactive, or the repeat window elapsed) it delivers,
 *   records the attempt, and marks the condition active.
 * - Inside the window it does nothing, so a lasting incident only alerts once.
 * - A failed delivery records `status='failed'` but leaves the condition
 *   inactive, so the next tick retries instead of waiting a full day.
 * - Without a webhook it still tracks state and never writes alert rows.
 *
 * All failures are swallowed: callers include request handlers and the
 * fire-and-forget alert raised by a failed heartbeat.
 */
export async function notifyConditionOnce(
  deps: AppDeps,
  condition: AlertCondition,
  now: Date,
): Promise<'sent' | 'skipped' | 'failed' | 'no-webhook'> {
  try {
    const state = await readMonitorState(deps.db, condition.key);
    const withinWindow =
      state?.active === true &&
      state.lastAlertAt !== null &&
      now.getTime() - state.lastAlertAt.getTime() < ALERT_REPEAT_WINDOW_MS;
    if (withinWindow) {
      return 'skipped';
    }

    const webhookUrl = deps.config.alerts.webhookUrl;
    if (webhookUrl === null) {
      // Track that the incident is open, but leave `lastAlertAt` alone: no
      // delivery happened, so configuring a webhook later should alert now
      // rather than waiting out a window that never started.
      await upsertMonitorState(deps.db, {
        key: condition.key,
        active: true,
        updatedAt: now,
      });
      return 'no-webhook';
    }

    try {
      await postAlertWebhook(webhookUrl, condition, now);
    } catch (error) {
      await insertAlertEvent(deps.db, {
        key: condition.key,
        severity: condition.severity,
        message: condition.message,
        status: 'failed',
        error: errorName(error),
        sentAt: now,
      });
      // Keep the condition re-armed: a failed delivery must be retried on the
      // next tick rather than suppressed for a day.
      await upsertMonitorState(deps.db, {
        key: condition.key,
        active: false,
        updatedAt: now,
      });
      return 'failed';
    }

    await insertAlertEvent(deps.db, {
      key: condition.key,
      severity: condition.severity,
      message: condition.message,
      status: 'sent',
      error: null,
      sentAt: now,
    });
    await upsertMonitorState(deps.db, {
      key: condition.key,
      active: true,
      lastAlertAt: now,
      updatedAt: now,
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}
