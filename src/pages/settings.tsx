import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { usePageTitle } from "@/lib/page-title";
import {
  DashboardLayout,
  Panel,
  EmptyState,
} from "@/components/site/DashboardLayout";

interface Session {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

interface Preferences {
  email_notifications: boolean;
  theme: string;
}

function SectionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
      {message}
    </p>
  );
}

function SectionSaved({ show }: { show: boolean }) {
  if (!show) return null;
  return <p className="mt-3 text-xs text-emerald-300">Saved.</p>;
}

export function SettingsPage() {
  usePageTitle("Settings");
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  return (
    <DashboardLayout
      title="Settings"
      subtitle="Your account, sessions and preferences. Nothing here touches anyone else's data."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileSection email={user?.email ?? ""} />
        <PasswordSection />
        <SessionsSection onSignedOut={() => navigate("/login")} signOut={signOut} />
        <PreferencesSection />
      </div>
      <div className="mt-6">
        <DangerSection
          email={user?.email ?? ""}
          onDeleted={async () => {
            await signOut();
            navigate("/");
          }}
        />
      </div>
    </DashboardLayout>
  );
}

function ProfileSection({ email }: { email: string }) {
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function changeEmail() {
    if (!newEmail.trim() || !password) {
      setError("Enter the new address and confirm with your password.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setSaved(false);
    try {
      const result = await api.post<{ email: string }>("/api/v1/account/email", {
        new_email: newEmail.trim(),
        password,
      });
      setNewEmail("");
      setPassword("");
      setSaved(true);
      // The header shows the old address until the next reload; say what moved.
      setNotice(`Address changed to ${result.email}. It shows after reload.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the email");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Profile">
      <SectionError message={error} />
      {notice && <p className="mb-4 text-sm text-violet-200">{notice}</p>}
      <dl className="grid gap-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-600">Email</dt>
          <dd className="mt-1 break-all text-sm text-zinc-200">{email || "—"}</dd>
        </div>
      </dl>
      <div className="mt-5 border-t border-white/[0.07] pt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Change email
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <input
            type="email"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder="new@example.com"
            maxLength={254}
            aria-label="New email address"
            autoComplete="email"
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Current password to confirm"
            aria-label="Current password"
            autoComplete="current-password"
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy}
            onClick={changeEmail}
            className="self-start rounded-xl bg-white/[0.06] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/[0.11] disabled:opacity-60"
          >
            {busy ? "Working…" : "Change email"}
          </button>
        </div>
        <SectionSaved show={saved} />
      </div>
    </Panel>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function changePassword() {
    if (next.length < 8) {
      setError("The new password needs at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.post("/api/v1/account/password", {
        current_password: current,
        new_password: next,
      });
      setCurrent("");
      setNext("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Password">
      <SectionError message={error} />
      <div className="flex flex-col gap-3">
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          placeholder="Current password"
          aria-label="Current password"
          autoComplete="current-password"
          className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
        />
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="New password (8+ characters)"
          aria-label="New password"
          autoComplete="new-password"
          className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
        />
        <button
          type="button"
          disabled={busy}
          onClick={changePassword}
          className="self-start rounded-xl bg-white/[0.06] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/[0.11] disabled:opacity-60"
        >
          {busy ? "Working…" : "Change password"}
        </button>
      </div>
      <SectionSaved show={saved} />
    </Panel>
  );
}

function SessionsSection({
  onSignedOut,
  signOut,
}: {
  onSignedOut: () => void;
  signOut: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ sessions: Session[] }>("/api/v1/account/sessions");
      setSessions(result.sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sessions");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id: string) {
    setBusy(id);
    try {
      await api.del(`/api/v1/account/sessions/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out that session");
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy("others");
    try {
      await api.del("/api/v1/account/sessions");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out other sessions");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Sessions"
      description="Every remembered login. Sessions signed in before tracking shipped are not listed and keep working until they expire."
    >
      <SectionError message={error} />
      {sessions.length === 0 ? (
        <EmptyState>No other sessions on record.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-white/[0.06]">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-200">
                    {session.user_agent || "Unknown device"}
                    {session.current && (
                      <span className="ml-2 rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[11px] text-zinc-300">
                        this device
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    {session.ip && `${session.ip} · `}
                    since {new Date(session.created_at).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy === session.id}
                  onClick={() => revoke(session.id)}
                  className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
                >
                  {busy === session.id ? "…" : "Sign out"}
                </button>
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <button
              type="button"
              disabled={busy === "others"}
              onClick={revokeOthers}
              className="mt-5 rounded-xl bg-white/[0.06] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/[0.11] disabled:opacity-60"
            >
              {busy === "others" ? "Working…" : "Sign out all other sessions"}
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              await signOut();
              onSignedOut();
            }}
            className="mt-3 block text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Sign out everywhere, including this device
          </button>
        </>
      )}
    </Panel>
  );
}

function PreferencesSection() {
  const [notifications, setNotifications] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ preferences: Preferences }>("/api/v1/account/preferences");
      setNotifications(result.preferences.email_notifications !== false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load preferences");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(value: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch("/api/v1/account/preferences", { email_notifications: value });
      setNotifications(value);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save preferences");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Preferences"
      description="Stored on your account, applied everywhere you sign in."
    >
      <SectionError message={error} />
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-white">Email notifications</span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            Build results, billing receipts and security alerts. Channels open
            up as each one ships; the choice is remembered meanwhile.
          </span>
        </span>
        <input
          type="checkbox"
          checked={notifications}
          disabled={busy}
          onChange={(event) => save(event.target.checked)}
          className="h-5 w-5 shrink-0 accent-violet-500"
        />
      </label>
      <SectionSaved show={saved} />
    </Panel>
  );
}

function DangerSection({ email, onDeleted }: { email: string; onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function destroy() {
    if (confirm.trim().toLowerCase() !== email.trim().toLowerCase() || !email) {
      setError("Type your exact email address to confirm.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.del("/api/v1/account", { password });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Danger zone">
      <SectionError message={error} />
      <p className="text-sm text-zinc-400">
        Deleting removes your projects, builds, API keys, preferences and login
        in one move, and stops any running runtimes. Payment records stay with
        Whop, and anonymized billing events stay here as the audit trail. This
        cannot be undone.
      </p>
      <div className="mt-4 flex max-w-md flex-col gap-3">
        <input
          type="text"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder={`Type ${email || "your email"} to confirm`}
          aria-label="Type your email to confirm deletion"
          className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-rose-400/50 focus:outline-none"
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Current password"
          aria-label="Current password"
          autoComplete="current-password"
          className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-rose-400/50 focus:outline-none"
        />
        <button
          type="button"
          disabled={busy}
          onClick={destroy}
          className="self-start rounded-xl bg-rose-500/90 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-60"
        >
          {busy ? "Working…" : "Delete my account"}
        </button>
      </div>
    </Panel>
  );
}
