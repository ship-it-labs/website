import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
interface EnvKeyState {
  key: string;
  label: string;
  description: string;
  secret: boolean;
  development_set: boolean;
  production_set: boolean;
  shell_set: boolean;
}

interface EnvState {
  keys: EnvKeyState[];
  active: unknown;
  runtime_mode: string;
}

type EnvColumn = "development" | "production";

/**
 * Deployment configuration in two columns. Development and production values
 * live side by side in the database; the active column (auto-following the
 * runtime mode unless pinned) is pulled on boot and every minute after, so
 * rotating a secret is a save click, never a redeploy. Values are write-only
 * here: inputs start empty and statuses show presence, so no secret ever
 * renders into the page.
 */
export function EnvironmentSection({ onError }: { onError: (message: string | null) => void }) {
  const [state, setState] = useState<EnvState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<EnvColumn, string>>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEnv, setConfirmEnv] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, { value: string | null; source: string }>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const hideTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.get<EnvState>("/api/v1/admin/env"));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load environment");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(key: string, environment: EnvColumn) {
    const value = drafts[key]?.[environment] ?? "";
    setBusy(`${key}:${environment}`);
    try {
      await api.put("/api/v1/admin/env", { key, environment, value });
      setDrafts((current) => {
        const next = { ...current };
        if (next[key]) {
          const entry = { ...next[key] };
          delete entry[environment];
          if (Object.keys(entry).length === 0) delete next[key];
          else next[key] = entry;
        }
        return next;
      });
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the value");
    } finally {
      setBusy(null);
    }
  }

  async function clear(key: string, environment: EnvColumn) {
    setBusy(`${key}:${environment}:clear`);
    try {
      await api.put("/api/v1/admin/env", { key, environment, value: "" });
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not clear the value");
    } finally {
      setBusy(null);
    }
  }

  async function switchActive(environment: string) {
    setSwitching(true);
    try {
      await api.patch("/api/v1/admin/settings", { config_environment: environment });
      setConfirmEnv(null);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not switch configuration");
    } finally {
      setSwitching(false);
    }
  }

  // Revealed secrets hide themselves after 30 seconds and on unmount: a value
  // left on screen is how secrets end up in screenshots.
  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, []);

  function scheduleHide(slot: string) {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setRevealed((current) => {
        const next = { ...current };
        delete next[slot];
        return next;
      });
    }, 30_000);
  }

  async function reveal(key: string, environment: EnvColumn) {
    const slot = `${key}:${environment}`;
    setRevealing(slot);
    try {
      const out = await api.get<{ value: string | null; source: string }>(
        `/api/v1/admin/env/value?key=${encodeURIComponent(key)}&environment=${environment}`
      );
      setRevealed((current) => ({ ...current, [slot]: out }));
      scheduleHide(slot);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not reveal the value");
    } finally {
      setRevealing(null);
    }
  }

  function hide(slot: string) {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    setRevealed((current) => {
      const next = { ...current };
      delete next[slot];
      return next;
    });
  }

  async function copy(slot: string) {
    const entry = revealed[slot];
    if (!entry?.value) return;
    try {
      await navigator.clipboard?.writeText(entry.value);
    } catch {
      onError("The clipboard refused the copy. Select and copy manually.");
    }
  }

  if (!state) return <p className="text-sm text-zinc-500">Loading…</p>;

  const active = state.active === "development" || state.active === "production" ? state.active : "auto";
  const effective = active === "auto" ? state.runtime_mode : active;

  return (
    <>
      <div className="glass mb-6 rounded-2xl">
        <div className="border-b border-white/[0.07] px-6 py-5">
          <h2 className="text-[15px] font-semibold text-white">Active configuration</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {`Runtime mode is ${state.runtime_mode}; ${
              active === "auto"
                ? `following it (using ${effective} values)`
                : `pinned to ${effective} values`
            }. Switching changes configuration values only — never the database driver, auth backend, or any other runtime-mode behavior.`}
          </p>
        </div>
        <div className="p-6">
          <div className="flex flex-wrap gap-2">
            {["auto", "development", "production"].map((option) => (
              <button
                key={option}
                type="button"
                disabled={switching}
                onClick={() => {
                  if (option !== active) setConfirmEnv(option);
                }}
                className={`rounded-lg px-4 py-2 text-sm capitalize transition-colors disabled:opacity-60 ${
                  active === option
                    ? "bg-white/[0.08] text-white"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {option === "auto" ? `Auto (${state.runtime_mode})` : option}
              </button>
            ))}
          </div>
          {confirmEnv && (
            <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-500/10 p-5">
              <p className="text-sm font-medium text-white">
                {confirmEnv === "auto"
                  ? "Follow the runtime mode again?"
                  : `Pin configuration to ${confirmEnv} values?`}
              </p>
              <p className="mt-1 text-sm text-zinc-400">
                {confirmEnv === "development"
                  ? "This deployment will immediately start using development values — test keys, sandbox payments. On a production host that means real traffic hitting sandbox integrations."
                  : confirmEnv === "production"
                    ? "This deployment will immediately start using production values — live keys, real payments. On a dev machine that means test traffic hitting live integrations."
                    : "Values follow NODE_ENV again: development column locally, production column in production."}
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={switching}
                  onClick={() => switchActive(confirmEnv)}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
                >
                  {switching ? "Switching…" : "Confirm switch"}
                </button>
                <button
                  type="button"
                  disabled={switching}
                  onClick={() => setConfirmEnv(null)}
                  className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {state.keys.map((entry) => {
        const draft = drafts[entry.key] ?? {};
        return (
          <div key={entry.key} className="glass mb-6 rounded-2xl">
            <div className="border-b border-white/[0.07] px-6 py-5">
              <h2 className="text-[15px] font-semibold text-white">{entry.label}</h2>
              <p className="mt-1 font-mono text-xs text-zinc-500">{entry.key}</p>
              <p className="mt-1 text-sm text-zinc-500">{entry.description}</p>
            </div>
            <div className="grid gap-4 p-6 md:grid-cols-2">
              {(["development", "production"] as const).map((environment) => {
                const dbSet = environment === "development" ? entry.development_set : entry.production_set;
                const pending = draft[environment] ?? "";
                const working = busy === `${entry.key}:${environment}` || busy === `${entry.key}:${environment}:clear`;
                const slot = `${entry.key}:${environment}`;
                const shown = revealed[slot] ?? null;
                const isRevealing = revealing === slot;
                return (
                  <div key={environment} className="block">
                    <span className="mb-1.5 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      {environment}
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] normal-case ${
                          dbSet
                            ? "bg-emerald-500/15 text-emerald-200"
                            : entry.shell_set
                              ? "bg-white/[0.08] text-zinc-400"
                              : "bg-zinc-500/15 text-zinc-500"
                        }`}
                        title={
                          dbSet
                            ? "A database value overrides the shell for this column"
                            : entry.shell_set
                              ? "No database value; the shell value is in effect"
                              : "No value anywhere; features needing this are disabled"
                        }
                      >
                        {dbSet ? "db" : entry.shell_set ? "shell" : "unset"}
                      </span>
                      <button
                        type="button"
                        disabled={isRevealing}
                        onClick={() => (shown ? hide(slot) : reveal(entry.key, environment))}
                        className="rounded px-1.5 py-0.5 font-mono text-[10px] normal-case text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-40"
                      >
                        {isRevealing ? "…" : shown ? "hide" : "show"}
                      </button>
                    </span>
                    {shown && (
                      <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/[0.07] bg-black/40 px-3 py-2">
                        <span className="text-[10px] uppercase tracking-wide text-zinc-600">
                          {shown.source === "db" ? "from database" : shown.source === "shell" ? "from shell" : "unset"}
                        </span>
                        <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">
                          {shown.value ?? "—"}
                        </code>
                        {shown.value && (
                          <button
                            type="button"
                            onClick={() => copy(slot)}
                            className="shrink-0 text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
                          >
                            Copy
                          </button>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={pending}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [entry.key]: { ...current[entry.key], [environment]: event.target.value },
                          }))
                        }
                        placeholder={dbSet ? "•••••• (set — type to replace)" : "Empty — shell value in use"}
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={working || pending === ""}
                        onClick={() => save(entry.key, environment)}
                        className="shrink-0 rounded-lg bg-white/[0.06] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-white/[0.11] disabled:opacity-40"
                      >
                        Save
                      </button>
                      {dbSet && (
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => clear(entry.key, environment)}
                          title="Delete the database value; the shell value takes over"
                          className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
