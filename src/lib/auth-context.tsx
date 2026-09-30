import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setAccessToken, getAccessToken } from "@/lib/api";

interface AccountUser {
  id: string;
  email: string;
  plan_id?: string;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on load by asking the server who the token belongs to.
  useEffect(() => {
    if (!getAccessToken()) {
      setLoading(false);
      return;
    }

    api
      .get<{ user: AccountUser }>("/api/v1/account")
      .then((result) => setUser(result.user))
      .catch(() => setAccessToken(null))
      .finally(() => setLoading(false));
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
