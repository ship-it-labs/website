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

/**
 * Pulls the runtime out of a status response that may wear several shapes.
 * The endpoint proxies the orchestrator verbatim, and orchestrator versions
 * have returned both `{ runtime: {...} }` and the flat runtime object — while
 * error payloads look like `{ error: {...} }`. Guessing wrong used to leave
 * the modal on "Loading..." forever with no error, which reads exactly like a
 * row that cannot be clicked.
 */
export function normalizeRuntimeDetail(
  payload: unknown
): RuntimeDetail | { missing: true } | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const candidate =
    isRuntimeLike(record.runtime) ? record.runtime :
    isRuntimeLike(record.data) ? record.data :
    isRuntimeLike(record) ? record :
    null;

  if (!candidate) return null;
  if (candidate.status === "not_found") return { missing: true };
  return candidate as unknown as RuntimeDetail;
}

function isRuntimeLike(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).runtime_id === "string"
  );
}

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
  const [gone, setGone] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const load = useCallback(async () => {
    try {
      // Both requests matter: status decides which buttons make sense, and info
      // carries the numbers worth showing.
      const [status, details] = await Promise.all([
        api.get<unknown>(`/api/v1/runtimes/${runtimeId}`),
        api
          .post<Info>(`/api/v1/runtimes/${runtimeId}/info`, {})
          .catch(() => null),
      ]);

      const parsed = normalizeRuntimeDetail(status);
      if (!parsed) {
        // A shape nobody recognizes is a failure, not an eternal spinner: say
        // so, with a retry, instead of showing "Loading..." until heat death.
        setError("The runtime answered in a format this page does not understand.");
        return;
      }
      if ("missing" in parsed) {
        setGone(true);
        setDetail(null);
        setError(null);
        return;
      }

      setDetail(parsed);
      setGone(false);
      setInfo(details);
      setError(null);
    } catch (err) {
      if (err instanceof Error && /404|not found/i.test(err.message)) {
        setGone(true);
        setDetail(null);
        setError(null);
        return;
      }
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

  return (
    <Modal title={runtimeId} description="Runtime details" onClose={onClose}>
      {gone ? (
        <div className="py-4 text-center">
          <p className="text-sm text-zinc-300">
            This runtime no longer exists. It may have expired, been deleted,
            or belonged to a restart the platform has since forgotten.
          </p>
          <button
            type="button"
            onClick={() => {
              onChanged();
              onClose();
            }}
            className="mt-5 rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
          >
            Close and refresh
          </button>
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3">
              <p className="text-sm text-rose-200">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  load();
                }}
                className="mt-2 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Try again
              </button>
            </div>
          )}

          {!detail && !error ? (
            <p className="text-sm text-zinc-500">Loading...</p>
          ) : detail ? (
            <RuntimeBody
              detail={detail}
              info={info}
              now={now}
              plan={plan}
              busy={busy}
              confirmStop={confirmStop}
              setConfirmStop={setConfirmStop}
              act={act}
            />
          ) : null}
        </>
      )}
    </Modal>
  );
}

function RuntimeBody({
  detail,
  info,
  now,
  plan,
  busy,
  confirmStop,
  setConfirmStop,
  act,
}: {
  detail: RuntimeDetail;
  info: Info | null;
  now: number;
  plan?: { max_ram_mb: number; cpu: number };
  busy: Action | null;
  confirmStop: boolean;
  setConfirmStop: (value: boolean) => void;
  act: (action: Action) => void;
}) {
  const status = detail.status ?? "unknown";
  const alive = status === "running" || status === "starting" || status === "paused";
  const paused = status === "paused";
  const metrics = info?.metrics;

  return (
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