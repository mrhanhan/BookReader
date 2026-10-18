import { ERROR_CODES, type Role } from '@bookr/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppDeps } from '../app';
import { devices, users } from '../db/schema';
import { AppError } from '../errors';
import { verifyAccessToken } from './tokens';

/** The authenticated principal attached to a request by `makeRequireAuth`. */
export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unauthorized(): AppError {
  return new AppError(401, ERROR_CODES.UNAUTHORIZED);
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * Builds a pre-handler that requires a valid access token for an active user.
 * On success it attaches `{ id, role }` to the request from the database row.
 */
export function makeRequireAuth(deps: AppDeps): preHandlerHookHandler {
  return async (request) => {
    const token = bearerToken(request);
    if (!token) {
      throw unauthorized();
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, deps.config.jwtSecret);
    } catch {
      // Expired, tampered and malformed tokens are all unauthenticated.
      throw unauthorized();
    }

    if (!UUID_RE.test(claims.sub)) {
      throw unauthorized();
    }

    const [user] = await deps.db
      .select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);

    if (!user || !user.isActive) {
      throw unauthorized();
    }

    // Access tokens are bound to the device session that minted them, so an
    // administrator revoking a user's devices also invalidates their access
    // tokens instead of waiting out the 15-minute lifetime.
    if (claims.deviceId !== undefined) {
      if (!UUID_RE.test(claims.deviceId)) {
        throw unauthorized();
      }
      const [device] = await deps.db
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(
            eq(devices.id, claims.deviceId),
            eq(devices.userId, user.id),
            isNull(devices.revokedAt),
          ),
        )
        .limit(1);
      if (!device) {
        throw unauthorized();
      }
    }

    request.user = { id: user.id, role: user.role };
  };
}

/** Builds a pre-handler that requires an already-authenticated admin. */
export function makeRequireAdmin(): preHandlerHookHandler {
  return async (request) => {
    if (request.user?.role !== 'admin') {
      throw new AppError(403, ERROR_CODES.FORBIDDEN);
    }
  };
}
