import type { AuthTokens, MeDto, ProfileUpdateDto } from '@bookr/shared';
import { apiFetch, clearTokens, getTokens, postJson, setTokens } from './client';

export interface LoginInput {
  username: string;
  password: string;
}

export interface RegisterInput {
  inviteCode: string;
  username: string;
  password: string;
  displayName: string;
}

async function completeSignIn(tokens: AuthTokens): Promise<MeDto> {
  setTokens(tokens);
  return apiFetch<MeDto>('/api/auth/me');
}

export async function login(input: LoginInput): Promise<MeDto> {
  const tokens = await postJson<AuthTokens>('/api/auth/login', input);
  return completeSignIn(tokens);
}

export async function register(input: RegisterInput): Promise<MeDto> {
  const tokens = await postJson<AuthTokens>('/api/auth/register', input);
  return completeSignIn(tokens);
}

export function fetchCurrentUser(): Promise<MeDto> {
  return apiFetch<MeDto>('/api/auth/me');
}

/** Saves the statistics timezone; the server rebuilds daily aggregates. */
export function updateTimezone(timezone: string): Promise<ProfileUpdateDto> {
  return apiFetch<ProfileUpdateDto>('/api/auth/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone }),
  });
}

export async function logout(): Promise<void> {
  const tokens = getTokens();
  if (tokens) {
    try {
      await postJson<void>('/api/auth/logout', { refreshToken: tokens.refreshToken });
    } catch {
      // A revoked or unreachable server must not trap the user in the app.
    }
  }
  clearTokens();
}
