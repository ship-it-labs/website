import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
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
}

export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [revealed, setRevealed] = useState<string | null>(
    () => localStorage.getItem("shipit.initial_api_key")
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ api_key: string }>("/api/v1/account/api-keys", {});
      setRevealed(result.api_key);
      localStorage.setItem("shipit.initial_api_key", result.api_key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setError(null);
    try {
      const result = await api.post<{ api_key: string }>(
        `/api/v1/account/api-keys/${id}/rotate`,
        {}
      );
      setRevealed(result.api_key);
      localStorage.setItem("shipit.initial_api_key", result.api_key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rotate the key");
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.post(`/api/v1/account/api-keys/${id}/revoke`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the key");
    }
  }

  return (
    <DashboardLayout
      title="API keys"
      subtitle="The plugin authenticates with one of these. Show a key once, then lose it forever."
    >
      <div className="mb-8 flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Rotate to replace, revoke to retire. Neither can be undone.
        </p>
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
        >
          {busy ? "Working…" : "Create key"}
        </button>
      </div>

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
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {k.name} {!k.is_active && <span className="text-zinc-500">(revoked)</span>}
                  </p>
                  <p className="mt-1 font-mono text-xs text-zinc-500">
                    {k.key_prefix}…
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    created {new Date(k.created_at).toLocaleString()}
                    {" · "}
                    last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => rotate(k.id)}
                    className="rounded-lg border border-white/10 px-3.5 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
                  >
                    Rotate
                  </button>
                  <button
                    type="button"
                    disabled={!k.is_active}
                    onClick={() => revoke(k.id)}
                    className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </DashboardLayout>
  );
}
