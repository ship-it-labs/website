import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
    build_timeout_seconds: number;
  };
}

interface Runtime {
  id: string;
  status: string;
  app_url?: string;
  lease_expires_at: string;
  project_id: string;
  started_at?: string;
  created_at: string;
}

interface Build {
  id: string;
  status: string;
  exit_code: number | null;
  created_at: string;
  project_id: string;
}

export function DashboardPage() {
  const { email, userId } = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const activeRuntimes = runtimes.filter((r) => r.status === "running" || r.status === "starting");

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{email}</p>
        </div>
        <Button variant="outline" onClick={load}>
          Refresh
        </Button>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Plan"
          value={usage?.plan.name ?? "-"}
          detail={
            usage
              ? `${usage.plan.runtime_hours_per_month}h/month, max ${usage.plan.max_runtime_hours}h session, ${usage.plan.max_ram_mb}MB, ${usage.plan.cpu} CPU`
              : ""
          }
        />
        <StatCard
          title="Runtime used"
          value={usage ? formatDuration(usage.runtime_used_seconds) : "-"}
          detail={usage ? `of ${formatDuration(usage.monthly_runtime_limit_seconds)}` : ""}
        />
        <StatCard
          title="Runtime remaining"
          value={usage ? formatDuration(usage.runtime_remaining_seconds) : "-"}
          detail={usage ? `max session ${formatDuration(usage.max_session_seconds)}` : ""}
        />
        <StatCard
          title="Active runtimes"
          value={String(activeRuntimes.length)}
          detail={userId ? `user ${userId.slice(0, 8)}` : ""}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Runtimes</CardTitle>
          <CardDescription>Start and stop are performed by the AI through the plugin</CardDescription>
        </CardHeader>
        <CardContent>
          {runtimes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runtimes yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2">Runtime</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">URL</th>
                  <th className="py-2">Lease expires</th>
                </tr>
              </thead>
              <tbody>
                {runtimes.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 font-mono">{r.id}</td>
                    <td className="py-2">{r.status}</td>
                    <td className="py-2">
                      {r.app_url ? (
                        <a className="text-primary underline" href={r.app_url} target="_blank" rel="noreferrer">
                          {r.app_url}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="py-2">{new Date(r.lease_expires_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent builds</CardTitle>
        </CardHeader>
        <CardContent>
          {builds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No builds yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2">Build</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Exit</th>
                  <th className="py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {builds.slice(0, 10).map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="py-2 font-mono">{b.id}</td>
                    <td className="py-2">{b.status}</td>
                    <td className="py-2">{b.exit_code ?? "-"}</td>
                    <td className="py-2">{new Date(b.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
        {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}
