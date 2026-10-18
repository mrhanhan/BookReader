import { ERROR_CODES, type Role } from '@bookr/shared';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import type { AppDeps } from '../app';
import { hashPassword } from '../auth/password';
import { auditLogs, books, devices, invites, uploadSessions, users } from '../db/schema';
import { AppError } from '../errors';

/** Unambiguous invite alphabet: no 0/1/I/L/O to survive being read aloud. */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Every invite code is this long. */
const INVITE_CODE_LENGTH = 10;

/** Collisions are astronomically unlikely, but a retry keeps them harmless. */
const INVITE_CODE_ATTEMPTS = 5;

/** Invites live three days unless the administrator asks otherwise. */
export const DEFAULT_INVITE_HOURS = 72;

/** Upper bound for a requested invite lifetime. */
export const MAX_INVITE_HOURS = 720;

const HOUR_MS = 60 * 60 * 1000;

/** A member as shown in the administration screens. */
export interface MemberSummary {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  uploadQuotaBytes: number;
  aiEnabled: boolean;
  aiDailyTokenLimit: number;
  aiMonthlyTokenLimit: number;
  usedBytes: number;
  createdAt: string;
}

/** An invite code and when it stops working. */
export interface CreatedInvite {
  code: string;
  expiresAt: string;
}

/** An invite as shown in the administration screens. */
export interface InviteSummary {
  code: string;
  expiresAt: string;
  usedBy: string | null;
  revokedAt: string | null;
}

/** Body accepted by `updateMember`; all fields are optional. */
export interface UpdateMemberInput {
  isActive?: boolean;
  uploadQuotaBytes?: number;
  aiEnabled?: boolean;
  aiDailyTokenLimit?: number;
  aiMonthlyTokenLimit?: number;
  password?: string;
}

/** Storage totals for the administration screen. */
export interface StorageOverview {
  totalBytes: number;
  usedBytes: number;
  perMember: Array<{ userId: string; displayName: string; usedBytes: number }>;
}

const MEMBER_COLUMNS = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  isActive: users.isActive,
  uploadQuotaBytes: users.uploadQuotaBytes,
  aiEnabled: users.aiEnabled,
  aiDailyTokenLimit: users.aiDailyTokenLimit,
  aiMonthlyTokenLimit: users.aiMonthlyTokenLimit,
  createdAt: users.createdAt,
};

/** True when the error (or a wrapped cause) is a Postgres unique violation. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Postgres returns bigint sums as strings; the API exposes safe integers. */
function numberOf(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** Generates one code from the unambiguous alphabet. */
function newInviteCode(): string {
  let code = '';
  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    code += INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length));
  }
  return code;
}

/**
 * Bytes consumed by each user: every book they uploaded, including ones in the
 * trash (their objects remain until the 30-day purge), plus upload sessions
 * that are still in progress (completed sessions became books).
 */
async function usageByUser(deps: AppDeps): Promise<Map<string, number>> {
  const now = deps.clock.now();
  const [bookRows, sessionRows] = await Promise.all([
    deps.db
      .select({
        userId: books.uploadedBy,
        used: sql<string>`coalesce(sum(${books.size}), 0)`,
      })
      .from(books)
      .groupBy(books.uploadedBy),
    deps.db
      .select({
        userId: uploadSessions.userId,
        used: sql<string>`coalesce(sum(${uploadSessions.size}), 0)`,
      })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.status, 'created'), gt(uploadSessions.expiresAt, now)))
      .groupBy(uploadSessions.userId),
  ]);

  const usage = new Map<string, number>();
  for (const row of [...bookRows, ...sessionRows]) {
    usage.set(row.userId, (usage.get(row.userId) ?? 0) + numberOf(row.used));
  }
  return usage;
}

/** Reads usage for a single user; used when returning one member. */
async function usedBytesForUser(deps: AppDeps, userId: string): Promise<number> {
  const now = deps.clock.now();
  const [[bookRow], [sessionRow]] = await Promise.all([
    deps.db
      .select({ used: sql<string>`coalesce(sum(${books.size}), 0)` })
      .from(books)
      .where(eq(books.uploadedBy, userId)),
    deps.db
      .select({ used: sql<string>`coalesce(sum(${uploadSessions.size}), 0)` })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.userId, userId),
          eq(uploadSessions.status, 'created'),
          gt(uploadSessions.expiresAt, now),
        ),
      ),
  ]);
  return numberOf(bookRow?.used) + numberOf(sessionRow?.used);
}

/** Lists every account with its current upload usage. */
export async function listMembers(deps: AppDeps): Promise<MemberSummary[]> {
  const [rows, usage] = await Promise.all([
    deps.db.select(MEMBER_COLUMNS).from(users).orderBy(users.createdAt),
    usageByUser(deps),
  ]);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    usedBytes: usage.get(row.id) ?? 0,
  }));
}

/**
 * Applies an administrator edit. Disabling an account or replacing its
 * password revokes every device session in the same transaction, so existing
 * access and refresh tokens stop working immediately.
 */
export async function updateMember(
  deps: AppDeps,
  actorId: string,
  memberId: string,
  input: UpdateMemberInput,
): Promise<MemberSummary> {
  const now = deps.clock.now();
  const patch: Partial<typeof users.$inferInsert> = { updatedAt: now };
  if (input.isActive !== undefined) {
    patch.isActive = input.isActive;
  }
  if (input.uploadQuotaBytes !== undefined) {
    patch.uploadQuotaBytes = input.uploadQuotaBytes;
  }
  if (input.aiEnabled !== undefined) {
    patch.aiEnabled = input.aiEnabled;
  }
  if (input.aiDailyTokenLimit !== undefined) {
    patch.aiDailyTokenLimit = input.aiDailyTokenLimit;
  }
  if (input.aiMonthlyTokenLimit !== undefined) {
    patch.aiMonthlyTokenLimit = input.aiMonthlyTokenLimit;
  }
  if (input.password !== undefined) {
    patch.passwordHash = await hashPassword(input.password);
  }
  const revokeDevices = input.isActive === false || input.password !== undefined;

  const updated = await deps.db.transaction(async (tx) => {
    // Administrators are the only accounts that can restore access, so the
    // shelf must never be left without an active one. Self-deactivation is
    // checked too: it is the only way to reach the last-admin branch, because
    // any other caller is itself an active administrator.
    if (input.isActive === false) {
      // Two administrators can deactivate each other at the same time; without
      // a lock both count the other as active and the shelf loses every admin.
      // The transaction-scoped advisory lock serialises the count and update.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin_deactivation'))`);

      const [target] = await tx
        .select({ role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, memberId))
        .limit(1);

      if (target?.isActive && target.role === 'admin') {
        const [others] = await tx
          .select({ count: sql<string>`count(*)` })
          .from(users)
          .where(
            and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, memberId)),
          );
        if (numberOf(others?.count) === 0) {
          throw new AppError(
            409,
            ERROR_CODES.CONFLICT,
            undefined,
            'The last active administrator cannot be deactivated',
          );
        }
      }

      if (memberId === actorId) {
        throw new AppError(
          409,
          ERROR_CODES.CONFLICT,
          undefined,
          'You cannot deactivate your own account',
        );
      }
    }

    const [row] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, memberId))
      .returning(MEMBER_COLUMNS);
    if (!row) {
      return undefined;
    }

    if (revokeDevices) {
      await tx
        .update(devices)
        .set({ revokedAt: now })
        .where(and(eq(devices.userId, memberId), isNull(devices.revokedAt)));
    }

    // Audit entries record the field names and their new values so the change
    // can be reviewed later; passwords never enter this metadata.
    const changes: Record<string, unknown> = {};
    if (input.isActive !== undefined) {
      changes.isActive = input.isActive;
    }
    if (input.uploadQuotaBytes !== undefined) {
      changes.uploadQuotaBytes = input.uploadQuotaBytes;
    }
    if (input.aiEnabled !== undefined) {
      changes.aiEnabled = input.aiEnabled;
    }
    if (input.aiDailyTokenLimit !== undefined) {
      changes.aiDailyTokenLimit = input.aiDailyTokenLimit;
    }
    if (input.aiMonthlyTokenLimit !== undefined) {
      changes.aiMonthlyTokenLimit = input.aiMonthlyTokenLimit;
    }
    if (Object.keys(changes).length > 0) {
      await tx.insert(auditLogs).values({
        userId: actorId,
        action: 'admin.member.update',
        target: memberId,
        metadata: changes,
      });
    }
    if (input.password !== undefined) {
      await tx.insert(auditLogs).values({
        userId: actorId,
        action: 'admin.member.password_reset',
        target: memberId,
      });
    }

    return row;
  });

  if (!updated) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  return {
    ...updated,
    createdAt: updated.createdAt.toISOString(),
    usedBytes: await usedBytesForUser(deps, memberId),
  };
}

/** Mints a unique invite code and records the administrator who made it. */
export async function createInvite(
  deps: AppDeps,
  actorId: string,
  expiresInHours: number = DEFAULT_INVITE_HOURS,
): Promise<CreatedInvite> {
  const expiresAt = new Date(deps.clock.now().getTime() + expiresInHours * HOUR_MS);

  for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS; attempt += 1) {
    const code = newInviteCode();
    try {
      await deps.db.transaction(async (tx) => {
        await tx.insert(invites).values({ code, createdBy: actorId, expiresAt });
        await tx.insert(auditLogs).values({
          userId: actorId,
          action: 'admin.invite.create',
          target: code,
        });
      });
      return { code, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // A duplicate primary key means another request used this code first.
    }
  }

  throw new AppError(
    500,
    ERROR_CODES.INTERNAL,
    undefined,
    'Could not allocate a unique invite code',
  );
}

/** Lists every invite, newest expiry first, including used and revoked ones. */
export async function listInvites(deps: AppDeps): Promise<InviteSummary[]> {
  const rows = await deps.db
    .select({
      code: invites.code,
      expiresAt: invites.expiresAt,
      usedBy: invites.usedBy,
      revokedAt: invites.revokedAt,
    })
    .from(invites)
    .orderBy(desc(invites.expiresAt));

  return rows.map((row) => ({
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

/** Marks an invite revoked; already-revoked codes remain a successful no-op. */
export async function revokeInvite(deps: AppDeps, actorId: string, code: string): Promise<void> {
  const now = deps.clock.now();

  await deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ code: invites.code })
      .from(invites)
      .where(eq(invites.code, code))
      .limit(1);
    if (!existing) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }

    const [revoked] = await tx
      .update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.code, code), isNull(invites.revokedAt)))
      .returning({ code: invites.code });

    if (revoked) {
      await tx.insert(auditLogs).values({
        userId: actorId,
        action: 'admin.invite.revoke',
        target: code,
      });
    }
  });
}

/** Total quota, live usage and the per-member breakdown for the admin screen. */
export async function storageOverview(deps: AppDeps): Promise<StorageOverview> {
  const [usage, members] = await Promise.all([
    usageByUser(deps),
    deps.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .orderBy(users.createdAt),
  ]);

  const perMember = members.map((member) => ({
    userId: member.id,
    displayName: member.displayName,
    usedBytes: usage.get(member.id) ?? 0,
  }));

  return {
    totalBytes: deps.config.libraryQuotaBytes,
    usedBytes: perMember.reduce((sum, member) => sum + member.usedBytes, 0),
    perMember,
  };
}
