import { useCallback, useEffect, useState } from "react";
import { api, formatDuration, getAccessToken } from "@/lib/api";
import {
  DashboardLayout,
  Panel,
  StatTile,
  StatusDot,
  EmptyState,
} from "@/components/site/DashboardLayout";
import { BuildLogViewer } from "@/components/site/BuildLogViewer";
import { LeaseCountdown, useNow } from "@/components/site/LeaseCountdown";
import { EnvironmentSection } from "@/components/site/EnvironmentSection";
import { DatabaseSection } from "@/components/site/DatabaseSection";

interface Overview {
  users: { total: number; by_plan: Record<string, number> };
  runtimes: { total: number; running: number; paused: number };
  builds: { today: number; succeeded_today: number };
  usage_month: { runtime_used_seconds: number; build_count: number };
  capacity: {
    agents: { agent_id?: string; id?: string; current_runtimes?: number; max_runtimes?: number }[];
    total_used: number;
    total_max: number;
  } | null;
}

interface AdminUser {
  id: string;
  email: string;
  plan_id: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
}

interface AdminRuntime {
  runtime_id: string;
  user_id: string;
  owner_email: string | null;
  status: string;
  app_url?: string;
  lease_expires_at: string;
  max_session_seconds: number;
  started_at: string;
  agent_id?: string;
}

interface AdminBuild {
  id: string;
  user_id: string;
  owner_email: string | null;
  status: string;
  exit_code: number | null;
  created_at: string;
  github_run_url?: string | null;
}

interface Plan {
  id: string;
  name: string;
  runtime_hours_per_month: number;
  max_runtime_hours: number;
  max_concurrent_runtimes: number;
  max_ram_mb: number;
  cpu: number;
  build_timeout_seconds: number;
  price_cents: number;
  note: string | null;
  previous_price_cents: number | null;
}

type Section = "overview" | "users" | "runtimes" | "builds" | "payments" | "analytics" | "plans" | "settings" | "environment" | "database" | "webhooks" | "audit";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "runtimes", label: "Runtimes" },
  { id: "builds", label: "Builds" },
  { id: "payments", label: "Payments" },
  { id: "analytics", label: "Analytics" },
  { id: "plans", label: "Plans" },
  { id: "settings", label: "Settings" },
  { id: "environment", label: "Environment" },
  { id: "database", label: "Database" },
  { id: "webhooks", label: "Webhooks" },
  { id: "audit", label: "Audit" },
];

export function AdminPage() {
  const [section, setSection] = useState<Section>("overview");
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  return (
    <DashboardLayout
      title="Admin"
      subtitle="Every account, runtime, build and tier in one place."
    >
      <div className="mb-8 flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setSection(s.id);
              setError(null);
            }}
            className={`rounded-lg px-4 py-2 text-sm transition-colors ${
              section === s.id
                ? "bg-white/[0.08] text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-8 rounded-xl border border-rose-400/25 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">
          {error}
        </p>
      )}

      {section === "overview" && <OverviewSection onError={setError} />}
      {section === "users" && <UsersSection onError={setError} />}
      {section === "runtimes" && (
        <RuntimesSection now={now} onError={setError} />
      )}
      {section === "builds" && <BuildsSection onError={setError} />}
      {section === "payments" && <PaymentsSection onError={setError} />}
      {section === "analytics" && <AnalyticsSection onError={setError} />}
      {section === "plans" && <PlansSection onError={setError} />}
      {section === "settings" && <SettingsSection onError={setError} />}
      {section === "environment" && <EnvironmentSection onError={setError} />}
      {section === "database" && (
        <>
          <DbCountsPanel onError={setError} />
          <div className="mt-6">
            <DatabaseSection onError={setError} />
          </div>
        </>
      )}
      {section === "webhooks" && <WebhooksSection onError={setError} />}
      {section === "audit" && <AuditSection onError={setError} />}
    </DashboardLayout>
  );
}

// Downloads an admin CSV export with the dashboard's bearer token. The shared
// api helper only parses JSON, so this does its own fetch and blob handoff.
async function downloadCsv(path: string, filename: string): Promise<void> {
  const token = getAccessToken();
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`Export failed with status ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function OverviewSection({ onError }: { onError: (message: string | null) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api.get<Overview>("/api/v1/admin/overview"));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load the overview");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!overview) return <p className="text-sm text-zinc-500">Loading…</p>;

  // Same 80% threshold the server helper uses. Zero known slots is "unknown"
  // (manager down or no agents), not "low" — no banner then.
  const capacityPct =
    overview.capacity !== null && overview.capacity.total_max > 0
      ? overview.capacity.total_used / overview.capacity.total_max
      : null;
  const capacityLow = capacityPct !== null && capacityPct >= 0.8;
  const capacityCritical = capacityPct !== null && capacityPct >= 0.95;

  return (
    <>
      {capacityLow && overview.capacity && (
        <p
          role="alert"
          className={`mb-6 rounded-xl border px-5 py-4 text-sm ${
            capacityCritical
              ? "border-rose-400/25 bg-rose-500/10 text-rose-200"
              : "border-amber-400/25 bg-amber-500/10 text-amber-200"
          }`}
        >
          {capacityCritical ? "Agent capacity is critical" : "Agent capacity is low"}:{" "}
          {overview.capacity.total_used} of {overview.capacity.total_max}{" "}
          runtime slots in use ({Math.round((capacityPct ?? 0) * 100)}%). New
          starts may queue or fail until agents free up.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Users" value={String(overview.users.total)} />
        <StatTile
          label="Runtimes running"
          value={String(overview.runtimes.running)}
          detail={
            overview.runtimes.paused > 0
              ? `${overview.runtimes.paused} paused`
              : undefined
          }
        />
        <StatTile
          label="Builds today"
          value={String(overview.builds.today)}
          detail={`${overview.builds.succeeded_today} succeeded`}
        />
        <StatTile
          label="Usage this month"
          value={formatDuration(overview.usage_month.runtime_used_seconds)}
          detail={`${overview.usage_month.build_count} builds`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Plans in use">
          {Object.keys(overview.users.by_plan).length === 0 ? (
            <EmptyState>No users yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {Object.entries(overview.users.by_plan).map(([plan, count]) => (
                <li key={plan} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                  <span className="text-sm capitalize text-zinc-300">{plan}</span>
                  <span className="font-mono text-sm text-zinc-400">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Agent capacity">
          {!overview.capacity ? (
            <EmptyState>The manager is unreachable, so capacity is unknown.</EmptyState>
          ) : overview.capacity.agents.length === 0 ? (
            <EmptyState>No agents online.</EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {overview.capacity.agents.map((agent, index) => {
                // Per-agent utilization. An unknown slot count renders as
                // "unknown", never as 0% — 0% would claim headroom that may
                // not exist.
                const used = agent.current_runtimes ?? 0;
                const max = agent.max_runtimes ?? 0;
                const pct = max > 0 ? Math.round((used / max) * 100) : null;
                const hot = pct !== null && pct >= 80;
                return (
                  <li key={agent.agent_id ?? agent.id ?? index} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-4">
                      <span className="truncate font-mono text-xs text-zinc-400">
                        {agent.agent_id ?? agent.id ?? `agent ${index + 1}`}
                      </span>
                      <span className={`shrink-0 text-sm ${hot ? "text-amber-200" : "text-zinc-300"}`}>
                        {used} / {max > 0 ? max : "? slots"}
                        {pct !== null && <span className="ml-2 font-mono text-xs text-zinc-500">{pct}%</span>}
                      </span>
                    </div>
                    {pct !== null && (
                      <div
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`Utilization for ${agent.agent_id ?? agent.id ?? `agent ${index + 1}`}`}
                        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
                      >
                        <div
                          className={`h-full rounded-full ${pct >= 95 ? "bg-rose-400" : pct >= 80 ? "bg-amber-400" : "bg-violet-400"}`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-6">
        <DiagnosticsPanel onError={onError} />
      </div>
    </>
  );
}

interface Diagnostics {
  node_env: string;
  database: string;
  urls: {
    public_base_url: string;
    site_url: string;
    orchestrator_url: string;
  };
  whop: {
    sandbox_key: boolean;
    live_key: boolean;
    webhook_secret: boolean;
    pro_plan: boolean;
    ultra_plan: boolean;
  };
  github: {
    token: boolean;
    repo: string;
    executor: string;
    report_token: boolean;
  };
  orchestrator_reachable: boolean;
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <span className="text-sm text-zinc-300">
        {label}
        {detail && <span className="ml-2 font-mono text-xs text-zinc-500">{detail}</span>}
      </span>
      <span
        className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
          ok ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
        }`}
      >
        {ok ? "set" : "missing"}
      </span>
    </li>
  );
}

/**
 * Configuration self-check: presence booleans only, never secret values. When
 * something works locally but not on a deploy, the cause is an env var here
 * showing "missing" — no Render dashboard spelunking required.
 */
function DiagnosticsPanel({ onError }: { onError: (message: string | null) => void }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const load = useCallback(async () => {
    try {
      setDiagnostics(await api.get<Diagnostics>("/api/v1/admin/diagnostics"));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load diagnostics");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!diagnostics) return null;

  return (
    <Panel
      title="Configuration"
      description={`Running on ${diagnostics.node_env} with ${diagnostics.database}. Orchestrator ${diagnostics.orchestrator_reachable ? "reachable" : "unreachable"}.`}
    >
      <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Addresses in effect
          </p>
          <ul className="divide-y divide-white/[0.06]">
            <li className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
              <span className="text-sm text-zinc-300">Public URL</span>
              <span className="truncate font-mono text-xs text-zinc-400">{diagnostics.urls.public_base_url}</span>
            </li>
            <li className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
              <span className="text-sm text-zinc-300">Site URL</span>
              <span className="truncate font-mono text-xs text-zinc-400">{diagnostics.urls.site_url}</span>
            </li>
            <li className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
              <span className="text-sm text-zinc-300">Orchestrator</span>
              <span className="truncate font-mono text-xs text-zinc-400">{diagnostics.urls.orchestrator_url}</span>
            </li>
            <li className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
              <span className="text-sm text-zinc-300">Build executor</span>
              <span className="font-mono text-xs text-zinc-400">
                {diagnostics.github.executor} · {diagnostics.github.repo}
              </span>
            </li>
          </ul>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Secrets present (values never shown)
          </p>
          <ul className="divide-y divide-white/[0.06]">
            <CheckRow label="Whop sandbox key" ok={diagnostics.whop.sandbox_key} />
            <CheckRow label="Whop live key" ok={diagnostics.whop.live_key} />
            <CheckRow label="Whop webhook secret" ok={diagnostics.whop.webhook_secret} />
            <CheckRow label="Whop Pro plan" ok={diagnostics.whop.pro_plan} />
            <CheckRow label="Whop Ultra plan" ok={diagnostics.whop.ultra_plan} />
            <CheckRow label="GitHub token" ok={diagnostics.github.token} />
            <CheckRow label="Build report token" ok={diagnostics.github.report_token} />
          </ul>
        </div>
      </div>
    </Panel>
  );
}

function UsersSection({ onError }: { onError: (message: string | null) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [confirmRole, setConfirmRole] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");

  const load = useCallback(async (term: string) => {
    try {
      const [u, p] = await Promise.all([
        api.get<{ users: AdminUser[] }>(
          `/api/v1/admin/users${term ? `?q=${encodeURIComponent(term)}` : ""}`
        ),
        api.get<{ plans: Plan[] }>("/api/v1/admin/plans").catch(() => ({ plans: [] })),
      ]);
      setUsers(u.users);
      setPlans(p.plans);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load users");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  const act = async (id: string, action: "disable" | "enable" | "promote" | "demote") => {
    setBusy(`${action}:${id}`);
    try {
      await api.post(`/api/v1/admin/users/${id}/${action}`, {});
      setConfirm(null);
      setConfirmRole(null);
      await load(appliedSearch);
    } catch (err) {
      onError(err instanceof Error ? err.message : `Could not ${action} the account`);
    } finally {
      setBusy(null);
    }
  };

  const changePlan = async (id: string, planId: string) => {
    setBusy(`plan:${id}`);
    try {
      await api.patch(`/api/v1/admin/users/${id}/plan`, { plan_id: planId });
      await load(appliedSearch);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not change the plan");
    } finally {
      setBusy(null);
    }
  };

  const exportUsers = async () => {
    try {
      await downloadCsv("/api/v1/admin/users/export", "users.csv");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not export users");
    }
  };

  return (
    <Panel title="Users">
      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedSearch(search.trim());
          load(search.trim());
        }}
      >
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by email…"
          aria-label="Search users by email"
          className="w-full flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            Search
          </button>
          <button
            type="button"
            onClick={exportUsers}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            Export CSV
          </button>
        </div>
      </form>

      {users.length === 0 ? (
        <EmptyState>
          {appliedSearch ? `No users match "${appliedSearch}".` : "No users yet."}
        </EmptyState>
      ) : (
      <ul className="divide-y divide-white/[0.06]">
        {users.map((user) => {
          const working = busy !== null && busy.endsWith(user.id);
          return (
            <li key={user.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-white">
                  <span className="truncate">{user.email}</span>
                  {/* Role badge: admin stands out, member is quiet context. */}
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
                      user.is_admin
                        ? "bg-violet-500/20 text-violet-200"
                        : "bg-white/[0.06] text-zinc-400"
                    }`}
                  >
                    {user.is_admin ? "admin" : "member"}
                  </span>
                  {/* Standing badge: a disabled account keeps its row but reads
                      as shut off at a glance. */}
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
                      user.is_active
                        ? "bg-emerald-500/15 text-emerald-200"
                        : "bg-rose-500/15 text-rose-200"
                    }`}
                  >
                    {user.is_active ? "active" : "disabled"}
                  </span>
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  {user.plan_id} · joined {new Date(user.created_at).toLocaleDateString()}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={user.plan_id}
                  disabled={working || plans.length === 0}
                  onChange={(event) => changePlan(user.id, event.target.value)}
                  aria-label={`Plan for ${user.email}`}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-2 text-xs text-zinc-200 focus:border-violet-500/60 focus:outline-none [&>option]:bg-zinc-900"
                >
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </select>

                {/* Role changes get the same two-step confirm as disables:
                    promoting the wrong row hands over the whole platform. */}
                {confirmRole === user.id ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => act(user.id, user.is_admin ? "demote" : "promote")}
                      title={user.is_admin ? "Remove admin rights" : "Grant admin rights"}
                      className="rounded-lg bg-violet-500/90 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
                    >
                      Confirm {user.is_admin ? "demote" : "promote"}
                    </button>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => setConfirmRole(null)}
                      className="rounded-lg px-2 py-2 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setConfirmRole(user.id)}
                    title={user.is_admin ? "Remove admin rights" : "Grant admin rights"}
                    className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
                  >
                    {user.is_admin ? "Demote" : "Promote"}
                  </button>
                )}

                {user.is_active ? (
                  confirm === user.id ? (
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => act(user.id, "disable")}
                        className="rounded-lg bg-rose-500/90 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-40"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setConfirm(null)}
                        className="rounded-lg px-2 py-2 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => setConfirm(user.id)}
                      className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                    >
                      Disable
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => act(user.id, "enable")}
                    className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
                  >
                    Enable
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      )}
    </Panel>
  );
}

function RuntimesSection({
  now,
  onError,
}: {
  now: number;
  onError: (message: string | null) => void;
}) {
  const [runtimes, setRuntimes] = useState<AdminRuntime[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ runtimes: AdminRuntime[] }>("/api/v1/admin/runtimes");
      setRuntimes(result.runtimes);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load runtimes");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const stop = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/api/v1/admin/runtimes/${id}/stop`, {});
      setConfirm(null);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not stop the runtime");
    } finally {
      setBusy(null);
    }
  };

  if (runtimes.length === 0) {
    return (
      <Panel title="All runtimes">
        <EmptyState>No runtimes on any account.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel title="All runtimes">
      <ul className="divide-y divide-white/[0.06]">
        {runtimes.map((runtime) => {
          const alive =
            runtime.status === "running" ||
            runtime.status === "starting" ||
            runtime.status === "paused";
          return (
            <li key={runtime.runtime_id} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-zinc-400">
                  {runtime.runtime_id}
                </p>
                <p className="mt-1 truncate text-sm text-zinc-300">
                  {runtime.owner_email ?? runtime.user_id}
                </p>
                {runtime.app_url && (
                  <a
                    href={runtime.app_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block truncate text-sm text-violet-300 transition-colors hover:text-violet-200"
                  >
                    {runtime.app_url}
                  </a>
                )}
                {alive && (
                  <p className="mt-1.5">
                    <LeaseCountdown leaseExpiresAt={runtime.lease_expires_at} now={now} />
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 pt-0.5">
                <StatusDot status={runtime.status} />
                {alive &&
                  (confirm === runtime.runtime_id ? (
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy === runtime.runtime_id}
                        onClick={() => stop(runtime.runtime_id)}
                        className="rounded-lg bg-rose-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-40"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm(null)}
                        className="rounded-lg px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === runtime.runtime_id}
                      onClick={() => setConfirm(runtime.runtime_id)}
                      className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                    >
                      Stop
                    </button>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function BuildsSection({ onError }: { onError: (message: string | null) => void }) {
  const [builds, setBuilds] = useState<AdminBuild[]>([]);
  const [openBuild, setOpenBuild] = useState<AdminBuild | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ builds: AdminBuild[] }>("/api/v1/admin/builds");
      setBuilds(result.builds);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load builds");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (builds.length === 0) {
    return (
      <Panel title="All builds">
        <EmptyState>No builds on any account.</EmptyState>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="All builds">
        <ul className="divide-y divide-white/[0.06]">
          {builds.map((build) => (
            <li key={build.id}>
              <button
                type="button"
                onClick={() => setOpenBuild(build)}
                aria-label={`Open build ${build.id}`}
                className="flex w-full items-center justify-between gap-4 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-zinc-400">{build.id}</p>
                  <p className="mt-1 truncate text-xs text-zinc-600">
                    {build.owner_email ?? build.user_id} ·{" "}
                    {new Date(build.created_at).toLocaleString()}
                    {build.exit_code !== null && build.exit_code !== undefined
                      ? ` · exit ${build.exit_code}`
                      : ""}
                  </p>
                </div>
                <StatusDot status={build.status} />
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      {openBuild && (
        <BuildLogViewer
          buildId={openBuild.id}
          githubRunUrl={openBuild.github_run_url}
          onClose={() => setOpenBuild(null)}
        />
      )}
    </>
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

interface Payments {
  mrr_cents: number;
  at_risk_cents: number;
  by_status: Record<string, number>;
  by_plan: Record<string, number>;
  subscriptions: {
    user_id: string;
    owner_email: string | null;
    plan_id: string;
    plan_name: string;
    promo_code?: string | null;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end?: boolean | number | null;
  }[];
  recent_events: { event_type: string; created_at: string; processed?: boolean | number | null }[];
}

interface SubscriptionDetail {
  subscription: Record<string, unknown>;
  owner: {
    id: string;
    email: string;
    plan_id: string;
    is_admin: boolean;
    is_active: boolean;
    created_at: string;
  } | null;
  recent_events: { event_type: string; created_at: string; processed?: boolean | number | null }[];
  manage_url?: string | null;
}

function PaymentsSection({ onError }: { onError: (message: string | null) => void }) {
  const [payments, setPayments] = useState<Payments | null>(null);
  const [email, setEmail] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachResult, setAttachResult] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);

  const load = useCallback(async () => {
    try {
      setPayments(await api.get<Payments>("/api/v1/admin/payments"));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load payments");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function attach() {
    if (!email.trim() || !membershipId.trim()) {
      onError("Enter the account email and the Whop membership id.");
      return;
    }
    setAttaching(true);
    setAttachResult(null);
    try {
      const result = await api.post<{ plan_id: string; status: string }>(
        "/api/v1/admin/subscriptions/attach",
        { user_email: email.trim(), whop_membership_id: membershipId.trim() }
      );
      setAttachResult(`Attached: ${result.plan_id} (${result.status}).`);
      setEmail("");
      setMembershipId("");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not attach the membership");
    } finally {
      setAttaching(false);
    }
  }

  async function openDetail(userId: string) {
    setSelectedUserId(userId);
    setDetail(null);
    try {
      setDetail(await api.get<SubscriptionDetail>(`/api/v1/admin/subscriptions/${userId}`));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load the subscription");
      setSelectedUserId(null);
    }
  }

  if (!payments) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="MRR" value={money(payments.mrr_cents)} />
        <StatTile
          label="At risk"
          value={money(payments.at_risk_cents)}
          detail="past-due subscriptions"
        />
        <StatTile
          label="Paying plans"
          value={String(
            Object.values(payments.by_plan).reduce((n, v) => n + v, 0)
          )}
          detail={Object.entries(payments.by_plan)
            .map(([plan, count]) => `${plan}: ${count}`)
            .join(" · ")}
        />
        <StatTile
          label="Canceled"
          value={String(payments.by_status.canceled ?? 0)}
          detail="leave at period end"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Subscriptions">
          {payments.subscriptions.length === 0 ? (
            <EmptyState>No subscriptions yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {payments.subscriptions.slice(0, 20).map((sub, index) => (
                <li key={`${sub.user_id}-${index}`}>
                  <button
                    type="button"
                    onClick={() => openDetail(sub.user_id)}
                    aria-label={`Open subscription for ${sub.owner_email ?? sub.user_id}`}
                    className="flex w-full items-center justify-between gap-4 py-3 text-left transition-colors hover:bg-white/[0.03] first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 truncate text-sm text-zinc-200">
                        <span className="truncate">{sub.owner_email ?? sub.user_id}</span>
                        {/* Promo buyers are the first suspect when MRR looks
                            off, so the code rides on the row, not just in the
                            modal. */}
                        {sub.promo_code && (
                          <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[11px] text-emerald-200">
                            {sub.promo_code}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-600">
                        {sub.plan_name}
                        {sub.current_period_end
                          ? ` · renews ${new Date(sub.current_period_end).toLocaleDateString()}`
                          : ""}
                        {sub.cancel_at_period_end ? " · cancels at period end" : ""}
                      </p>
                    </div>
                    <StatusDot status={sub.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent billing events"
          description="What the platform saw. Full transaction history lives in the Whop dashboard."
        >
          {payments.recent_events.length === 0 ? (
            <EmptyState>No billing events recorded.</EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {payments.recent_events.map((event, index) => (
                <li
                  key={`${event.event_type}-${event.created_at}-${index}`}
                  className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="truncate font-mono text-xs text-zinc-400">
                    {event.event_type}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-600">
                    {new Date(event.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-6">
        <Panel
          title="Attach a membership"
          description="Links a Whop membership to an account when the webhook missed it: a direct-link purchase with no metadata, or a half-applied event from before the atomicity fix. Reads the membership live from Whop — nothing is trusted from the input alone."
        >
          {attachResult && (
            <p className="mb-4 text-sm text-emerald-200">{attachResult}</p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Account email
              </span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="customer@example.com"
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
              />
            </label>
            <label className="flex-1">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Whop membership id
              </span>
              <input
                type="text"
                value={membershipId}
                onChange={(event) => setMembershipId(event.target.value)}
                placeholder="mem_… (from the Whop dashboard)"
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
              />
            </label>
            <button
              type="button"
              disabled={attaching}
              onClick={attach}
              className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
            >
              {attaching ? "Working…" : "Attach"}
            </button>
          </div>
        </Panel>
      </div>

      {selectedUserId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Subscription detail"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => {
            setSelectedUserId(null);
            setDetail(null);
          }}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <h3 className="text-base font-medium text-white">Subscription</h3>
              <button
                type="button"
                onClick={() => {
                  setSelectedUserId(null);
                  setDetail(null);
                }}
                className="rounded-lg px-2 py-1 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Close
              </button>
            </div>
            {!detail ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <>
                <p className="truncate text-sm text-zinc-200">
                  {detail.owner?.email ?? selectedUserId}
                </p>
                {/* Promo code gets its own row: "why is this account paying
                    less" is the modal's most common question. */}
                {typeof detail.subscription.promo_code === "string" &&
                  detail.subscription.promo_code && (
                    <p className="mt-2 text-sm">
                      <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 font-mono text-xs text-emerald-200">
                        {detail.subscription.promo_code}
                      </span>{" "}
                      <span className="text-xs text-zinc-500">promo applied</span>
                    </p>
                  )}
                {/* Manage-link affordance: charges live in Whop, so the modal
                    links out instead of pretending to be the ledger. */}
                {detail.manage_url ? (
                  <a
                    href={detail.manage_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block rounded-lg border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-200 transition-colors hover:bg-violet-500/25"
                  >
                    Manage in Whop ↗
                  </a>
                ) : (
                  <p className="mt-3 text-xs text-zinc-600">
                    No live manage link — charges live in the Whop dashboard;
                    find this account by its membership id.
                  </p>
                )}
                <dl className="mt-4 space-y-2">
                  {Object.entries(detail.subscription).map(([key, value]) => (
                    <div key={key} className="flex items-start justify-between gap-4">
                      <dt className="shrink-0 font-mono text-xs text-zinc-500">{key}</dt>
                      <dd className="truncate font-mono text-xs text-zinc-300">
                        {value === null || value === undefined ? "—" : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Recent webhook events
                </p>
                {detail.recent_events.length === 0 ? (
                  <EmptyState>No billing events recorded.</EmptyState>
                ) : (
                  <ul className="divide-y divide-white/[0.06]">
                    {detail.recent_events.map((event, index) => (
                      <li
                        key={`${event.event_type}-${event.created_at}-${index}`}
                        className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"
                      >
                        <span className="truncate font-mono text-xs text-zinc-400">
                          {event.event_type}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-600">
                          {new Date(event.created_at).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface AnalyticsDay {
  date: string;
  signups: number;
  builds_started: number;
  builds_succeeded: number;
  runtime_hours: number;
}

interface Analytics {
  days: number;
  series: AnalyticsDay[];
  totals: {
    signups: number;
    builds_started: number;
    builds_succeeded: number;
    runtime_hours: number;
  };
}

function AnalyticsSection({ onError }: { onError: (message: string | null) => void }) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    try {
      setAnalytics(await api.get<Analytics>(`/api/v1/admin/analytics?days=${days}`));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load analytics");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const exportAnalytics = async () => {
    try {
      await downloadCsv(`/api/v1/admin/analytics/export?days=${days}`, "analytics.csv");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not export analytics");
    }
  };

  if (!analytics) return <p className="text-sm text-zinc-500">Loading…</p>;

  const bars = (
    label: string,
    pick: (day: AnalyticsDay) => number,
    format: (value: number) => string
  ) => {
    const max = Math.max(1, ...analytics.series.map(pick));
    return (
      <Panel title={label}>
        <div className="flex h-40 items-end gap-1">
          {analytics.series.map((day) => {
            const value = pick(day);
            return (
              <div
                key={day.date}
                title={`${day.date}: ${format(value)}`}
                className="min-w-0 flex-1 rounded-t bg-violet-500/50 transition-colors hover:bg-violet-400"
                style={{ height: `${Math.max(3, (value / max) * 100)}%` }}
              />
            );
          })}
        </div>
        <p className="mt-3 text-xs text-zinc-600">
          {analytics.series[0]?.date} → {analytics.series[analytics.series.length - 1]?.date}
        </p>
      </Panel>
    );
  };

  const successRate =
    analytics.totals.builds_started > 0
      ? Math.round(
          (analytics.totals.builds_succeeded / analytics.totals.builds_started) * 100
        )
      : 0;

  // The CSV export hits the same range the charts show: same `days` in the
  // query, same bearer token via downloadCsv, and the server answers
  // text/csv with an attachment disposition so the browser saves the file
  // instead of rendering it.
  const hasData =
    analytics.totals.signups > 0 ||
    analytics.totals.builds_started > 0 ||
    analytics.totals.runtime_hours > 0;

  return (
    <>
      {!hasData && (
        <p className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 text-sm text-zinc-400">
          No activity in the last {analytics.days} days yet — signups, builds
          and runtime hours will appear here once the platform is used.
        </p>
      )}
      <div className="mb-6 flex items-center gap-3">
        <label className="text-xs uppercase tracking-wide text-zinc-500">
          Range
        </label>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 focus:border-violet-500/60 focus:outline-none [&>option]:bg-zinc-900"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
        <button
          type="button"
          onClick={exportAnalytics}
          className="ml-auto rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
        >
          Export CSV
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Signups" value={String(analytics.totals.signups)} />
        <StatTile label="Builds" value={String(analytics.totals.builds_started)} />
        <StatTile
          label="Build success"
          value={`${successRate}%`}
          detail={`${analytics.totals.builds_succeeded} of ${analytics.totals.builds_started}`}
        />
        <StatTile
          label="Runtime hours"
          value={String(analytics.totals.runtime_hours)}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {bars("Signups per day", (day) => day.signups, String)}
        {bars("Builds per day", (day) => day.builds_started, String)}
        {bars("Runtime hours per day", (day) => day.runtime_hours, (v) => `${v}h`)}
        {bars("Builds succeeded per day", (day) => day.builds_succeeded, String)}
      </div>
    </>
  );
}

function PlansSection({ onError }: { onError: (message: string | null) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Partial<Plan>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ plans: Plan[] }>("/api/v1/admin/plans");
      setPlans(result.plans);
      setDrafts({});
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load plans");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (id: string, field: keyof Plan, raw: string) => {
    // Numbers stay numbers: an empty box means "leave it alone", anything else
    // must parse or the save is refused rather than writing NaN. The note is
    // the exception — an empty box clears the tagline on purpose.
    const numeric: (keyof Plan)[] = [
      "runtime_hours_per_month",
      "max_runtime_hours",
      "max_concurrent_runtimes",
      "max_ram_mb",
      "cpu",
      "build_timeout_seconds",
      "price_cents",
      "previous_price_cents",
    ];

    let value: unknown;
    if (field === "note") {
      value = raw.trim() === "" ? null : raw.trim();
    } else if (field === "previous_price_cents") {
      // Empty removes the sale; a value must parse or the save is refused.
      value = raw === "" ? null : Number(raw);
    } else if (numeric.includes(field)) {
      value = raw === "" ? undefined : Number(raw);
    } else {
      value = raw;
    }

    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], [field]: value },
    }));
  };

  const save = async (id: string) => {
    const changes = Object.fromEntries(
      Object.entries(drafts[id] ?? {}).filter(([, v]) => v !== undefined)
    );
    if (Object.keys(changes).length === 0) return;

    if (
      Object.values(changes).some(
        (v) => typeof v === "number" && (Number.isNaN(v) || !Number.isFinite(v))
      )
    ) {
      onError("A plan field is not a number. Fix it before saving.");
      return;
    }

    setBusy(id);
    try {
      await api.patch(`/api/v1/admin/plans/${id}`, changes);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the plan");
    } finally {
      setBusy(null);
    }
  };

  const FIELDS: { key: keyof Plan; label: string; step: string }[] = [
    { key: "runtime_hours_per_month", label: "Hours / month", step: "1" },
    { key: "max_runtime_hours", label: "Max session (h)", step: "0.5" },
    { key: "max_concurrent_runtimes", label: "Concurrent", step: "1" },
    { key: "max_ram_mb", label: "RAM (MB)", step: "1" },
    { key: "cpu", label: "CPU", step: "0.05" },
    { key: "build_timeout_seconds", label: "Build timeout (s)", step: "1" },
    { key: "price_cents", label: "Price (cents)", step: "1" },
  ];

  return (
    <>
      {plans.map((plan) => {
        const draft = drafts[plan.id] ?? {};
        const dirty = Object.keys(draft).some((k) => draft[k as keyof Plan] !== undefined);
        const draftNote = ("note" in draft ? draft.note : plan.note) ?? "";
        const draftPrevious =
          "previous_price_cents" in draft
            ? (draft.previous_price_cents ?? "")
            : (plan.previous_price_cents ?? "");
        return (
          <Panel key={plan.id} title={plan.name} className="mb-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((field) => {
                const pending = draft[field.key];
                return (
                  <label key={field.key} className="block">
                    <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                      {field.label}
                    </span>
                    <input
                      type="number"
                      step={field.step}
                      defaultValue={String(plan[field.key])}
                      onChange={(event) => set(plan.id, field.key, event.target.value)}
                      className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 focus:border-violet-500/60 focus:outline-none"
                    />
                    {pending !== undefined && (
                      <span className="mt-1 block text-xs text-amber-300/90">
                        Unsaved
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-6 border-t border-white/[0.07] pt-5">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Sale pricing
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Display only — checkout still charges the Whop plan price, so a
                real discount needs a discounted Whop plan behind the tier too.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs text-zinc-500">
                    Note, e.g. Temporarily discounted
                  </span>
                  <input
                    type="text"
                    value={draftNote}
                    maxLength={120}
                    placeholder="No sale note"
                    onChange={(event) => set(plan.id, "note", event.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs text-zinc-500">
                    Previous price (cents) — empty ends the sale
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={draftPrevious}
                    placeholder={String(plan.price_cents)}
                    onChange={(event) =>
                      set(plan.id, "previous_price_cents", event.target.value)
                    }
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                  />
                </label>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                disabled={!dirty || busy === plan.id}
                onClick={() => save(plan.id)}
                className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-40"
              >
                {busy === plan.id ? "Saving…" : "Save plan"}
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((current) => ({ ...current, [plan.id]: {} }))
                  }
                  className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Discard
                </button>
              )}
            </div>
          </Panel>
        );
      })}
    </>
  );
}

function SettingsSection({ onError }: { onError: (message: string | null) => void }) {
  const [signups, setSignups] = useState(true);
  const [executor, setExecutor] = useState("auto");
  const [maintenance, setMaintenance] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ settings: Record<string, unknown> }>(
        "/api/v1/admin/settings"
      );
      setSignups(result.settings.signups_enabled !== false);
      setExecutor(
        typeof result.settings.build_executor === "string"
          ? result.settings.build_executor
          : "auto"
      );
      setMaintenance(result.settings.maintenance_mode === true);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load settings");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch("/api/v1/admin/settings", {
        signups_enabled: signups,
        build_executor: executor,
        maintenance_mode: maintenance,
      });
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Platform settings">
      <div className="flex flex-col gap-5">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-white">
              Signups enabled
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              When off, new accounts cannot register. Existing users are unaffected.
            </span>
          </span>
          <input
            type="checkbox"
            checked={signups}
            onChange={(event) => setSignups(event.target.checked)}
            className="h-5 w-5 accent-violet-500"
          />
        </label>

        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-white">
              Maintenance mode
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              When on, new runtimes are refused with a 503. Running apps are unaffected.
            </span>
          </span>
          <input
            type="checkbox"
            checked={maintenance}
            onChange={(event) => setMaintenance(event.target.checked)}
            className="h-5 w-5 accent-amber-500"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Build executor
          </span>
          <select
            value={executor}
            onChange={(event) => setExecutor(event.target.value)}
            className="w-full max-w-xs rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-200 focus:border-violet-500/60 focus:outline-none [&>option]:bg-zinc-900"
          >
            <option value="auto">Automatic</option>
            <option value="github">GitHub Actions</option>
            <option value="runtime">Platform runtime</option>
          </select>
          <span className="mt-1.5 block text-xs text-zinc-600">
            Overrides the automatic choice unless BUILD_EXECUTOR is set in the environment.
          </span>
        </label>

        <div>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

interface AuditEntry {
  id: string;
  admin_id: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

// Privileged mutations leave one row each: plan edits, disable/enable,
// attach, env-override and maintenance changes. When migration 0013 is not
// yet wired the server answers with an empty list and this panel says so
// instead of erroring.
function AuditSection({ onError }: { onError: (message: string | null) => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [pending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ entries: AuditEntry[]; actions?: string[]; pending_migration: boolean }>(
        "/api/v1/admin/audit?limit=200"
      );
      setEntries(result.entries);
      // Fall back to client-derived names when an older server omits them.
      setActions(result.actions ?? [...new Set(result.entries.map((e) => e.action))].sort());
      setLoaded(true);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load the audit log");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!loaded) return <p className="text-sm text-zinc-500">Loading…</p>;

  // Env-override history lives here, not in a separate call: env_set and
  // env_clear rows are the change log for managed config, filtered like any
  // other action. Filtering is client-side for instant switching.
  const visible =
    filter === "all" ? entries : entries.filter((entry) => entry.action === filter);

  return (
    <Panel
      title="Admin audit log"
      description="Who did what to whom. Newest first."
    >
      {pending && (
        <p className="mb-4 rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The audit table is not migrated yet, so recent actions were not
          recorded. Wire migration 0013 to start the log.
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="audit-action-filter" className="text-xs uppercase tracking-wide text-zinc-500">
          Action
        </label>
        <select
          id="audit-action-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 focus:border-violet-500/60 focus:outline-none [&>option]:bg-zinc-900"
        >
          <option value="all">All actions</option>
          {actions.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
        {(filter === "env_set" || filter === "env_clear") && (
          <span className="text-xs text-zinc-500">
            Env-override change history — values are never shown, only that a key changed.
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <EmptyState>
          {pending
            ? "No entries yet — the log starts once migration 0013 is wired."
            : "No admin actions recorded yet. Plan changes, disables, attaches and env edits will appear here."}
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No entries with action “{filter}”. Pick another action.</EmptyState>
      ) : (
        <ul className="divide-y divide-white/[0.06]">
          {visible.map((entry) => (
            <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
              <p className="text-sm text-zinc-200">
                <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-violet-200">
                  {entry.action}
                </span>{" "}
                {entry.target && (
                  <span className="font-mono text-xs text-zinc-400">{entry.target}</span>
                )}
              </p>
              {entry.detail && (
                <p className="mt-1 text-xs text-zinc-500">{entry.detail}</p>
              )}
              <p className="mt-1 text-xs text-zinc-600">
                {new Date(entry.created_at).toLocaleString()} · by{" "}
                <span className="font-mono">{entry.admin_id.slice(0, 8)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// Row counts wired to GET /admin/db/counts. Null renders as "unknown", never
// as zero — a missing migration must not masquerade as an empty table. Shown
// above the browser so a glance answers "is there anything in there".
function DbCountsPanel({ onError }: { onError: (message: string | null) => void }) {
  const [counts, setCounts] = useState<{ table: string; rows: number | null }[] | null>(null);

  useEffect(() => {
    api
      .get<{ tables: { table: string; rows: number | null }[] }>("/api/v1/admin/db/counts")
      .then((result) => {
        setCounts(result.tables);
        onError(null);
      })
      .catch((err: unknown) => {
        onError(err instanceof Error ? err.message : "Could not load table counts");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!counts) return <p className="text-sm text-zinc-500">Loading table counts…</p>;

  return (
    <Panel title="Table sizes" description="Live row counts. Unknown means the table could not be read.">
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {counts.map((row) => (
          <li
            key={row.table}
            className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2"
          >
            <span className="truncate font-mono text-xs text-zinc-400">{row.table}</span>
            <span className={`shrink-0 font-mono text-xs ${row.rows === null ? "text-amber-300" : "text-zinc-200"}`}>
              {row.rows === null ? "unknown" : row.rows.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

interface WebhookEvent {
  id: string;
  provider: string;
  event_type: string;
  processed: boolean | number | null;
  created_at: string;
}

// Inbound webhook log with type and processed filters. Payloads stay out by
// design; unprocessed rows are the ones that need attention (a stuck row
// means the platform saw money move and did nothing about it).
function WebhooksSection({ onError }: { onError: (message: string | null) => void }) {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [processedFilter, setProcessedFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (typeFilter.trim()) params.set("type", typeFilter.trim());
      if (processedFilter !== "all") params.set("processed", processedFilter);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const result = await api.get<{ events: WebhookEvent[]; event_types?: string[]; pending_migration: boolean }>(
        `/api/v1/admin/webhooks${suffix}`
      );
      setEvents(result.events);
      setEventTypes(result.event_types ?? []);
      setPending(result.pending_migration);
      setLoaded(true);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load webhook events");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, processedFilter]);

  useEffect(() => {
    const timer = window.setTimeout(load, typeFilter ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [load, typeFilter]);

  useEffect(() => {
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!loaded) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <>
      <Panel
        title="Webhook events"
        description="What arrived and whether it was acted on. Newest first."
      >
        {pending && (
          <p className="mb-4 rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            The webhook table could not be read, so this list may be incomplete.
          </p>
        )}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            placeholder="Filter by event type…"
            aria-label="Filter webhook events by type"
            list="webhook-event-types"
            className="w-full flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
          />
          <datalist id="webhook-event-types">
            {eventTypes.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
          <select
            value={processedFilter}
            onChange={(event) => setProcessedFilter(event.target.value)}
            aria-label="Filter by processed state"
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 focus:border-violet-500/60 focus:outline-none [&>option]:bg-zinc-900"
          >
            <option value="all">All states</option>
            <option value="true">Processed</option>
            <option value="false">Unprocessed</option>
          </select>
        </div>
        {events.length === 0 ? (
          <EmptyState>
            {typeFilter || processedFilter !== "all"
              ? "No events match these filters."
              : "No webhook events recorded yet."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {events.map((event) => {
              const done = event.processed === true || event.processed === 1;
              return (
                <li key={event.id} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-zinc-300">{event.event_type}</p>
                    <p className="mt-0.5 text-xs text-zinc-600">
                      {event.provider} · {new Date(event.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
                      done ? "bg-emerald-500/15 text-emerald-200" : "bg-amber-500/15 text-amber-200"
                    }`}
                  >
                    {done ? "processed" : "unprocessed"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <div className="mt-6">
        <Panel title="Replaying an event">
          <p className="text-sm text-zinc-400">
            Resend from the Whop dashboard webhook simulator — the platform
            dedupes by idempotency key, so a resend with the same key is safe
            and will not double-apply. Unprocessed rows usually mean the event
            arrived in an unknown shape; check the server logs for the
            validation error before replaying.
          </p>
        </Panel>
      </div>
    </>
  );
}
