import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { usePageTitle } from "@/lib/page-title";
import {
  AuthLayout,
  ErrorNote,
  Field,
  PrimaryButton,
} from "@/components/site/AuthLayout";

/**
 * OAuth consent screen for the first-party OpenCode plugin. Arrived at from
 * the plugin via the system browser with client_id, redirect_uri (loopback
 * only), state and a PKCE challenge. If the visitor is not signed in, an
 * inline login comes first; the decision POST then approves or denies, and
 * the server hands back the exact URL to navigate to — the page never builds
 * redirect URLs itself, because the redirect target is untrusted input.
 */
export function OAuthAuthorizePage() {
  usePageTitle("Authorize OpenCode");
  const [params] = useSearchParams();
  const { user, signIn, loading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = {
    client_id: params.get("client_id") ?? "",
    redirect_uri: params.get("redirect_uri") ?? "",
    response_type: params.get("response_type") ?? "",
    state: params.get("state") ?? "",
    code_challenge: params.get("code_challenge") ?? "",
    code_challenge_method: params.get("code_challenge_method") ?? "",
  };
  const missing = ["client_id", "redirect_uri", "state", "code_challenge"].filter(
    (key) => !params.get(key)
  );

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function decide(action: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ redirect_to: string }>("/api/v1/oauth/decision", {
        ...request,
        action,
      });
      window.location.href = result.redirect_to;
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Authorization failed"
      );
    } finally {
      setBusy(false);
    }
  }

  if (missing.length > 0) {
    return (
      <AuthLayout
        title="Invalid authorization request"
        subtitle="The application sent a malformed request. Go back and start the login again."
        footer={<></>}
      >
        <ErrorNote>Missing: {missing.join(", ")}</ErrorNote>
      </AuthLayout>
    );
  }

  if (loading) {
    return (
      <AuthLayout title="Authorizing…" subtitle="One moment." footer={<></>}>
        <></>
      </AuthLayout>
    );
  }

  if (!user) {
    return (
      <AuthLayout
        title="Sign in to authorize"
        subtitle="OpenCode is asking for access to your Ship-It account. Sign in first, then decide."
        footer={<></>}
      >
        <form onSubmit={onLogin} className="space-y-5">
          <Field
            id="oauth-email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
          />
          <Field
            id="oauth-password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            autoComplete="current-password"
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          <PrimaryButton busy={busy}>Sign in</PrimaryButton>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Authorize OpenCode"
      subtitle={`${user.email} is signed in. OpenCode will be able to act as you: submit builds, run runtimes, and read their output.`}
      footer={<></>}
    >
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
        <p className="font-medium text-white">OpenCode is requesting:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Submit builds and read their logs</li>
          <li>Start, stop and inspect runtimes</li>
          <li>Read and manage your projects</li>
        </ul>
        <p className="mt-3 text-xs text-zinc-500">
          You can revoke this any time from Settings → Connected apps. The
          authorization code expires in 10 minutes and works once.
        </p>
      </div>
      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-5 flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide("approve")}
          className="flex-1 rounded-xl bg-white px-5 py-3 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
        >
          {busy ? "Working…" : "Authorize"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide("deny")}
          className="rounded-xl border border-white/10 px-5 py-3 text-sm text-zinc-400 transition-colors hover:border-white/20 hover:text-white disabled:opacity-60"
        >
          Deny
        </button>
      </div>
    </AuthLayout>
  );
}
