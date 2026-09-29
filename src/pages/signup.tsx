import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SignupPage() {
  const { signUp, configured } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signUp(email, password);

      if (result.apiKey) {
        localStorage.setItem("shipit.initial_api_key", result.apiKey);
      }

      navigate("/dashboard?welcome=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
          <CardDescription>24 runtime hours per month on the Free plan</CardDescription>
        </CardHeader>
        <CardContent>
          {!configured && (
            <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
            </p>
          )}
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Creating account..." : "Create account"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => navigate("/login")}
            >
              Already have an account
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function useApiKeyCreation() {
  const [key, setKey] = useState<string | null>(
    () => localStorage.getItem("shipit.initial_api_key")
  );

  function clear() {
    localStorage.removeItem("shipit.initial_api_key");
    setKey(null);
  }

  async function create(): Promise<string | null> {
    const result = await api.post<{ api_key: string }>("/api/v1/account/api-keys", {});
    setKey(result.api_key);
    return result.api_key;
  }

  return { key, create, clear };
}
