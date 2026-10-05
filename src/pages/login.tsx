import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import {
  AuthLayout,
  AuthLink,
  ErrorNote,
  Field,
  PrimaryButton,
  SuccessNote,
} from "@/components/site/AuthLayout";

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await signIn(email, password);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your runtime dashboard."
      footer={
        <>
          No account yet?{" "}
          <AuthLink to="/signup">Create one</AuthLink>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
          autoComplete="current-password"
        />

        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && <SuccessNote>{notice}</SuccessNote>}

        <PrimaryButton busy={busy}>Sign in</PrimaryButton>
        <p className="mt-4 text-center text-xs text-zinc-500">
          Forgot your password?{" "}
          <AuthLink to="/forgot-password">Reset it</AuthLink>
        </p>
      </form>
    </AuthLayout>
  );
}
