import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import {
  DashboardLayout,
  Panel,
  StatTile,
  StatusDot,
  EmptyState,
} from "@/components/site/DashboardLayout";
import { BuildLogViewer } from "@/components/site/BuildLogViewer";
import { LeaseCountdown, useNow } from "@/components/site/LeaseCountdown";

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

type Section = "overview" | "users" | "runtimes" | "builds" | "payments" | "analytics" | "plans" | "settings";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "runtimes", label: "Runtimes" },
  { id: "builds", label: "Builds" },
  { id: "payments", label: "Payments" },
  { id: "analytics", label: "Analytics" },
  { id: "plans", label: "Plans" },
  { id: "settings", label: "Settings" },
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
    </DashboardLayout>
  );
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

  return (
    <>
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
              {overview.capacity.agents.map((agent, index) => (
                <li key={agent.agent_id ?? agent.id ?? index} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                  <span className="font-mono text-xs text-zinc-400">
                    {agent.agent_id ?? agent.id ?? `agent ${index + 1}`}
                  </span>
                  <span className="text-sm text-zinc-300">
                    {agent.current_runtimes ?? 0} / {agent.max_runtimes ?? "?"}
                  </span>
                </li>
              ))}
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

  const load = useCallback(async () => {
    try {
      const [u, p] = await Promise.all([
        api.get<{ users: AdminUser[] }>("/api/v1/admin/users"),
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
    load();
  }, [load]);

  const act = async (id: string, action: "disable" | "enable" | "promote" | "demote") => {
    setBusy(`${action}:${id}`);
    try {
      await api.post(`/api/v1/admin/users/${id}/${action}`, {});
      setConfirm(null);
      await load();
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
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not change the plan");
    } finally {
      setBusy(null);
    }
  };

  if (users.length === 0) {
    return (
      <Panel title="Users">
        <EmptyState>No users yet.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel title="Users">
      <ul className="divide-y divide-white/[0.06]">
        {users.map((user) => {
          const working = busy !== null && busy.endsWith(user.id);
          return (
            <li key={user.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">
                  {user.email}{" "}
                  {user.is_admin && (
                    <span className="ml-1 rounded-md bg-violet-500/20 px-1.5 py-0.5 text-[11px] text-violet-200">
                      admin
                    </span>
                  )}
                  {!user.is_active && (
                    <span className="ml-1 text-zinc-500">(disabled)</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  joined {new Date(user.created_at).toLocaleDateString()}
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

                <button
                  type="button"
                  disabled={working}
                  onClick={() => act(user.id, user.is_admin ? "demote" : "promote")}
                  title={user.is_admin ? "Remove admin rights" : "Grant admin rights"}
                  className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
                >
                  {user.is_admin ? "Demote" : "Promote"}
                </button>

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
    status: string;
    current_period_end: string | null;
    cancel_at_period_end?: boolean | number | null;
  }[];
  recent_events: { event_type: string; created_at: string; processed?: boolean | number | null }[];
}

function PaymentsSection({ onError }: { onError: (message: string | null) => void }) {
  const [payments, setPayments] = useState<Payments | null>(null);
  const [email, setEmail] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachResult, setAttachResult] = useState<string | null>(null);

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
                <li
                  key={`${sub.user_id}-${index}`}
                  className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-200">
                      {sub.owner_email ?? sub.user_id}
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

  return (
    <>
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
