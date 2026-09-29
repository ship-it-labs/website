import { supabase } from "../db/client.js";
import { Plan } from "../types/index.js";
import { logger } from "../utils/logger.js";

const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    runtime_hours_per_month: 24,
    max_runtime_hours: 3,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 180,
    price_cents: 0,
    whop_product_id: null,
  },
  {
    id: "pro",
    name: "Pro",
    runtime_hours_per_month: 100,
    max_runtime_hours: 8,
    max_ram_mb: 2048,
    cpu: 0.5,
    build_timeout_seconds: 300,
    price_cents: 2900,
    whop_product_id: null,
  },
  {
    id: "plus",
    name: "Plus",
    runtime_hours_per_month: 500,
    max_runtime_hours: 24,
    max_ram_mb: 8192,
    cpu: 2,
    build_timeout_seconds: 600,
    price_cents: 9900,
    whop_product_id: null,
  },
];

export async function seedPlans(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    const { error } = await supabase
      .from("plans")
      .upsert(plan, { onConflict: "id" });
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

export async function getAllPlans(): Promise<Plan[]> {
  const { data, error } = await supabase.from("plans").select("*");
  if (error) return [];
  return data as Plan[];
}
