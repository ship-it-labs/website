import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/time";
import { usePageTitle } from "@/lib/page-title";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { Skeleton } from "@/components/site/Skeleton";

function StatePill({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
        ok
          ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
          : "border-rose-400/30 bg-rose-500/10 text-rose-200"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-rose-400"}`} />
      {ok ? "Operational" : "Outage"}
    </span>
  );
}

interface PlatformStatus {
  site: string;
  orchestrator: string;
  time: string;
}

function ServiceRow({
  name,
  detail,
  ok,
}: {
  name: string;
  detail: string;
  ok: boolean | null;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-white">{name}</p>
        <p className="mt-0.5 text-sm text-zinc-500">{detail}</p>
      </div>
      {ok === null ? (
        <Skeleton className="h-6 w-24 shrink-0" />
      ) : (
        <StatePill ok={ok} />
      )}
    </li>
  );
}

export function StatusPage() {
  usePageTitle("Status");
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<PlatformStatus>("/api/v1/status"));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // A dedicated pill rather than StatusDot: runtime states ("running" /
  // "expired") would read wrong next to services.
  const siteOk = !error && status?.site === "ok";
  const orchOk = !error && status?.orchestrator === "ok";

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />
      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Status
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-zinc-400">
            Live, checked every 30 seconds. If this page itself fails to load,
            the answer is "all down" — no check needed.
          </p>

          <div className="glass mt-10 rounded-2xl p-6">
            <ul className="divide-y divide-white/[0.06]">
              <ServiceRow
                name="Website and API"
                detail="Pages, login, billing, builds history"
                ok={error ? false : status ? siteOk : null}
              />
              <ServiceRow
                name="Runtime orchestrator"
                detail="Starts, stops, usage billing and session timeouts"
                ok={error ? false : status ? orchOk : null}
              />
            </ul>
            {status && !error && (
              // Relative age at a glance, absolute timestamp on hover — the
              // same pattern as the dashboard's "last used" labels.
              <p
                className="mt-4 text-xs text-zinc-600"
                title={new Date(status.time).toLocaleString()}
              >
                Checked {timeAgo(status.time)}
              </p>
            )}
            {error && (
              <p className="mt-4 text-sm text-rose-300">
                The status check itself failed, which means the API is
                unreachable from here. Check back shortly.
              </p>
            )}
          </div>

          <p className="mt-8 text-sm text-zinc-500">
            Past incidents are listed in the{" "}
            <span className="text-zinc-300">Changelog</span> when they change
            something about the platform. For anything affecting only your
            account, contact support instead of watching this page.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
