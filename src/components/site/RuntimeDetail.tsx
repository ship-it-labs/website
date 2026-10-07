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

// Lease counts as "stopping soon" inside this window (10 minutes).
const STOPPING_SOON_SECONDS = 10 * 60;

// Copies text, falling back to a hidden textarea when the async clipboard API
// is unavailable. NOTE (Batch 4): consolidate into one useCopy hook.
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

/** True when the lease expires within the warning window or already stopping. */
function isStoppingSoon(leaseExpiresAt: string | undefined, status: string, now: number): boolean {
  if (status === "stopping") return true;
  if (!leaseExpiresAt) return false;
  const expires = new Date(leaseExpiresAt).getTime();
  if (Number.isNaN(expires)) return false;
  const remaining = (expires - now) / 1000;
  return remaining > 0 && remaining <= STOPPING_SOON_SECONDS;
}

/**
 * Fraction of the session consumed (0..1). Prefers the max-session window so
 * the bar reads "lease elapsed vs max session"; falls back to the
 * start-to-lease window when no session limit was reported.
 */
function sessionProgress(
  startedAt: string | undefined,
  leaseExpiresAt: string | undefined,
  maxSessionSeconds: number | undefined,
  now: number
): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const elapsed = Math.max(0, (now - start) / 1000);
  if (maxSessionSeconds && maxSessionSeconds > 0) {
    return Math.min(1, elapsed / maxSessionSeconds);
  }
  if (!leaseExpiresAt) return null;
  const expires = new Date(leaseExpiresAt).getTime();
  if (Number.isNaN(expires) || expires <= start) return null;
  return Math.min(1, elapsed / ((expires - start) / 1000));
}

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

  const act = async (action: Action, retried = false) => {
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
      // One automatic retry hides a transient 502 without looping forever.
      const message = err instanceof Error ? err.message : `Could not ${action} the runtime`;
      if (!retried && /502|unreachable|bad gateway/i.test(message)) {
        try {
          await api.post(`/api/v1/runtimes/${runtimeId}/${action}`, {});
          if (action === "stop") {
            onChanged();
            onClose();
            return;
          }
          await load();
          onChanged();
          return;
        } catch (retryErr) {
          setError(retryErr instanceof Error ? retryErr.message : message);
        }
      } else {
        setError(message);
      }
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
  const stopping = status === "stopping";
  const metrics = info?.metrics;
  const stoppingSoon = isStoppingSoon(detail.lease_expires_at, status, now);
  // A stopping runtime is already past "alive", but still deserves the banner.
  const showStoppingBanner = stoppingSoon && (alive || stopping);
  const progress = sessionProgress(detail.started_at, detail.lease_expires_at, detail.max_session_seconds, now);
  const startedAtMs = detail.started_at ? new Date(detail.started_at).getTime() : NaN;
  // Live uptime from started_at, ticking with the page clock (the parent
  // passes a `now` that advances every second).
  const uptimeSeconds = !Number.isNaN(startedAtMs) ? Math.max(0, Math.floor((now - startedAtMs) / 1000)) : null;
  const appUrl = detail.app_url || info?.app_url;

  return (
    <>
      {showStoppingBanner && (
        <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-200">
            {stopping
              ? "This runtime is stopping now."
              : "Stopping soon: the session lease expires in under 10 minutes."}
          </p>
        </div>
      )}

      <div className="mb-6 flex items-center gap-3">
        <StatusDot status={status} />
        <span className="text-sm capitalize text-zinc-300">{status}</span>
        {alive && (
          <span className="ml-auto">
            <LeaseCountdown leaseExpiresAt={detail.lease_expires_at} now={now} />
          </span>
        )}
      </div>

      {progress !== null && alive && (
        <div className="mb-6" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Session progress">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>Session progress</span>
            <span className="font-mono tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
            <div
              className={`h-full rounded-full transition-[width] ${progress >= 5 / 6 ? "bg-amber-400" : "bg-violet-400"}`}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Spec label="Public URL">
              {appUrl ? (
                <span className="flex items-start gap-2">
                  <a
                    href={appUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 break-all text-violet-300 transition-colors hover:text-violet-200"
                  >
                    {appUrl}
                  </a>
                  <CopyButton text={appUrl} label="Copy URL" />
                </span>
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
              {detail.started_at ? new Date(detail.started_at).toLocaleString() : "—"}
            </Spec>
            <Spec label="Uptime">
              {uptimeSeconds !== null ? (
                <span className="font-mono tabular-nums">{formatDuration(uptimeSeconds)}</span>
              ) : (
                "—"
              )}
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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="shrink-0 rounded-lg bg-white/[0.04] px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/[0.09] hover:text-zinc-200"
    >
      {copied ? "Copied" : label}
    </button>
  );
}