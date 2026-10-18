import type { Role } from '@bookr/shared';
import { SignJWT, errors, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';

const ISSUER = 'bookr';
const AUDIENCE = 'bookr-web';
const ALGORITHM = 'HS256';

/** Default access-token lifetime in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Refresh-token lifetime in milliseconds. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Claims carried by an access token. */
export interface AccessTokenClaims {
  sub: string;
  role: Role;
}

/** A freshly generated refresh token and the values derived from it. */
export interface RefreshToken {
  token: string;
  hash: string;
  expiresAt: Date;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Signs a short-lived HS256 access token. A negative TTL yields an expired token. */
export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey(secret));
}

/** Verifies an access token and returns its claims. */
export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALGORITHM],
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new Error('Access token has expired');
    }
    throw error;
  }

  const { sub, role } = payload;
  if (typeof sub !== 'string' || (role !== 'admin' && role !== 'member')) {
    throw new Error('Access token payload is invalid');
  }
  return { sub, role };
}

/** Creates a random refresh token; only its sha256 hash is persisted. */
export function newRefreshToken(): RefreshToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

/** Hashes a refresh token for storage and lookup. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
