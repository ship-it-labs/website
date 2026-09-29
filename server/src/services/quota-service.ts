import { supabase } from "../db/client.js";
import { Plan } from "../types/index.js";
import { logger } from "../utils/logger.js";

export function getCurrentPeriod(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

export async function getUsageForPeriod(
  userId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<{ usedSeconds: number; buildCount: number }> {
  const { data, error } = await supabase
    .from("usage_months")
    .select("runtime_used_seconds, build_count")
    .eq("user_id", userId)
    .eq("period_start", periodStart.toISOString())
    .single();

  if (error || !data) {
    return { usedSeconds: 0, buildCount: 0 };
  }

  return {
    usedSeconds: data.runtime_used_seconds || 0,
    buildCount: data.build_count || 0,
  };
}

export async function getQuotaStatus(userId: string, plan: Plan): Promise<{
  monthlyLimitSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
  maxSessionSeconds: number;
}> {
  const { start, end } = getCurrentPeriod();
  const { usedSeconds } = await getUsageForPeriod(userId, start, end);

  const monthlyLimitSeconds = plan.runtime_hours_per_month * 3600;
  const maxSessionSeconds = Math.min(
    plan.max_runtime_hours * 3600,
    monthlyLimitSeconds - usedSeconds
  );

  return {
    monthlyLimitSeconds,
    usedSeconds,
    remainingSeconds: Math.max(0, monthlyLimitSeconds - usedSeconds),
    maxSessionSeconds: Math.max(0, maxSessionSeconds),
  };
}

export async function recordRuntimeUsage(
  userId: string,
  runtimeId: string,
  seconds: number
): Promise<void> {
  const { start, end } = getCurrentPeriod();

  const { error } = await supabase.rpc("increment_runtime_usage", {
    p_user_id: userId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_seconds: seconds,
  });

  if (error) {
    logger.error({ error, userId, seconds }, "Failed to record runtime usage");
  }
}

export async function recordBuild(userId: string): Promise<void> {
  const { start, end } = getCurrentPeriod();

  const { error } = await supabase.rpc("increment_build_count", {
    p_user_id: userId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
  });

  if (error) {
    logger.error({ error, userId }, "Failed to record build count");
  }
}

export async function canStartRuntime(
  userId: string,
  plan: Plan
): Promise<{ allowed: boolean; reason?: string; maxSessionSeconds: number }> {
  const quota = await getQuotaStatus(userId, plan);

  if (quota.remainingSeconds <= 0) {
    return {
      allowed: false,
      reason: "RUNTIME_QUOTA_EXCEEDED",
      maxSessionSeconds: 0,
    };
  }

  return { allowed: true, maxSessionSeconds: quota.maxSessionSeconds };
}
