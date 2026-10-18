import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MeDto } from '@bookr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { clearTokens, getTokens, setSessionEndedHandler } from '../api/client';
import { fetchCurrentUser, login as loginRequest, logout as logoutRequest, register as registerRequest } from '../api/auth';
import type { LoginInput, RegisterInput } from '../api/auth';
import { clearReaderProgressCache } from '../features/reader/progressStore';

export interface AuthContextValue {
  user: MeDto | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<MeDto | null>(null);
  // Only mount in a loading state when a stored session has to be verified.
  const [loading, setLoading] = useState(() => getTokens() !== null);

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
    fetchCurrentUser()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) {
          clearTokens();
          queryClient.clear();
          clearReaderProgressCache();
          setUser(null);
        }
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
      setUser(me);
    },
    [queryClient],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const me = await registerRequest(input);
      queryClient.clear();
      clearReaderProgressCache();
      setUser(me);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
    queryClient.clear();
    clearReaderProgressCache();
    setUser(null);
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
