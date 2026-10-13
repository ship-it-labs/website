import { randomUUID } from "node:crypto";
import { supabase, type Database } from "../db/index.js";
import { getCurrentPeriod } from "./quota-service.js";
import { logger } from "../utils/logger.js";

/**
 * Assistant allowances, in credits. A credit is a fixed number of tokens the
 * plan is worth each calendar month; the exchange rate lives here rather than
 * in the schema so it can be retuned without touching stored rows. Admins are
 * unlimited. Free accounts have no allowance at all — the assistant is a paid
 * feature, and a free account asking once must be told to upgrade rather than
 * quietly costing the platform pollen.
 *
 * Token caps bound one request: input caps how much a caller may send, output
 * caps what the model may generate. They keep a single message from spending a
 * whole month's allowance.
 */

const TOKENS_PER_CREDIT = positive(process.env.AI_TOKENS_PER_CREDIT, 10_000);

export interface AiTierLimits {
  /** Credits granted per calendar month. 0 disables the assistant. */
  credits: number;
  /** Maximum prompt tokens accepted for one request. */
  inputTokens: number;
  /** Maximum completion tokens generated for one request. */
  outputTokens: number;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export const AI_LIMITS: Record<string, AiTierLimits> = {
  free: { credits: 0, inputTokens: 4_000, outputTokens: 600 },
  pro: {
    credits: positive(process.env.AI_CREDITS_PRO, 50),
    inputTokens: 8_000,
    outputTokens: 1_000,
  },
  ultra: {
    credits: positive(process.env.AI_CREDITS_ULTRA, 200),
    inputTokens: 12_000,
    outputTokens: 1_500,
  },
};

/** Unknown plans fall back to the free allowance: fail closed, never open. */
export function limitsForPlan(planId: string | null | undefined): AiTierLimits {
  return AI_LIMITS[planId ?? "free"] ?? AI_LIMITS.free;
}

/** Credits a token count costs, rounded up so a cheap request still costs one. */
export function creditsFromTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.ceil(tokens / TOKENS_PER_CREDIT);
}

export interface AiUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheHit: boolean;
}

export interface AiEntitlement {
  planId: string;
  unlimited: boolean;
  limitCredits: number;
  usedCredits: number;
  remainingCredits: number;
  inputTokens: number;
  outputTokens: number;
  allowed: boolean;
  reason: "ok" | "free" | "exhausted";
}

interface UsageRow {
  id: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  requests: number;
  cache_hits: number;
}

/** YYYY-MM-DD in UTC; the date column stores days, not instants. */
export function periodStartDate(at: Date = getCurrentPeriod().start): string {
  return at.toISOString().slice(0, 10);
}

async function readRow(
  db: Database,
  userId: string,
  periodStart: string
): Promise<UsageRow | null> {
  const { data } = await db
    .from("agent_usage")
    .select("id, input_tokens, output_tokens, cached_tokens, requests, cache_hits")
    .eq("user_id", userId)
    .eq("period_start", periodStart)
    .maybeSingle();
  return (data as UsageRow) ?? null;
}

/** The tokens this user has spent this calendar month. */
export async function usageThisPeriod(
  db: Database,
  userId: string
): Promise<{ inputTokens: number; outputTokens: number; cachedTokens: number }> {
  const row = await readRow(db, userId, periodStartDate());
  return {
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cachedTokens: row?.cached_tokens ?? 0,
  };
}

/**
 * Everything the caller needs to decide and to show: the plan's allowance, what
 * is left, the per-request caps, and whether a request may proceed. Admins are
 * unlimited and always allowed.
 */
export async function getEntitlement(
  db: Database,
  userId: string,
  planId: string | null | undefined,
  isAdmin: boolean
): Promise<AiEntitlement> {
  const limits = limitsForPlan(planId);
  const base = {
    planId: planId ?? "free",
    limitCredits: limits.credits,
    inputTokens: limits.inputTokens,
    outputTokens: limits.outputTokens,
  };

  if (isAdmin) {
    return {
      ...base,
      unlimited: true,
      usedCredits: 0,
      // A concrete large number, not Infinity: this object is serialised into
      // JSON responses and Infinity would become null.
      remainingCredits: Number.MAX_SAFE_INTEGER,
      allowed: true,
      reason: "ok",
    };
  }

  const usage = await usageThisPeriod(db, userId);
  const usedCredits = creditsFromTokens(usage.inputTokens + usage.outputTokens);

  if (limits.credits <= 0) {
    return { ...base, unlimited: false, usedCredits, remainingCredits: 0, allowed: false, reason: "free" };
  }

  const remainingCredits = Math.max(0, limits.credits - usedCredits);
  return {
    ...base,
    unlimited: false,
    usedCredits,
    remainingCredits,
    allowed: remainingCredits > 0,
    reason: remainingCredits > 0 ? "ok" : "exhausted",
  };
}

/**
 * Adds one request's tokens onto this month's row. Read-then-write rather than
 * an atomic increment because the SQLite stand-in has no upsert-with-add and
 * one user cannot realistically issue two turns in the same tick; a lost update
 * under a double-submit only ever under-counts by one answer.
 */
export async function recordAiUsage(
  db: Database,
  userId: string,
  delta: AiUsageDelta
): Promise<void> {
  const periodStart = periodStartDate();
  const existing = await readRow(db, userId, periodStart);
  const now = new Date().toISOString();

  try {
    if (existing) {
      await db
        .from("agent_usage")
        .update({
          input_tokens: existing.input_tokens + delta.inputTokens,
          output_tokens: existing.output_tokens + delta.outputTokens,
          cached_tokens: existing.cached_tokens + delta.cachedTokens,
          requests: existing.requests + 1,
          cache_hits: existing.cache_hits + (delta.cacheHit ? 1 : 0),
          updated_at: now,
        })
        .eq("id", existing.id);
    } else {
      await db.from("agent_usage").insert({
        id: randomUUID(),
        user_id: userId,
        period_start: periodStart,
        input_tokens: delta.inputTokens,
        output_tokens: delta.outputTokens,
        cached_tokens: delta.cachedTokens,
        requests: 1,
        cache_hits: delta.cacheHit ? 1 : 0,
        cost_usd: 0,
        created_at: now,
        updated_at: now,
      });
    }
  } catch (err) {
    // Accounting must never break an answer the user already paid for; the
    // worst case is an under-count, which is logged and tolerated.
    logger.warn({ err, userId, periodStart }, "Assistant usage write failed");
  }
}

export interface PlatformAiUsage {
  users: number;
  requests: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  credits: number;
}

interface PlatformUsageRow {
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  requests: number;
  cache_hits: number;
}

/** Platform-wide totals for the admin panel, summed in code (no SQL aggs). */
export async function platformUsage(
  db: Database,
  periodStart: string = periodStartDate()
): Promise<PlatformAiUsage> {
  const { data } = await db
    .from("agent_usage")
    .select("user_id, input_tokens, output_tokens, cached_tokens, requests, cache_hits")
    .eq("period_start", periodStart);
  const rows = (data ?? []) as PlatformUsageRow[];
  const total: PlatformAiUsage = {
    users: rows.length,
    requests: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    credits: 0,
  };
  for (const row of rows) {
    total.requests += row.requests ?? 0;
    total.cacheHits += row.cache_hits ?? 0;
    total.inputTokens += row.input_tokens ?? 0;
    total.outputTokens += row.output_tokens ?? 0;
    total.cachedTokens += row.cached_tokens ?? 0;
    total.credits += creditsFromTokens((row.input_tokens ?? 0) + (row.output_tokens ?? 0));
  }
  return total;
}

export { TOKENS_PER_CREDIT };
