import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setAccessToken, getAccessToken, ApiError } from "@/lib/api";

interface AccountUser {
  id: string;
  email: string;
  plan_id?: string;
  is_admin?: boolean;
}

interface AuthState {
  user: AccountUser | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ apiKey: string }>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface SignupResponse {
  user: AccountUser;
  api_key: string;
  session: { access_token?: string } | null;
}

interface LoginResponse {
  user: AccountUser | null;
  session: { access_token?: string } | null;
}

interface AccountResponse {
  user: AccountUser;
  is_admin?: boolean;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on load by asking the server who the token belongs to.
  // Only a definitive rejection clears the token: expired, revoked, disabled
  // or unknown. Anything else (cold start, 502, offline) keeps it, because
  // wiping credentials over a transient failure is exactly how opening the
  // homepage "logged out" a signed-in user. One retry covers slow wakes.
  useEffect(() => {
    if (!getAccessToken()) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await api.get<AccountResponse>("/api/v1/account");
          if (!cancelled) {
            setUser({ ...result.user, is_admin: result.is_admin ?? result.user.is_admin ?? false });
          }
          return;
        } catch (err) {
          const dead =
            err instanceof ApiError && (err.status === 401 || err.status === 403);
          if (dead) {
            // A revoked session lands on the login page with no explanation.
            // Leave a note for it: the page shows it once, then clears it.
            if (err instanceof ApiError && err.code === "SESSION_REVOKED") {
              try {
                sessionStorage.setItem("shipit.session_expired", "1");
              } catch {
                // Private mode without storage still signs in fine.
              }
            }
            if (!cancelled) setAccessToken(null);
            return;
          }
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
    })()
      .catch(() => {
        // Unreachable in practice (every failure path above is handled), but an
        // unhandled rejection here would surface as a console error on load.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const result = await api.post<SignupResponse>("/api/v1/auth/signup", {
      email,
      password,
    });

    if (result.session?.access_token) {
      setAccessToken(result.session.access_token);
    }
    setUser(result.user);

    return { apiKey: result.api_key };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.post<LoginResponse>("/api/v1/auth/login", { email, password });

    const token = result.session?.access_token;
    if (token) setAccessToken(token);
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      // Clearing the local session is enough if the server call fails.
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    await api.post("/api/v1/auth/reset-password", { email });
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, signUp, signIn, signOut, resetPassword }),
    [user, loading, signUp, signIn, signOut, resetPassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
