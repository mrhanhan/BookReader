import { ERROR_CODES, type AuthTokens } from '@bookr/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { auditLogs, devices, invites, users } from '../db/schema';
import { AppError } from '../errors';
import { getLibrary } from '../library/service';
import { readSystemSettings } from '../settings/service';
import { hashPassword, verifyPassword } from './password';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
  newRefreshToken,
  signAccessToken,
} from './tokens';

/** Input accepted when redeeming an invite. */
export interface RegisterInput {
  inviteCode: string;
  username: string;
  password: string;
  displayName: string;
  deviceName?: string;
  platform?: string;
}

/** Input accepted when logging in. */
export interface LoginInput {
  username: string;
  password: string;
}

/** Input accepted when bootstrapping the first administrator. */
export interface CreateAdminInput {
  username: string;
  password: string;
  displayName: string;
}

/**
 * Rotated tokens plus the session owner. Routes use the username to clear only
 * that user's rate-limit key and strip it before sending the response.
 */
export interface RefreshedSession extends AuthTokens {
  username: string;
}

/** Serialises concurrent admin bootstraps so only one account can be created. */
const CREATE_ADMIN_LOCK_ID = 741_852_964;

type InviteRow = typeof invites.$inferSelect;

function inviteIsUsable(invite: InviteRow | undefined, now: Date): invite is InviteRow {
  return (
    invite !== undefined &&
    invite.usedAt === null &&
    invite.revokedAt === null &&
    invite.expiresAt.getTime() > now.getTime()
  );
}

function tokensFor(accessToken: string, refreshToken: string): AuthTokens {
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

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

/**
 * Redeems an invite in a single transaction: locks the invite, validates it,
 * creates a member and their device, then marks the invite used. Any failure
 * rolls back all three writes.
 */
export async function registerUser(deps: AppDeps, input: RegisterInput): Promise<AuthTokens> {
  // Reject obviously bad codes before paying for Argon2, which keeps bogus
  // registrations from burning CPU. The transaction below still re-validates
  // under lock, so this check is only an optimisation.
  const [preview] = await deps.db
    .select()
    .from(invites)
    .where(eq(invites.code, input.inviteCode))
    .limit(1);
  if (!inviteIsUsable(preview, deps.clock.now())) {
    throw new AppError(400, ERROR_CODES.INVITE_INVALID);
  }

  // Hashing before the transaction keeps the invite row lock short.
  const passwordHash = await hashPassword(input.password);
  const refresh = newRefreshToken();

  const session = await deps.db.transaction(async (tx) => {
    // The registration toggle is read inside the same transaction that locks
    // and consumes the invite, so a concurrent "close registration" request
    // cannot slip a new account in between the check and the insert.
    const settings = await readSystemSettings(tx);
    if (!settings.registrationEnabled) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, undefined, '注册暂未开放');
    }

    const [invite] = await tx
      .select()
      .from(invites)
      .where(eq(invites.code, input.inviteCode))
      .for('update');

    const now = deps.clock.now();
    if (!inviteIsUsable(invite, now)) {
      throw new AppError(400, ERROR_CODES.INVITE_INVALID);
    }

    let created: { id: string; username: string } | undefined;
    try {
      [created] = await tx
        .insert(users)
        .values({
          username: input.username,
          passwordHash,
          displayName: input.displayName,
          // The administrator's default timezone applies at signup; changing it
          // later never rewrites existing accounts.
          timezone: settings.defaultTimezone,
          // New registrations never choose their own role.
          role: 'member',
        })
        .returning({ id: users.id, username: users.username });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, ERROR_CODES.CONFLICT);
      }
      throw error;
    }
    if (!created) {
      throw new Error('User insert returned no row');
    }

    const [device] = await tx
      .insert(devices)
      .values({
        userId: created.id,
        name: input.deviceName ?? null,
        platform: input.platform ?? null,
        refreshTokenHash: refresh.hash,
        refreshExpiresAt: refresh.expiresAt,
        lastSeenAt: now,
      })
      .returning({ id: devices.id });
    if (!device) {
      throw new Error('Device insert returned no row');
    }
    await tx
      .update(invites)
      .set({ usedBy: created.id, usedAt: now })
      .where(eq(invites.code, invite.code));
    await tx.insert(auditLogs).values({
      userId: created.id,
      action: 'auth.register',
      target: created.id,
      metadata: { username: created.username },
    });

    return { userId: created.id, deviceId: device.id };
  });

  const accessToken = await signAccessToken(
    { sub: session.userId, role: 'member', deviceId: session.deviceId },
    deps.config.jwtSecret,
  );
  return tokensFor(accessToken, refresh.token);
}

/**
 * Verifies credentials and starts a new device session. Unknown usernames and
 * wrong passwords both yield 401 so the response cannot enumerate accounts.
 */
export async function loginUser(
  deps: AppDeps,
  input: LoginInput,
  deviceName?: string,
  platform?: string,
): Promise<AuthTokens> {
  const [user] = await deps.db
    .select({
      id: users.id,
      username: users.username,
      passwordHash: users.passwordHash,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);

  const passwordMatches = user ? await verifyPassword(user.passwordHash, input.password) : false;
  if (!user || !passwordMatches) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED);
  }
  if (!user.isActive) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN);
  }

  const refresh = newRefreshToken();
  const now = deps.clock.now();
  const [device] = await deps.db
    .insert(devices)
    .values({
      userId: user.id,
      name: deviceName ?? null,
      platform: platform ?? null,
      refreshTokenHash: refresh.hash,
      refreshExpiresAt: refresh.expiresAt,
      lastSeenAt: now,
    })
    .returning({ id: devices.id });
  if (!device) {
    throw new Error('Device insert returned no row');
  }
  await deps.db.insert(auditLogs).values({
    userId: user.id,
    action: 'auth.login',
    target: user.id,
    metadata: { username: user.username },
  });

  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role, deviceId: device.id },
    deps.config.jwtSecret,
  );
  return tokensFor(accessToken, refresh.token);
}

/**
 * Rotates a refresh token. The update is conditional on the old hash, so two
 * concurrent uses of the same token cannot both succeed.
 */
export async function refreshSession(
  deps: AppDeps,
  refreshToken: string,
): Promise<RefreshedSession> {
  const oldHash = hashRefreshToken(refreshToken);
  const now = deps.clock.now();

  const [session] = await deps.db
    .select({
      deviceId: devices.id,
      userId: users.id,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
    })
    .from(devices)
    .innerJoin(users, eq(devices.userId, users.id))
    .where(
      and(
        eq(devices.refreshTokenHash, oldHash),
        isNull(devices.revokedAt),
        gt(devices.refreshExpiresAt, now),
      ),
    )
    .limit(1);

  if (!session || !session.isActive) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED);
  }

  const next = newRefreshToken();
  const [rotated] = await deps.db
    .update(devices)
    .set({
      refreshTokenHash: next.hash,
      refreshExpiresAt: next.expiresAt,
      lastSeenAt: now,
    })
    .where(and(eq(devices.id, session.deviceId), eq(devices.refreshTokenHash, oldHash)))
    .returning({ id: devices.id });

  if (!rotated) {
    // Another request rotated this token first; treat it as a replay.
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED);
  }

  await deps.db.insert(auditLogs).values({
    userId: session.userId,
    action: 'auth.refresh',
    target: session.deviceId,
    metadata: { username: session.username },
  });

  const accessToken = await signAccessToken(
    { sub: session.userId, role: session.role, deviceId: session.deviceId },
    deps.config.jwtSecret,
  );
  return { ...tokensFor(accessToken, next.token), username: session.username };
}

/** Revokes the device session owning a refresh token. Unknown tokens are a no-op. */
export async function logoutSession(deps: AppDeps, refreshToken: string): Promise<void> {
  const hash = hashRefreshToken(refreshToken);
  const [device] = await deps.db
    .update(devices)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(devices.refreshTokenHash, hash), isNull(devices.revokedAt)))
    .returning({ id: devices.id, userId: devices.userId });

  if (!device) {
    return;
  }
  await deps.db.insert(auditLogs).values({
    userId: device.userId,
    action: 'auth.logout',
    target: device.id,
  });
}

/**
 * Creates the first administrator. Refuses once any user exists, because
 * administrators are expected to create later members through invites.
 * The shared library is created first so a successful bootstrap leaves a
 * usable shelf behind.
 */
export async function createAdmin(
  deps: AppDeps,
  input: CreateAdminInput,
): Promise<{ userId: string }> {
  await getLibrary(deps);
  const passwordHash = await hashPassword(input.password);

  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CREATE_ADMIN_LOCK_ID})`);

    const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing) {
      throw new AppError(409, ERROR_CODES.CONFLICT, undefined, 'An administrator already exists');
    }

    try {
      const [created] = await tx
        .insert(users)
        .values({
          username: input.username,
          passwordHash,
          displayName: input.displayName,
          role: 'admin',
        })
        .returning({ id: users.id });
      if (!created) {
        throw new Error('Admin insert returned no row');
      }
      return { userId: created.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, ERROR_CODES.CONFLICT);
      }
      throw error;
    }
  });
}
