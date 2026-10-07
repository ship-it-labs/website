import { supabase } from "../db/index.js";
import { recordRuntimeUsage, getCurrentPeriod } from "./quota-service.js";
import { logger } from "../utils/logger.js";
import { Runtime } from "../types/index.js";

const EXPIRY_CHECK_INTERVAL_MS = 30_000;

/** Lease counts as "stopping soon" inside this window (10 minutes). */
export const STOPPING_SOON_MS = 10 * 60_000;

/**
 * True when the lease expires within the warning window, or the runtime is
 * already stopping. Drives the "stopping soon" banner.
 */
export function isStoppingSoon(
  leaseExpiresAt: string | null | undefined,
  status: string | null | undefined,
  nowMs = Date.now()
): boolean {
  if (status === "stopping") return true;
  if (!leaseExpiresAt) return false;
  const expires = new Date(leaseExpiresAt).getTime();
  if (Number.isNaN(expires)) return false;
  const remaining = expires - nowMs;
  return remaining > 0 && remaining <= STOPPING_SOON_MS;
}

/**
 * Fraction of the session consumed (0..1), from start to lease expiry.
 * Null when the window is unknowable, so the bar hides instead of guessing.
 */
export function sessionProgress(
  startedAt: string | null | undefined,
  leaseExpiresAt: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!startedAt || !leaseExpiresAt) return null;
  const start = new Date(startedAt).getTime();
  const expires = new Date(leaseExpiresAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(expires) || expires <= start) return null;
  const progress = (nowMs - start) / (expires - start);
  return Math.min(1, Math.max(0, progress));
}

function billRuntime(runtime: Runtime): void {
  if (!runtime.started_at) return;

  const stoppedAt = runtime.stopped_at ? new Date(runtime.stopped_at) : new Date();
  const startedAt = new Date(runtime.started_at);
  const elapsedSeconds = Math.floor((stoppedAt.getTime() - startedAt.getTime()) / 1000);

  if (elapsedSeconds <= 0) return;

  const { start, end } = getCurrentPeriod();

  const upsert = supabase.from("runtime_sessions").upsert({
    id: runtime.id,
    user_id: runtime.user_id,
    started_at: runtime.started_at,
    stopped_at: stoppedAt.toISOString(),
    duration_seconds: elapsedSeconds,
  });

  void (async () => {
    const { error } = await upsert;
    if (error) {
      logger.error({ error, runtimeId: runtime.id }, "Failed to record runtime session");
      return;
    }
    await recordRuntimeUsage(runtime.user_id, runtime.id, elapsedSeconds);
    logger.info({ runtimeId: runtime.id, seconds: elapsedSeconds }, "Runtime usage billed");
  })().catch((err: unknown) => {
    logger.error({ err, runtimeId: runtime.id }, "Failed to bill runtime");
  });
}

async function expireLeases(): Promise<void> {
  const now = new Date().toISOString();

  const { data: expired, error } = await supabase
    .from("runtimes")
    .update({ status: "expired", stopped_at: now })
    .eq("status", "running")
    .lt("lease_expires_at", now)
    .select("id, user_id, started_at, stopped_at");

  if (error) {
    logger.error({ error }, "Failed to expire runtime leases");
    return;
  }

  for (const runtime of expired || []) {
    logger.info({ runtimeId: runtime.id }, "Runtime lease expired");
    billRuntime(runtime as Runtime);
  }
}

export function startLeaseExpiryWorker(): void {
  setInterval(() => {
    expireLeases().catch((err) => logger.error({ err }, "Lease expiry worker failed"));
  }, EXPIRY_CHECK_INTERVAL_MS);
}
