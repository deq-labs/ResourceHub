import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Role, SessionUser } from '@resourcehub/contracts';
import { onSessionChange, refreshSession, signInUrl, signOut } from './api';
import { roleAtLeast } from './utils';

type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: SessionUser };

interface AuthContextValue {
  state: AuthState;
  user: SessionUser | null;
  can: (min: Role) => boolean;
  signIn: (returnTo?: string) => void;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    const off = onSessionChange((s) => {
      setState(s ? { status: 'authenticated', user: s.user } : { status: 'anonymous' });
    });
    void refreshSession();
    return off;
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const user = state.status === 'authenticated' ? state.user : null;
    return {
      state,
      user,
      can: (min) => roleAtLeast(user?.role ?? undefined, min),
      signIn: (returnTo) => {
        window.location.assign(signInUrl(returnTo));
      },
      signOut: async () => {
        await signOut();
        window.location.assign('/signin');
      },
      reload: async () => {
        await refreshSession();
      },
    };
  }, [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
