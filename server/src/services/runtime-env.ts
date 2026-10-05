import { supabase, type Database } from "../db/index.js";
import { logger } from "../utils/logger.js";

/**
 * Deployment configuration owned by the admin panel instead of the shell.
 *
 * Each curated key holds a development value and a production value in the
 * env_overrides table. On boot (and every minute after) the deployment copies
 * the active column into process.env, so every existing reader — including
 * the few that capture values at import time — sees admin-managed values
 * without a single call site changing how it reads configuration.
 *
 * Two deliberate limits. First, boot-identity values are not manageable
 * here: NODE_ENV, PORT/HOST, database credentials and paths, and anything the
 * process needs before it can reach the database. Second, switching the active
 * column changes configuration values only, never the runtime mode: a
 * production process stays on Supabase with live code paths even while reading
 * the development column, which is exactly the footgun the confirm dialog in
 * the UI exists to prevent.
 */

export interface EnvKey {
  key: string;
  label: string;
  description: string;
  secret: boolean;
}

export const MANAGED_ENV_KEYS: EnvKey[] = [
  { key: "WHOP_SANDBOX_API_KEY", label: "Whop sandbox key", description: "Test-mode payments. Used whenever the runtime mode is development.", secret: true },
  { key: "WHOP_LIVE_API_KEY", label: "Whop live key", description: "Real payments. Used whenever the runtime mode is production.", secret: true },
  { key: "WHOP_WEBHOOK_SECRET", label: "Whop webhook secret", description: "Verifies incoming payment webhooks. Must match the endpoint secret.", secret: true },
  { key: "SANDBOX_PRO_PLAN_ID", label: "Sandbox Pro plan", description: "The plan_… id selling Pro in development. Wins over WHOP_PRO_PLAN_ID when set.", secret: false },
  { key: "SANDBOX_ULTRA_PLAN_ID", label: "Sandbox Ultra plan", description: "The plan_… id selling Ultra in development. Wins over WHOP_ULTRA_PLAN_ID when set.", secret: false },
  { key: "PROD_PRO_PLAN_ID", label: "Production Pro plan", description: "The plan_… id selling Pro in production. Wins over WHOP_PRO_PLAN_ID when set.", secret: false },
  { key: "PROD_ULTRA_PLAN_ID", label: "Production Ultra plan", description: "The plan_… id selling Ultra in production. Wins over WHOP_ULTRA_PLAN_ID when set.", secret: false },
  { key: "GITHUB_TOKEN", label: "GitHub token", description: "Dispatches Actions builds. Needs Actions:write on the workflow repo.", secret: true },
  { key: "GITHUB_REPO", label: "GitHub workflow repo", description: "owner/repo holding the build workflow.", secret: false },
  { key: "BUILD_REPORT_TOKEN", label: "Build report token", description: "Shared secret Actions runs post results back with. Must match the repo secret.", secret: true },
  { key: "ORCHESTRATOR_SECRET", label: "Service secret", description: "Shared by website, orchestrator and manager. Changing it here requires the same value over there, or calls start failing.", secret: true },
  { key: "RUNTIME_ORCHESTRATOR_URL", label: "Orchestrator URL", description: "Where the control plane sends runtime work.", secret: false },
  { key: "SERVER_MANAGER_URL", label: "Manager URL", description: "Agent registry and capacity, read by the admin overview.", secret: false },
  { key: "PUBLIC_BASE_URL", label: "Public base URL", description: "The address the world uses: signed links, runner downloads, webhook derivation.", secret: false },
  { key: "SITE_URL", label: "Site URL", description: "Where browsers return after checkout.", secret: false },
  { key: "INTERNAL_PUBLIC_BASE_URL", label: "Internal base URL", description: "How services reach this process over the private network.", secret: false },
  { key: "ALLOWED_ORIGINS", label: "Allowed origins", description: "Comma-separated extra browser origins. Empty means same-origin only.", secret: false },
];

const MANAGED_KEYS = new Set(MANAGED_ENV_KEYS.map((entry) => entry.key));

export type ConfigEnvironment = "auto" | "development" | "production";

/** Which column wins: the admin's explicit choice, or the runtime mode. */
export function resolveEffectiveEnv(
  nodeEnv: string | undefined,
  configSetting: unknown
): "development" | "production" {
  if (configSetting === "development" || configSetting === "production") {
    return configSetting;
  }
  return nodeEnv === "production" ? "production" : "development";
}

export function isManagedKey(key: string): boolean {
  return MANAGED_KEYS.has(key);
}

/** Rows for one environment column, as a plain map. Pure and testable. */
export function overridesMap(
  rows: { key: string; environment: string; value: string }[],
  environment: "development" | "production"
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.environment === environment && MANAGED_KEYS.has(row.key)) {
      map[row.key] = row.value;
    }
  }
  return map;
}

async function readConfigEnvironment(db: Database): Promise<unknown> {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "config_environment")
    .single();
  if (!data) return undefined;
  const raw = (data as { value: unknown }).value;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Copies the active column into the target (process.env in production use).
 * Returns the keys applied. Throws nothing: an unreachable or not-yet-migrated
 * database leaves configuration exactly as the shell provided it.
 */
export async function loadEnvOverrides(
  db: Database = supabase,
  target: Record<string, string | undefined> = process.env
): Promise<string[]> {
  const nodeEnv = process.env.NODE_ENV;
  try {
    const [setting, rows] = await Promise.all([
      readConfigEnvironment(db),
      db.from("env_overrides").select("key, environment, value").then((result) => result.data ?? []),
    ]);

    const effective = resolveEffectiveEnv(nodeEnv, setting);
    const map = overridesMap(
      (rows ?? []) as { key: string; environment: string; value: string }[],
      effective
    );

    const applied: string[] = [];
    for (const [key, value] of Object.entries(map)) {
      target[key] = value;
      applied.push(key);
    }

    if (applied.length > 0) {
      logger.info({ count: applied.length, environment: effective }, "Applied DB-managed configuration");
    }
    return applied;
  } catch (err) {
    logger.warn({ err }, "Could not load DB-managed configuration; shell values stand");
    return [];
  }
}
