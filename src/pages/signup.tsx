import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { usePageTitle } from "@/lib/page-title";
import {
  AuthLayout,
  AuthLink,
  ErrorNote,
  Field,
  PrimaryButton,
} from "@/components/site/AuthLayout";

export function SignupPage() {
  usePageTitle("Create account");
  const { signUp } = useAuth();
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

      // The key is only ever shown once, so it is parked until the keys page.
      if (result.apiKey) {
        localStorage.setItem("shipit.initial_api_key", result.apiKey);
      }

      navigate("/dashboard?welcome=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Start building"
      subtitle="24 runtime hours every month, on the house."
      footer={
        <>
          Already have an account?{" "}
          <AuthLink to="/login">Sign in</AuthLink>
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
          placeholder="At least 8 characters"
          autoComplete="new-password"
          minLength={8}
        />

        {error && <ErrorNote>{error}</ErrorNote>}

        <PrimaryButton busy={busy}>Create account</PrimaryButton>
      </form>
    </AuthLayout>
  );
}
