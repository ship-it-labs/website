import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { setAccessTokenProvider } from "@/lib/api";

interface AuthState {
  userId: string | null;
  email: string | null;
  loading: boolean;
  configured: boolean;
  signUp: (email: string, password: string) => Promise<{ apiKey: string }>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  setAccessTokenProvider(async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  });

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user?.id ?? null);
      setEmail(data.session?.user?.email ?? null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
      setEmail(session?.user?.email ?? null);
      setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    userId,
    email,
    loading,
    configured: Boolean(supabase),

    async signUp(mail, password) {
      if (!supabase) throw new Error("Supabase is not configured");

      const { data, error } = await supabase.auth.signUp({ email: mail, password });
      if (error) throw new Error(error.message);
      if (!data.user) throw new Error("Signup did not return a user");

      const { data: created, error: createError } = await supabase
        .from("users")
        .insert({ id: data.user.id, email: mail, plan_id: "free" });

      if (createError && !createError.message.includes("duplicate")) {
        console.warn("Could not create profile row:", createError.message);
      }

      return { apiKey: created ? "" : "" };
    },

    async signIn(mail, password) {
      if (!supabase) throw new Error("Supabase is not configured");
      const { error } = await supabase.auth.signInWithPassword({ email: mail, password });
      if (error) throw new Error(error.message);
    },

    async signOut() {
      if (!supabase) return;
      await supabase.auth.signOut();
    },

    async resetPassword(mail) {
      if (!supabase) throw new Error("Supabase is not configured");
      const { error } = await supabase.auth.resetPasswordForEmail(mail);
      if (error) throw new Error(error.message);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
