import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAccessToken } from "@/lib/api";
import { timeAgo } from "@/lib/time";
import { useAuth } from "@/lib/auth-context";
import {
  DashboardLayout,
  Panel,
  EmptyState,
} from "@/components/site/DashboardLayout";

interface ApiKeyRecord {
  id: string;
  key_prefix: string;
  name: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

const EXPIRY_PRESETS = [
  { label: "Never", days: 0 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

function expiryLabel(expiresAt: string | null, isActive: boolean): string {
  if (!expiresAt) return "never expires";
  if (!isActive) return `expired ${new Date(expiresAt).toLocaleDateString()}`;

  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "expired";

  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  return days === 1
    ? "expires tomorrow"
    : `expires in ${days} days (${new Date(expiresAt).toLocaleDateString()})`;
}

export function ApiKeysPage() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [revealed, setRevealed] = useState<string | null>(
    () => localStorage.getItem("shipit.initial_api_key")
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  // The create form. Collected up front so a key is born named and dated
  // rather than as an anonymous immortal default.
  const [keyName, setKeyName] = useState("");
  const [expiryDays, setExpiryDays] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ api_keys: ApiKeyRecord[] }>("/api/v1/account/api-keys");
      setKeys(result.api_keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the keys");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!keyName.trim()) {
      setError("Give the key a name so you know what it is for later.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        api_key: string;
        expires_at: string | null;
      }>("/api/v1/account/api-keys", {
        name: keyName.trim(),
        // Omitting expiry entirely is what "never" means to the API; sending
        // expires_in_days: 0 would fail validation.
        ...(expiryDays > 0 ? { expires: { expires_in_days: expiryDays } } : {}),
      });
      setRevealed(result.api_key);
      localStorage.setItem("shipit.initial_api_key", result.api_key);
      setKeyName("");
      setExpiryDays(0);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setBusyKey(id);
    setError(null);
    try {
      const result = await api.post<{ api_key: string; rotated_own_key: boolean }>(
        `/api/v1/account/api-keys/${id}/rotate`,
        {}
      );
      // Rotating the key the browser holds kills its own session. Swapping in
      // the replacement keeps the page signed in instead of dropping it into
      // an error state that looks like the rotation failed.
      if (result.rotated_own_key) {
        setAccessToken(result.api_key);
      }
      setRevealed(result.api_key);
      localStorage.setItem("shipit.initial_api_key", result.api_key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rotate the key");
    } finally {
      setBusyKey(null);
    }
  }

  async function revoke(id: string) {
    setBusyKey(id);
    setError(null);
    try {
      const result = await api.post<{ revoked_own_key: boolean }>(
        `/api/v1/account/api-keys/${id}/revoke`,
        {}
      );
      // Revoking the key the browser holds ends this session with the request.
      // Signing out cleanly beats failing the next load with a bare 401.
      if (result.revoked_own_key) {
        await signOut();
        navigate("/login");
        return;
      }
      setConfirmRevoke(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the key");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <DashboardLayout
      title="API keys"
      subtitle="The plugin authenticates with one of these. Show a key once, then lose it forever."
    >
      <Panel title="Create a key" className="mb-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Key name
            </span>
            <input
              type="text"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="e.g. laptop plugin"
              maxLength={64}
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Expires
            </span>
            <select
              value={expiryDays}
              onChange={(event) => setExpiryDays(Number(event.target.value))}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 focus:border-violet-500/60 focus:outline-none [&>option]:bg-zinc-900"
            >
              {EXPIRY_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.days}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
          >
            {busy ? "Working…" : "Create key"}
          </button>
        </div>
      </Panel>

      {error && (
        <p className="mb-8 rounded-xl border border-rose-400/25 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">
          {error}
        </p>
      )}

      {revealed && (
        <div className="mb-8 rounded-2xl border border-violet-400/30 bg-violet-500/10 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-200">
                Copy this key now
              </p>
              <p className="mt-1 text-sm text-violet-100">
                It will never be shown again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(revealed)}
              className="rounded-lg border border-violet-400/40 px-3 py-1.5 text-xs text-violet-200 transition-colors hover:bg-violet-500/20"
            >
              Copy
            </button>
          </div>
          <code className="mt-4 block break-all rounded-lg border border-violet-400/25 bg-zinc-950/60 p-4 font-mono text-xs text-violet-100">
            {revealed}
          </code>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem("shipit.initial_api_key");
              setRevealed(null);
            }}
            className="mt-3 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Dismiss
          </button>
        </div>
      )}

      <Panel title="Keys">
        {keys.length === 0 ? (
          <EmptyState>No keys yet. Create one to give the plugin access.</EmptyState>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {keys.map((k) => {
              const expired =
                k.expires_at !== null &&
                new Date(k.expires_at).getTime() <= Date.now();
              const working = busyKey === k.id;
              // A key dying within the week gets an amber deadline rather than
              // the same grey text as one living for a year — expired keys
              // break the plugin at the worst moment, silently, at 3am.
              const remainingMs = k.expires_at
                ? new Date(k.expires_at).getTime() - Date.now()
                : null;
              const expiringSoon =
                k.is_active &&
                remainingMs !== null &&
                remainingMs > 0 &&
                remainingMs <= 7 * 24 * 60 * 60 * 1000;

              return (
                <li key={k.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                      {k.name}{" "}
                      {!k.is_active && <span className="text-zinc-500">(revoked)</span>}
                      {expired && k.is_active && (
                        <span className="text-amber-300">(expired)</span>
                      )}
                    </p>
                    <p className="mt-1 font-mono text-xs text-zinc-500">
                      {k.key_prefix}…
                    </p>
                    <p className="mt-1 text-xs text-zinc-600">
                      <span title={new Date(k.created_at).toLocaleString()}>
                        created {timeAgo(k.created_at)}
                      </span>
                      {" · "}
                      {expiringSoon ? (
                        <span className="font-medium text-amber-300">
                          {expiryLabel(k.expires_at, k.is_active)}
                        </span>
                      ) : (
                        expiryLabel(k.expires_at, k.is_active)
                      )}
                      {" · "}
                      last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {k.is_active && !expired && (
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => rotate(k.id)}
                        className="rounded-lg border border-white/10 px-3.5 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
                      >
                        {working ? "Working…" : "Rotate"}
                      </button>
                    )}
                    {k.is_active &&
                      (confirmRevoke === k.id ? (
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={working}
                            onClick={() => revoke(k.id)}
                            className="rounded-lg bg-rose-500/90 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-40"
                          >
                            {working ? "Working…" : "Confirm"}
                          </button>
                          <button
                            type="button"
                            disabled={working}
                            onClick={() => setConfirmRevoke(null)}
                            className="rounded-lg px-2 py-2 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => setConfirmRevoke(k.id)}
                          className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                        >
                          Revoke
                        </button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </DashboardLayout>
  );
}
