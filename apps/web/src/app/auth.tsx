import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MeDto } from '@bookr/shared';
import { clearTokens, getTokens } from '../api/client';
import { fetchCurrentUser, login as loginRequest, logout as logoutRequest, register as registerRequest } from '../api/auth';
import type { LoginInput, RegisterInput } from '../api/auth';

export interface AuthContextValue {
  user: MeDto | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeDto | null>(null);
  // Only mount in a loading state when a stored session has to be verified.
  const [loading, setLoading] = useState(() => getTokens() !== null);

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
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const me = await loginRequest(input);
    setUser(me);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const me = await registerRequest(input);
    setUser(me);
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
  }, []);

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
