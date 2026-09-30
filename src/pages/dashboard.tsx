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

interface Usage {
  monthly_runtime_limit_seconds: number;
  runtime_used_seconds: number;
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
}

interface Build {
  id: string;
  status: string;
  exit_code: number | null;
  created_at: string;
}

export function DashboardPage() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const active = runtimes.filter(
    (r) => r.status === "running" || r.status === "starting"
  );

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
          value={usage ? formatDuration(usage.runtime_used_seconds) : "—"}
          detail={
            usage ? `of ${formatDuration(usage.monthly_runtime_limit_seconds)}` : undefined
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
        <StatTile label="Active runtimes" value={String(active.length)} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel title="Runtimes" description="Started and stopped by the agent.">
          {runtimes.length === 0 ? (
            <EmptyState>
              No runtimes yet. Ask the agent to build and run a project.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {runtimes.slice(0, 8).map((runtime) => (
                <li key={runtime.id} className="py-3.5 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-zinc-400">
                        {runtime.id}
                      </p>
                      {runtime.app_url ? (
                        <a
                          href={runtime.app_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate text-sm text-violet-300 transition-colors hover:text-violet-200"
                        >
                          {runtime.app_url}
                        </a>
                      ) : (
                        <p className="mt-1 text-sm text-zinc-600">No public URL</p>
                      )}
                    </div>
                    <StatusDot status={runtime.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent builds" description="Executed in GitHub Actions.">
          {builds.length === 0 ? (
            <EmptyState>No builds yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {builds.slice(0, 8).map((build) => (
                <li
                  key={build.id}
                  className="flex items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-zinc-400">{build.id}</p>
                    <p className="mt-1 text-xs text-zinc-600">
                      {new Date(build.created_at).toLocaleString()}
                    </p>
                  </div>
                  <StatusDot status={build.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {user && (
        <p className="mt-10 text-xs text-zinc-600">
          Signed in as {user.email}
        </p>
      )}
    </DashboardLayout>
  );
}
