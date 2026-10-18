import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MeDto } from '@bookr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, clearTokens, getTokens, setSessionEndedHandler } from '../api/client';
import { fetchCurrentUser, login as loginRequest, logout as logoutRequest, register as registerRequest } from '../api/auth';
import type { LoginInput, RegisterInput } from '../api/auth';
import { clearReaderProgressCache } from '../features/reader/progressStore';

/** Last verified profile, used to keep the session across an offline restart. */
export const PROFILE_STORAGE_KEY = 'bookr.me';

/** Shown when a stored session cannot be verified and no profile was cached. */
export const OFFLINE_LOGIN_NOTICE = '当前离线，需要联网登录一次后才能继续阅读。';

export interface AuthContextValue {
  user: MeDto | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Explains why the visitor landed on the login page without a session. */
  sessionNotice: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function profileStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage behaves like no cached profile.
    return null;
  }
}

/**
 * The cached profile is only a convenience for offline starts: it is written
 * after the API validated the account and cleared whenever the session ends.
 */
function readCachedUser(): MeDto | null {
  const raw = profileStorage()?.getItem(PROFILE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MeDto>;
    if (
      typeof value.id !== 'string' ||
      typeof value.username !== 'string' ||
      typeof value.displayName !== 'string'
    ) {
      return null;
    }
    return value as MeDto;
  } catch {
    return null;
  }
}

function writeCachedUser(user: MeDto): void {
  profileStorage()?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(user));
}

function clearCachedUser(): void {
  profileStorage()?.removeItem(PROFILE_STORAGE_KEY);
}

/** A rejection from the API (as opposed to an unreachable server). */
function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<MeDto | null>(null);
  // Only mount in a loading state when a stored session has to be verified.
  const [loading, setLoading] = useState(() => getTokens() !== null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    // A refresh failure ends the session inside the API client; route that
    // cleanup through this provider's query client rather than a second cache.
    // Only the legacy localStorage position cache is cleared here: Dexie data
    // is namespaced by userId and kept, since it may hold unsynced writes.
    setSessionEndedHandler(() => {
      queryClient.clear();
      clearReaderProgressCache();
    });
    return () => setSessionEndedHandler(null);
  }, [queryClient]);

  useEffect(() => {
    if (!getTokens()) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    function endSession(): void {
      clearTokens();
      clearCachedUser();
      queryClient.clear();
      clearReaderProgressCache();
      setUser(null);
    }

    fetchCurrentUser()
      .then((me) => {
        if (cancelled) return;
        writeCachedUser(me);
        setSessionNotice(null);
        setUser(me);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Only an explicit rejection from the API means the session is gone.
        // Offline, a transport failure or a server fault keeps the tokens and
        // restores the last verified profile, so the shelf and cached books
        // stay available until the network returns.
        if (!isUnauthorized(error)) {
          const cached = readCachedUser();
          if (cached) {
            setUser(cached);
            return;
          }
          setSessionNotice(OFFLINE_LOGIN_NOTICE);
        }
        endSession();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const login = useCallback(
    async (input: LoginInput) => {
      const me = await loginRequest(input);
      // A different account may be signing in on a shared browser; the query
      // cache and the legacy localStorage position cache must not cross that
      // boundary. Dexie rows are namespaced by userId, so they stay.
      queryClient.clear();
      clearReaderProgressCache();
      writeCachedUser(me);
      setSessionNotice(null);
      setUser(me);
    },
    [queryClient],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const me = await registerRequest(input);
      queryClient.clear();
      clearReaderProgressCache();
      writeCachedUser(me);
      setSessionNotice(null);
      setUser(me);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
    clearCachedUser();
    queryClient.clear();
    clearReaderProgressCache();
    setUser(null);
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout, sessionNotice }),
    [user, loading, login, register, logout, sessionNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
