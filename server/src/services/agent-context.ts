import { supabase } from "../db/index.js";
import type { AgentMessage } from "./pollinations.js";
import { logger } from "../utils/logger.js";

/**
 * Builds what the model sees about one account, and keeps the whole request
 * inside a token budget. Both live here because they answer the same question:
 * "what is the smallest set of facts that lets the assistant answer correctly?"
 * The account snapshot is that set for the user's own data; the budget trims
 * conversation history so it can never push the request past the context limit.
 */

/** Rough token estimate: ~4 characters per token, good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface AccountSnapshot {
  email: string | null;
  planId: string;
  plan: {
    name: string;
    runtimeHoursPerMonth: number;
    maxSessionHours: number;
    maxConcurrentRuntimes: number;
    buildTimeoutSeconds: number;
    priceCents: number;
  } | null;
  subscription: {
    status: string;
    planId: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  projects: { id: string; name: string; language: string | null }[];
  recentBuilds: { id: string; status: string; createdAt: string }[];
  activeRuntimes: { id: string; status: string; appUrl: string | null }[];
  usage: { runtimeSeconds: number; buildCount: number; periodStart: string; periodEnd: string } | null;
}

function asString(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

/** Gathers the account facts in one pass; a failed sub-query degrades to empty. */
export async function buildAccountSnapshot(userId: string): Promise<AccountSnapshot> {
  const snapshot: AccountSnapshot = {
    email: null,
    planId: "free",
    plan: null,
    subscription: null,
    projects: [],
    recentBuilds: [],
    activeRuntimes: [],
    usage: null,
  };

  try {
    const { data: user } = await supabase
      .from("users")
      .select("email, plan_id")
      .eq("id", userId)
      .maybeSingle();
    if (user) {
      snapshot.email = user.email ? String(user.email) : null;
      snapshot.planId = asString(user.plan_id, "free");
    }

    const { data: plan } = await supabase
      .from("plans")
      .select(
        "name, runtime_hours_per_month, max_runtime_hours, max_concurrent_runtimes, build_timeout_seconds, price_cents"
      )
      .eq("id", snapshot.planId)
      .maybeSingle();
    if (plan) {
      snapshot.plan = {
        name: asString(plan.name, snapshot.planId),
        runtimeHoursPerMonth: Number(plan.runtime_hours_per_month ?? 0),
        maxSessionHours: Number(plan.max_runtime_hours ?? 0),
        maxConcurrentRuntimes: Number(plan.max_concurrent_runtimes ?? 1),
        buildTimeoutSeconds: Number(plan.build_timeout_seconds ?? 0),
        priceCents: Number(plan.price_cents ?? 0),
      };
    }

    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("status, plan_id, current_period_end, cancel_at_period_end")
      .eq("user_id", userId)
      .maybeSingle();
    if (subscription) {
      snapshot.subscription = {
        status: asString(subscription.status),
        planId: asString(subscription.plan_id),
        currentPeriodEnd: subscription.current_period_end
          ? asString(subscription.current_period_end)
          : null,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      };
    }

    const { data: projects } = await supabase
      .from("projects")
      .select("id, name, language")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(8);
    if (Array.isArray(projects)) {
      snapshot.projects = projects.map((row) => ({
        id: asString(row.id),
        name: asString(row.name, "untitled"),
        language: row.language ? asString(row.language) : null,
      }));
    }

    const { data: builds } = await supabase
      .from("builds")
      .select("id, status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (Array.isArray(builds)) {
      snapshot.recentBuilds = builds.map((row) => ({
        id: asString(row.id),
        status: asString(row.status, "pending"),
        createdAt: asString(row.created_at),
      }));
    }

    const { data: runtimes } = await supabase
      .from("runtimes")
      .select("id, status, app_url")
      .eq("user_id", userId)
      .in("status", ["starting", "running"])
      .limit(5);
    if (Array.isArray(runtimes)) {
      snapshot.activeRuntimes = runtimes.map((row) => ({
        id: asString(row.id),
        status: asString(row.status),
        appUrl: row.app_url ? asString(row.app_url) : null,
      }));
    }

    const { data: usage } = await supabase
      .from("usage_months")
      .select("runtime_used_seconds, build_count, period_start, period_end")
      .eq("user_id", userId)
      .order("period_start", { ascending: false })
      .limit(1);
    const usageRow = Array.isArray(usage) ? usage[0] : null;
    if (usageRow) {
      snapshot.usage = {
        runtimeSeconds: Number(usageRow.runtime_used_seconds ?? 0),
        buildCount: Number(usageRow.build_count ?? 0),
        periodStart: asString(usageRow.period_start),
        periodEnd: asString(usageRow.period_end),
      };
    }
  } catch (err) {
    logger.warn({ err, userId }, "Account snapshot partially failed");
  }

  return snapshot;
}

/** Compact, model-friendly rendering of the snapshot. */
export function snapshotText(snapshot: AccountSnapshot): string {
  const hours = snapshot.usage ? (snapshot.usage.runtimeSeconds / 3600).toFixed(1) : "0.0";
  const lines = [
    "Current account:",
    `- email: ${snapshot.email ?? "unknown"}`,
    `- plan: ${snapshot.plan?.name ?? snapshot.planId} (id ${snapshot.planId})`,
  ];
  if (snapshot.plan) {
    lines.push(
      `- plan limits: ${snapshot.plan.runtimeHoursPerMonth}h/month, ${snapshot.plan.maxSessionHours}h max session, ${snapshot.plan.maxConcurrentRuntimes} concurrent runtimes, ${snapshot.plan.buildTimeoutSeconds}s build timeout`
    );
  }
  if (snapshot.subscription) {
    lines.push(
      `- subscription: ${snapshot.subscription.status}${snapshot.subscription.currentPeriodEnd ? `, renews/ends ${snapshot.subscription.currentPeriodEnd}` : ""}${snapshot.subscription.cancelAtPeriodEnd ? ", set to cancel" : ""}`
    );
  }
  lines.push(
    `- usage this period: ${hours}h runtime, ${snapshot.usage?.buildCount ?? 0} builds`,
    `- projects (${snapshot.projects.length}): ${snapshot.projects.map((p) => p.name).join(", ") || "none"}`
  );
  if (snapshot.recentBuilds.length > 0) {
    lines.push(
      `- recent builds: ${snapshot.recentBuilds.map((b) => `${b.status} (${b.id.slice(0, 8)})`).join(", ")}`
    );
  }
  lines.push(
    `- active runtimes: ${snapshot.activeRuntimes.map((r) => `${r.status}${r.appUrl ? ` ${r.appUrl}` : ""}`).join(", ") || "none"}`
  );
  return lines.join("\n");
}

/**
 * Drops the oldest conversation turns until the whole request fits `budget`
 * tokens. The leading system message is pinned; the newest turns are the last
 * to go, because the immediately preceding exchange matters most.
 */
export function trimToBudget(messages: AgentMessage[], budget: number): AgentMessage[] {
  if (messages.length <= 1) return messages;

  const cost = (message: AgentMessage): number =>
    estimateTokens(message.content) + estimateTokens(message.cachePrefix ?? "") + 4;

  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");

  let total = [...system, ...rest].reduce((sum, message) => sum + cost(message), 0);
  if (total <= budget) return [...system, ...rest];

  // Remove from the front of `rest` (the oldest turns) until it fits, but never
  // drop the final user turn, so there is always something to answer.
  while (rest.length > 1 && total > budget) {
    const dropped = rest.shift();
    if (dropped) total -= cost(dropped);
  }

  return [...system, ...rest];
}
