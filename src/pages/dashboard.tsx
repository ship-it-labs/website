import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  DashboardLayout,
  Panel,
  StatTile,
  StatusDot,
  EmptyState,
} from "@/components/site/DashboardLayout";
import { BuildLogViewer } from "@/components/site/BuildLogViewer";
import { RuntimeDetail } from "@/components/site/RuntimeDetail";
import {
  LeaseCountdown,
  useNow,
} from "@/components/site/LeaseCountdown";

interface Usage {
  monthly_runtime_limit_seconds: number;
  runtime_used_seconds: number;
  // The part of the total being spent by a runtime that is up right now.
  runtime_live_seconds?: number;
  runtime_remaining_seconds: number;
  max_session_seconds: number;
  plan: {
    id: string;
    name: string;
    runtime_hours_per_month: number;
    max_runtime_hours: number;
    max_ram_mb: number;
    cpu: number;
  };
}

interface Runtime {
  id: string;
  status: string;
  app_url?: string;
  lease_expires_at: string;
  project_id: string;
  // Resolved server-side from the projects table; null for deleted projects.
  project_name?: string | null;
  started_at?: string | null;
}

interface Build {
  id: string;
  status: string;
  exit_code: number | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  // Which executor ran the build ("github" | "runtime"); null for old builds.
  executor?: string | null;
  github_run_url: string | null;
}

// Copies text, falling back to a hidden textarea when the async clipboard API
// is unavailable (non-secure contexts). NOTE (Batch 4): consolidate the three
// copies of this helper (dashboard, RuntimeDetail, BuildLogViewer) into one
// useCopy hook.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

// Seconds between start and finish, or start and now while still running.
// Null when the build never started, so the row hides the duration.
function buildDurationSeconds(
  build: Build,
  now: number
): number | null {
  if (!build.started_at) return null;
  const start = new Date(build.started_at).getTime();
  if (Number.isNaN(start)) return null;
  const end = build.completed_at
    ? new Date(build.completed_at).getTime()
    : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

const TERMINAL_BUILD = new Set(["success", "failure", "timeout"]);
const BUILD_FILTERS = ["all", "pending", "running", "success", "failure", "timeout"] as const;

export function DashboardPage() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openBuild, setOpenBuild] = useState<Build | null>(null);
  const [openRuntime, setOpenRuntime] = useState<string | null>(null);
  const [runtimeFilter, setRuntimeFilter] = useState("");
  const [buildFilter, setBuildFilter] = useState<string>("all");
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [busyBuild, setBusyBuild] = useState<string | null>(null);
  const [confirmDeleteBuild, setConfirmDeleteBuild] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const now = useNow();

  const welcome = new URLSearchParams(window.location.search).has("welcome");

  const load = useCallback(async () => {
    try {
      const [u, r, b] = await Promise.all([
        api.get<Usage>("/api/v1/usage"),
        api.get<{ runtimes: Runtime[] }>("/api/v1/runtimes"),
        api.get<{ builds: Build[] }>("/api/v1/builds"),
      ]);
      setUsage(u);
      setRuntimes(r.runtimes);
      setBuilds(b.builds);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the dashboard");
    }
  }, []);

  // Polls while the tab is visible; hidden tabs skip the fetch and reload on
  // return. Active builds poll fast (5s) so output arrives promptly, settled
  // ones slow down (15s) to spare the control plane.
  const hasActiveBuilds = builds.some((b) => !TERMINAL_BUILD.has(b.status));
  const pollMs = hasActiveBuilds ? 5_000 : 15_000;

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let timer: number | undefined;
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const tick = () => {
      if (!document.hidden) void load();
      timer = window.setTimeout(tick, pollMs);
    };
    timer = window.setTimeout(tick, pollMs);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, pollMs]);

  // The dashboard reloads on a timer, which makes a running total lurch. The
  // agent already bills every second, so advance the displayed number locally
  // between reloads and drop the local offset whenever fresh data lands.
  const liveSeconds = usage?.runtime_live_seconds ?? 0;
  const [tickOffset, setTickOffset] = useState(0);

  useEffect(() => {
    setTickOffset(0);
  }, [usage?.runtime_used_seconds]);

  useEffect(() => {
    if (liveSeconds <= 0) return;
    const timer = setInterval(
      () => setTickOffset((current) => current + 1),
      1000
    );
    return () => clearInterval(timer);
  }, [liveSeconds]);

  const shownUsedSeconds =
    (usage?.runtime_used_seconds ?? 0) + tickOffset;

  // The next runtime to be stopped by its session timeout, so the deadline is
  // visible without hunting through the runtime list.
  const soonestStop = runtimes
    .filter((r) => r.status === "running" || r.status === "starting")
    .map((r) => new Date(r.lease_expires_at).getTime())
    .filter((t) => !Number.isNaN(t) && t > now)
    .sort((a, b) => a - b)[0];

  const active = runtimes.filter(
    (r) => r.status === "running" || r.status === "starting"
  );

  const needle = runtimeFilter.trim().toLowerCase();
  const visibleRuntimes = needle
    ? runtimes.filter((r) =>
        [r.id, r.status, r.project_id, r.project_name ?? "", r.app_url ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : runtimes;

  const visibleBuilds =
    buildFilter === "all" ? builds : builds.filter((b) => b.status === buildFilter);

  const flashCopied = (key: string) => {
    setCopied(key);
    window.setTimeout(() => {
      setCopied((current) => (current === key ? null : current));
    }, 1500);
  };

  const copyUrl = async (url: string) => {
    if (await copyText(url)) flashCopied(`url:${url}`);
  };

  const copyBuildId = async (id: string) => {
    if (await copyText(id)) flashCopied(`build:${id}`);
  };

  const stopAll = async () => {
    setStoppingAll(true);
    try {
      await api.post("/api/v1/runtimes/stop-all", {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop all runtimes");
    } finally {
      setStoppingAll(false);
      setConfirmStopAll(false);
    }
  };

  const rebuild = async (id: string) => {
    setBusyBuild(id);
    try {
      await api.post(`/api/v1/builds/${id}/rebuild`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rebuild");
    } finally {
      setBusyBuild(null);
    }
  };

  const deleteBuild = async (id: string) => {
    setBusyBuild(id);
    try {
      await api.del(`/api/v1/builds/${id}`);
      if (openBuild?.id === id) setOpenBuild(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the build");
    } finally {
      setBusyBuild(null);
      setConfirmDeleteBuild(null);
    }
  };

  return (
    <DashboardLayout
      title={welcome ? "Welcome aboard" : "Overview"}
      subtitle={
        welcome
          ? "Your account is ready. Create an API key, then let the agent build and run something."
          : "Runtime usage, active sessions and recent builds."
      }
    >
      {error && (
        <p className="mb-8 rounded-xl border border-rose-400/25 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Plan"
          value={usage?.plan.name ?? "—"}
          detail={
            usage
              ? `${usage.plan.max_runtime_hours}h sessions · ${usage.plan.max_ram_mb}MB · ${usage.plan.cpu} CPU`
              : undefined
          }
        />
        <StatTile
          label="Used this month"
          value={usage ? formatDuration(shownUsedSeconds) : "—"}
          detail={
            usage
              ? // Say how much of it is still ticking, so a total that moves
                // every few seconds is not mistaken for a bug.
                liveSeconds > 0
                   ? `of ${formatDuration(usage.monthly_runtime_limit_seconds)} · ${formatDuration(
                       liveSeconds
                     )} running now`
                   : `of ${formatDuration(usage.monthly_runtime_limit_seconds)}`
              : undefined
          }
        />
        <StatTile
          label="Remaining"
          value={usage ? formatDuration(usage.runtime_remaining_seconds) : "—"}
          detail={
            usage
              ? `longest session ${formatDuration(usage.max_session_seconds)}`
              : undefined
          }
        />
        <StatTile
          label="Active runtimes"
          value={String(active.length)}
          detail={
            soonestStop
              ? `next session stops ${new Date(soonestStop).toLocaleTimeString()}`
              : active.length > 0
                ? "no session deadline reported"
                : undefined
          }
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Runtimes" description="Select a runtime to see its specs and controls.">
          {runtimes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 px-5 py-8 text-center">
              <p className="text-sm text-zinc-300">No runtimes yet.</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">
                Ask the agent to build and run a project, or start one from an
                uploaded project. New sessions appear here automatically.
              </p>
              <div className="mt-4 flex items-center justify-center gap-3">
                <a
                  href="/docs"
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
                >
                  Read the docs
                </a>
                <button
                  type="button"
                  onClick={() => load()}
                  className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/[0.11]"
                >
                  Refresh
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input
                  type="search"
                  value={runtimeFilter}
                  onChange={(event) => setRuntimeFilter(event.target.value)}
                  placeholder="Filter by project or status"
                  aria-label="Filter runtimes"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                />
                {active.length > 0 &&
                  (confirmStopAll ? (
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={stoppingAll}
                        onClick={stopAll}
                        className="rounded-lg bg-rose-500/90 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
                      >
                        {stoppingAll ? "Stopping..." : "Confirm stop all"}
                      </button>
                      <button
                        type="button"
                        disabled={stoppingAll}
                        onClick={() => setConfirmStopAll(false)}
                        className="rounded-lg px-2 py-2 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmStopAll(true)}
                      className="rounded-lg border border-rose-400/30 px-3 py-2 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/10"
                    >
                      Stop all
                    </button>
                  ))}
              </div>
              {visibleRuntimes.length === 0 ? (
                <EmptyState>No runtimes match this filter.</EmptyState>
              ) : (
                <ul className="divide-y divide-white/[0.06]">
                  {visibleRuntimes.slice(0, 8).map((runtime) => (
                    <li key={runtime.id} className="flex items-start gap-2 py-3.5 first:pt-0 last:pb-0">
                      <button
                        type="button"
                        onClick={() => setOpenRuntime(runtime.id)}
                        aria-label={`Open runtime ${runtime.id}`}
                        className="flex min-w-0 flex-1 items-start justify-between gap-4 text-left transition-colors hover:bg-white/[0.03]"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm text-zinc-200">
                            {runtime.project_name ?? runtime.project_id}
                          </p>
                          <p className="truncate font-mono text-xs text-zinc-500">
                            {runtime.id}
                          </p>
                          {runtime.app_url ? (
                            <span className="mt-1 block truncate text-sm text-violet-300">
                              {runtime.app_url}
                            </span>
                          ) : (
                            <p className="mt-1 text-sm text-zinc-600">No public URL</p>
                          )}
                          {runtime.status === "running" ||
                          runtime.status === "starting" ||
                          runtime.status === "paused" ? (
                            <p className="mt-1.5">
                              <LeaseCountdown
                                leaseExpiresAt={runtime.lease_expires_at}
                                now={now}
                              />
                            </p>
                          ) : null}
                        </div>
                        <span className="flex shrink-0 items-center gap-3 pt-0.5">
                          <StatusDot status={runtime.status} />
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            className="h-4 w-4 text-zinc-600"
                            aria-hidden="true"
                          >
                            <path
                              d="M9 6l6 6-6 6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      </button>
                      {runtime.app_url && (
                        <button
                          type="button"
                          onClick={() => copyUrl(runtime.app_url!)}
                          title="Copy public URL"
                          aria-label={`Copy URL for runtime ${runtime.id}`}
                          className="shrink-0 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/[0.09] hover:text-zinc-200"
                        >
                          {copied === `url:${runtime.app_url}` ? "Copied" : "Copy URL"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>

        <Panel title="Recent builds" description="Select a build to read its output.">
          <div className="mb-3 flex items-center gap-2">
            <label htmlFor="build-status-filter" className="text-xs text-zinc-500">
              Status
            </label>
            <select
              id="build-status-filter"
              value={buildFilter}
              onChange={(event) => setBuildFilter(event.target.value)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-violet-500/60 focus:outline-none"
            >
              {BUILD_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? "All" : status}
                </option>
              ))}
            </select>
          </div>
          {builds.length === 0 ? (
            <EmptyState>No builds yet.</EmptyState>
          ) : visibleBuilds.length === 0 ? (
            <EmptyState>No builds with this status.</EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {visibleBuilds.slice(0, 8).map((build) => {
                const duration = buildDurationSeconds(build, now);
                const isActive = !TERMINAL_BUILD.has(build.status);
                return (
                  <li key={build.id} className="flex items-center gap-2 py-3.5 first:pt-0 last:pb-0">
                    <button
                      type="button"
                      onClick={() => setOpenBuild(build)}
                      aria-label={`Open build ${build.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4 text-left transition-colors hover:bg-white/[0.03]"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-zinc-400">
                          {build.id}
                        </p>
                        <p className="mt-1 text-xs text-zinc-600">
                          {new Date(build.created_at).toLocaleString()}
                          {build.exit_code !== null && build.exit_code !== undefined && ` · exit ${build.exit_code}`}
                          {duration !== null && ` · ${formatDuration(duration)}${isActive ? " so far" : ""}`}
                          {build.executor && ` · ${build.executor}`}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-3">
                        <StatusDot status={build.status} />
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          className="h-4 w-4 text-zinc-600"
                          aria-hidden="true"
                        >
                          <path
                            d="M9 6l6 6-6 6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </button>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => copyBuildId(build.id)}
                        title="Copy build id"
                        aria-label={`Copy build id ${build.id}`}
                        className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/[0.09] hover:text-zinc-200"
                      >
                        {copied === `build:${build.id}` ? "Copied" : "Copy id"}
                      </button>
                      <button
                        type="button"
                        disabled={busyBuild === build.id}
                        onClick={() => rebuild(build.id)}
                        title="Re-run with the same commands"
                        aria-label={`Rebuild ${build.id}`}
                        className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/[0.09] hover:text-zinc-200 disabled:opacity-50"
                      >
                        {busyBuild === build.id ? "..." : "Rebuild"}
                      </button>
                      {confirmDeleteBuild === build.id ? (
                        <>
                          <button
                            type="button"
                            disabled={busyBuild === build.id}
                            onClick={() => deleteBuild(build.id)}
                            aria-label={`Confirm delete build ${build.id}`}
                            className="rounded-lg bg-rose-500/90 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteBuild(null)}
                            aria-label="Cancel delete"
                            className="rounded-lg px-1.5 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteBuild(build.id)}
                          title="Delete this build and its logs"
                          aria-label={`Delete build ${build.id}`}
                          className="rounded-lg border border-rose-400/30 px-2 py-1.5 text-xs text-rose-200 transition-colors hover:bg-rose-500/10"
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {openBuild && (
        <BuildLogViewer
          buildId={openBuild.id}
          githubRunUrl={openBuild.github_run_url}
          onClose={() => setOpenBuild(null)}
        />
      )}

      {openRuntime && (
        <RuntimeDetail
          runtimeId={openRuntime}
          now={now}
          plan={usage?.plan}
          onClose={() => setOpenRuntime(null)}
          onChanged={load}
        />
      )}

      {user && (
        <p className="mt-10 text-xs text-zinc-600">
          Signed in as {user.email}
        </p>
      )}
    </DashboardLayout>
  );
}
