import { z } from 'zod';
import { isValidTimeZone } from '../stats';

/** Username rule shared by registration and login. */
const usernameSchema = z.string().regex(/^[a-zA-Z0-9_]{3,32}$/);

export const registerSchema = z.object({
  inviteCode: z.string().min(6).max(64),
  username: usernameSchema,
  password: z.string().min(10).max(128),
  displayName: z.string().min(1).max(50),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(32),
});

export const updateProfileSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, { message: 'invalid timezone' }),
});

/** Fields the current user may change on their profile. */
export interface ProfileUpdateDto {
  timezone: string;
}

/** Member permission level. */
export type Role = 'admin' | 'member';

/** Tokens returned after a successful login or refresh. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Current user profile and quota usage. */
export interface MeDto {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  timezone: string;
  aiEnabled: boolean;
  uploadUsedBytes: number;
  uploadQuotaBytes: number;
  libraryUsedBytes: number;
  libraryQuotaBytes: number;
}
