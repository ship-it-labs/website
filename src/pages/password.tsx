import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { usePageTitle } from "@/lib/page-title";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";

export function ForgotPasswordPage() {
  usePageTitle("Reset password");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    if (!email.trim()) {
      setError("Enter your account email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/auth/reset-password", { email: email.trim() });
      // Always true by design (the endpoint never reveals registration), so a
      // success screen here promises nothing about the address.
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />
      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-md">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-white">
            Reset password
          </h1>
          {sent ? (
            <div className="glass mt-8 rounded-2xl p-6">
              <p className="text-sm leading-relaxed text-zinc-300">
                If that address has an account, a reset link is on its way. It
                expires quickly — check spam if nothing arrives within a few
                minutes.
              </p>
              <Link
                to="/login"
                className="mt-5 inline-block text-sm text-violet-300 transition-colors hover:text-violet-200"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <div className="glass mt-8 rounded-2xl p-6">
              {error && (
                <p className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {error}
                </p>
              )}
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Account email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") request();
                  }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={request}
                className="mt-4 w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
              >
                {busy ? "Working…" : "Send reset link"}
              </button>
              <Link
                to="/login"
                className="mt-4 block text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function ResetPasswordPage() {
  usePageTitle("Choose a new password");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Supabase delivers the recovery token in the URL fragment, which never
  // reaches a server — the page reads it and posts it straight back.
  const recoveryToken = new URLSearchParams(
    window.location.hash.replace(/^#/, "?")
  ).get("access_token");

  async function confirm() {
    if (password.length < 8) {
      setError("The new password needs at least 8 characters.");
      return;
    }
    if (!recoveryToken) {
      setError("This reset link is missing its token. Request a new one.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/auth/reset-confirm", {
        recovery_token: recoveryToken,
        new_password: password,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the new password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />
      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-md">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-white">
            Choose a new password
          </h1>
          {done ? (
            <div className="glass mt-8 rounded-2xl p-6">
              <p className="text-sm leading-relaxed text-zinc-300">
                Done. Sign in with the new password.
              </p>
              <Link
                to="/login"
                className="mt-5 inline-block rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
              >
                Sign in
              </Link>
            </div>
          ) : (
            <div className="glass mt-8 rounded-2xl p-6">
              {error && (
                <p className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {error}
                </p>
              )}
              {!recoveryToken && (
                <p className="mb-4 text-sm text-amber-300/90">
                  This page needs to be opened from the link in the reset
                  email — arriving here directly cannot work.
                </p>
              )}
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  New password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") confirm();
                  }}
                  placeholder="8+ characters"
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={confirm}
                className="mt-4 w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
              >
                {busy ? "Working…" : "Set new password"}
              </button>
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
