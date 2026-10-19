import {
  DEFAULT_USER_TIMEZONE,
  type SystemSettingsDto,
  type UpdateSystemSettingsInput,
} from '@bookr/shared';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import type { Database, Transaction } from '../db/client';
import { auditLogs, systemSettings } from '../db/schema';

/** The settings table holds at most one row, always under this key. */
export const SYSTEM_SETTINGS_ID = 'global';

/** Values used until an administrator saves the settings row. */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsDto = {
  registrationEnabled: true,
  defaultTimezone: DEFAULT_USER_TIMEZONE,
  updatedAt: null,
};

/** Settings as stored, with the raw timestamp so callers can format it. */
export interface StoredSystemSettings {
  registrationEnabled: boolean;
  defaultTimezone: string;
  updatedAt: Date | null;
}

/**
 * Reads the singleton settings row. A missing row means defaults; nothing is
 * written, so a read-only endpoint never mutates the database.
 */
export async function readSystemSettings(db: Database | Transaction): Promise<StoredSystemSettings> {
  const [row] = await db
    .select({
      registrationEnabled: systemSettings.registrationEnabled,
      defaultTimezone: systemSettings.defaultTimezone,
      updatedAt: systemSettings.updatedAt,
    })
    .from(systemSettings)
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID))
    .limit(1);

  if (!row) {
    return {
      registrationEnabled: DEFAULT_SYSTEM_SETTINGS.registrationEnabled,
      defaultTimezone: DEFAULT_SYSTEM_SETTINGS.defaultTimezone,
      updatedAt: null,
    };
  }
  return row;
}

/**
 * Upserts the singleton row and records the change in the audit log. Both
 * writes share one transaction so the trail never disagrees with the state.
 */
export async function updateSystemSettings(
  deps: AppDeps,
  adminId: string,
  patch: UpdateSystemSettingsInput,
): Promise<SystemSettingsDto> {
  const now = deps.clock.now();

  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(systemSettings)
      .values({
        id: SYSTEM_SETTINGS_ID,
        registrationEnabled: patch.registrationEnabled ?? DEFAULT_SYSTEM_SETTINGS.registrationEnabled,
        defaultTimezone: patch.defaultTimezone ?? DEFAULT_SYSTEM_SETTINGS.defaultTimezone,
        updatedAt: now,
        updatedBy: adminId,
      })
      .onConflictDoUpdate({
        target: systemSettings.id,
        set: {
          ...(patch.registrationEnabled !== undefined
            ? { registrationEnabled: patch.registrationEnabled }
            : {}),
          ...(patch.defaultTimezone !== undefined
            ? { defaultTimezone: patch.defaultTimezone }
            : {}),
          updatedAt: now,
          updatedBy: adminId,
        },
      })
      .returning({
        registrationEnabled: systemSettings.registrationEnabled,
        defaultTimezone: systemSettings.defaultTimezone,
        updatedAt: systemSettings.updatedAt,
      });
    if (!row) {
      throw new Error('System settings upsert returned no row');
    }

    await tx.insert(auditLogs).values({
      userId: adminId,
      action: 'admin.settings.update',
      metadata: { changes: patch },
    });

    return { ...row, updatedAt: row.updatedAt.toISOString() };
  });
}
