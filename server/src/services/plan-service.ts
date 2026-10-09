import { supabase, type Database } from "../db/index.js";
import { Plan } from "../types/index.js";
import { isDuplicateKeyError } from "../utils/db-errors.js";
import { logger } from "../utils/logger.js";

/**
 * Tier limits. Paid tiers are priced on runtime hours and how many instances
 * can run at once, not on machine size: every tier gets the same 512MB and
 * 0.1 CPU so a plan upgrade never changes what the app can do, only how long
 * and how many.
 */
const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    runtime_hours_per_month: 10,
    max_runtime_hours: 3,
    max_concurrent_runtimes: 1,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 180,
    price_cents: 0,
    note: null,
    previous_price_cents: null,
  },
  {
    id: "pro",
    name: "Pro",
    runtime_hours_per_month: 250,
    max_runtime_hours: 6,
    max_concurrent_runtimes: 3,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 300,
    price_cents: 900,
    note: null,
    previous_price_cents: null,
  },
  {
    id: "ultra",
    name: "Ultra",
    runtime_hours_per_month: 1000,
    max_runtime_hours: 24,
    max_concurrent_runtimes: 5,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 600,
    price_cents: 1900,
    note: null,
    previous_price_cents: null,
  },
];

export async function seedPlans(): Promise<void> {
  // Insert-only: an existing row is left exactly as it is. Tier changes ship
  // through explicit migrations (e.g. 0004_pro_session_hours), and anything an
  // admin edits in the panel — tiers or sale pricing — survives every signup
  // and reboot. An upsert here would silently revert those edits.
  const { data: existing } = await supabase.from("plans").select("id");
  const present = new Set(((existing ?? []) as { id: string }[]).map((row) => row.id));

  for (const plan of DEFAULT_PLANS) {
    if (present.has(plan.id)) continue;

    const { error } = await supabase
      .from("plans")
      .insert({ ...plan } as Record<string, unknown>);
    if (error) {
      logger.error({ error, planId: plan.id }, "Failed to seed plan");
    }
  }
  logger.info("Plans seeded");
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const { data, error } = await supabase
    .from("plans")
    .select("*")
    .eq("id", planId)
    .single();
  if (error) return null;
  return data as Plan;
}

/**
 * Repairs a dangling tier reference: if planId names a known default tier
 * with no row (unseeded plans table), the row is inserted and returned.
 * Unknown ids return null — only real tiers self-heal, never typos. Existing
 * rows, including admin-edited pricing, are never touched.
 */
export async function ensureDefaultPlan(
  planId: string,
  db: Database = supabase
): Promise<Plan | null> {
  const template = DEFAULT_PLANS.find((plan) => plan.id === planId);
  if (!template) return null;

  const { error } = await db
    .from("plans")
    .insert({ ...template } as Record<string, unknown>);
  if (error && !isDuplicateKeyError(error)) {
    logger.error({ err: error, planId }, "Failed to repair missing plan row");
    return null;
  }

  const { data, error: readError } = await db
    .from("plans")
    .select("*")
    .eq("id", planId)
    .single();
  if (readError || !data) return null;
  return data as Plan;
}

export async function getAllPlans(): Promise<Plan[]> {
  const { data, error } = await supabase.from("plans").select("*");
  if (error) return [];
  return data as Plan[];
}
