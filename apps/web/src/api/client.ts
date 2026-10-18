import type { ApiErrorBody, AuthTokens, ErrorCode } from '@bookr/shared';

/** localStorage key holding the access and refresh tokens. */
export const TOKEN_STORAGE_KEY = 'bookr.tokens';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage (private mode, sandboxed iframe) behaves like no session.
    return null;
  }
}

export function getTokens(): AuthTokens | null {
  const raw = storage()?.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AuthTokens>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresIn: typeof parsed.expiresIn === 'number' ? parsed.expiresIn : 0,
    };
  } catch {
    return null;
  }
}

export function setTokens(tokens: AuthTokens): void {
  storage()?.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  storage()?.removeItem(TOKEN_STORAGE_KEY);
}

/** Builds an ApiError from the shared error envelope, falling back to HTTP text. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }

  const fallback = response.statusText || '请求失败，请稍后重试';
  return new ApiError(
    response.status,
    body?.error?.code ?? 'INTERNAL',
    body?.error?.message ?? fallback,
    body?.error?.details,
  );
}

function buildRequest(init: RequestInit | undefined, accessToken: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  if (init?.body !== undefined && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

async function refreshSession(refreshToken: string): Promise<AuthTokens> {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) throw await errorFromResponse(response);

  const tokens = (await response.json()) as AuthTokens;
  setTokens(tokens);
  return tokens;
}

function endSession(): void {
  clearTokens();
  if (typeof window === 'undefined') return;
  // Login itself never goes through apiFetch, so this is always a dead session.
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

/**
 * Fetches a JSON API endpoint with the bearer token, refreshing it once on a
 * 401 and retrying the original request. A failed refresh clears the session
 * and sends the browser to `/login`.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let tokens = getTokens();
  let response = await fetch(path, buildRequest(init, tokens?.accessToken ?? null));

  if (response.status === 401) {
    if (!tokens?.refreshToken) {
      endSession();
      throw await errorFromResponse(response);
    }

    try {
      tokens = await refreshSession(tokens.refreshToken);
      response = await fetch(path, buildRequest(init, tokens.accessToken));
    } catch (error) {
      endSession();
      throw error instanceof ApiError ? error : await errorFromResponse(response);
    }

    if (response.status === 401) {
      endSession();
      throw await errorFromResponse(response);
    }
  }

  if (!response.ok) throw await errorFromResponse(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Posts JSON without refresh handling, for login, register and logout. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await errorFromResponse(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
