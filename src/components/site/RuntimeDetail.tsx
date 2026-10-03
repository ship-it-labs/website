import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import { Modal } from "@/components/site/Modal";
import { LeaseCountdown } from "@/components/site/LeaseCountdown";
import { StatusDot } from "@/components/site/DashboardLayout";

interface RuntimeDetail {
  runtime_id: string;
  status: string;
  app_url?: string;
  lease_expires_at: string;
  max_session_seconds: number;
  started_at: string;
  project_id?: string;
  agent_id?: string;
}

interface Metrics {
  cpu_percent?: number;
  memory_mb?: number;
  disk_mb?: number;
}

interface Info {
  runtime_id: string;
  agent_id: string;
  app_url: string;
  metrics?: Metrics;
  ports?: string[];
}

type Action = "pause" | "resume" | "restart" | "stop";

const ACTION_LABEL: Record<Action, string> = {
  pause: "Pause",
  resume: "Resume",
  restart: "Restart",
  stop: "Delete",
};

export function RuntimeDetail({
  runtimeId,
  now,
  plan,
  onClose,
  onChanged,
}: {
  runtimeId: string;
  now: number;
  plan?: { max_ram_mb: number; cpu: number };
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RuntimeDetail | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const load = useCallback(async () => {
    try {
      // Both requests matter: status decides which buttons make sense, and info
      // carries the numbers worth showing.
      const [status, details] = await Promise.all([
        api.get<{ runtime: RuntimeDetail }>(`/api/v1/runtimes/${runtimeId}`),
        api
          .post<Info>(`/api/v1/runtimes/${runtimeId}/info`, {})
          .catch(() => null),
      ]);

      setDetail(status.runtime ?? null);
      setInfo(details);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the runtime");
    }
  }, [runtimeId]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (action: Action) => {
    setBusy(action);
    setError(null);
    try {
      await api.post(`/api/v1/runtimes/${runtimeId}/${action}`, {});
      // A stopped runtime is gone, so there is nothing left to show.
      if (action === "stop") {
        onChanged();
        onClose();
        return;
      }
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} the runtime`);
    } finally {
      setBusy(null);
      setConfirmStop(false);
    }
  };

  const status = detail?.status ?? "unknown";
  const alive = status === "running" || status === "starting" || status === "paused";
  const paused = status === "paused";
  const metrics = info?.metrics;

  return (
    <Modal title={runtimeId} description="Runtime details" onClose={onClose}>
      {error && (
        <p className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </p>
      )}

      {!detail ? (
        <p className="text-sm text-zinc-500">Loading...</p>
      ) : (
        <>
          <div className="mb-6 flex items-center gap-3">
            <StatusDot status={status} />
            <span className="text-sm capitalize text-zinc-300">{status}</span>
            {alive && (
              <span className="ml-auto">
                <LeaseCountdown leaseExpiresAt={detail.lease_expires_at} now={now} />
              </span>
            )}
          </div>

          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Spec label="Public URL">
              {detail.app_url ? (
                <a
                  href={detail.app_url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-violet-300 transition-colors hover:text-violet-200"
                >
                  {detail.app_url}
                </a>
              ) : (
                <span className="text-zinc-500">Not published</span>
              )}
            </Spec>
            <Spec label="Agent">{detail.agent_id ?? info?.agent_id ?? "—"}</Spec>
            <Spec label="Memory limit">
              {plan ? `${plan.max_ram_mb}MB` : "—"}
            </Spec>
            <Spec label="CPU limit">{plan ? `${plan.cpu} CPU` : "—"}</Spec>
            <Spec label="Started">
              {new Date(detail.started_at).toLocaleString()}
            </Spec>
            <Spec label="Session limit">
              {formatDuration(detail.max_session_seconds)}
            </Spec>
            {metrics?.memory_mb !== undefined && (
              <Spec label="Memory in use">{metrics.memory_mb}MB</Spec>
            )}
            {metrics?.cpu_percent !== undefined && (
              <Spec label="CPU in use">{metrics.cpu_percent}%</Spec>
            )}
            {info?.ports && info.ports.length > 0 && (
              <Spec label="Published ports">
                <span className="font-mono text-xs">{info.ports.join(", ")}</span>
              </Spec>
            )}
          </dl>

          <div className="mt-8 flex flex-wrap gap-3 border-t border-white/[0.07] pt-6">
            {alive && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act(paused ? "resume" : "pause")}
                className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/[0.11] disabled:opacity-50"
              >
                {busy === "pause" || busy === "resume"
                  ? "Working..."
                  : paused
                    ? ACTION_LABEL.resume
                    : ACTION_LABEL.pause}
              </button>
            )}

            {alive && (
              <button
                type="button"
                disabled={busy !== null || paused}
                title={paused ? "Resume the runtime before restarting it" : undefined}
                onClick={() => act("restart")}
                className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/[0.11] disabled:opacity-50"
              >
                {busy === "restart" ? "Restarting..." : ACTION_LABEL.restart}
              </button>
            )}

            {alive &&
              (confirmStop ? (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act("stop")}
                    className="rounded-lg bg-rose-500/90 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
                  >
                    {busy === "stop" ? "Deleting..." : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setConfirmStop(false)}
                    className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setConfirmStop(true)}
                  className="rounded-lg border border-rose-400/30 px-4 py-2 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
                >
                  {ACTION_LABEL.stop}
                </button>
              ))}

            {!alive && (
              <p className="text-sm text-zinc-500">
                This runtime is {status} and has nothing left to control.
              </p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function Spec({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-zinc-600">{label}</dt>
      <dd className="mt-1 break-words text-sm text-zinc-300">{children}</dd>
    </div>
  );
}