import { supabase, usingSqlite, type Database } from "../db/index.js";
import { resolveBuildExecutor } from "./build-executor.js";
import { publicBaseUrl, siteUrl, orchestratorUrl } from "../config/urls.js";
import { callOrchestrator } from "./orchestrator-client.js";

/**
 * Self-diagnosis for the admin panel: which integrations are configured, which
 * addresses are in effect, and whether the orchestrator answers.
 *
 * Presence only, never values — a diagnostics page that leaks a secret to any
 * admin browser session (or its screenshots, logs and history) defeats the
 * purpose of keeping secrets out of the UI. Booleans diagnose misconfiguration
 * completely: every integration here fails loudly on a missing value.
 */
export interface Diagnostics {
  node_env: string;
  database: "sqlite" | "supabase";
  urls: {
    public_base_url: string;
    site_url: string;
    orchestrator_url: string;
  };
  whop: {
    sandbox_key: boolean;
    live_key: boolean;
    webhook_secret: boolean;
    pro_plan: boolean;
    ultra_plan: boolean;
  };
  github: {
    token: boolean;
    repo: string;
    executor: string;
    report_token: boolean;
  };
  orchestrator_reachable: boolean;
}

function present(name: string): boolean {
  return (process.env[name] ?? "").trim().length > 0;
}

/**
 * Effective presence for a value with environment-specific and legacy names:
 * the specific variable wins, the legacy one fills the gap — the same order
 * whop-service resolves them in, so the dashboard never disagrees with the
 * code about what is configured.
 */
function effective(specific: string, legacy: string): boolean {
  return present(specific) || present(legacy);
}

export async function collectDiagnostics(): Promise<Diagnostics> {
  let orchestratorReachable = false;
  try {
    await callOrchestrator<{ status: string }>("/health", {}, 5000);
    orchestratorReachable = true;
  } catch {
    // Unreachable is the finding, not an error: the panel renders it.
  }

  const production = process.env.NODE_ENV === "production";
  const side = production ? "PROD" : "SANDBOX";

  return {
    node_env: process.env.NODE_ENV ?? "development",
    database: usingSqlite ? "sqlite" : "supabase",
    urls: {
      public_base_url: publicBaseUrl(),
      site_url: siteUrl(),
      orchestrator_url: orchestratorUrl(),
    },
    whop: {
      sandbox_key: present("WHOP_SANDBOX_API_KEY"),
      live_key: present("WHOP_LIVE_API_KEY"),
      webhook_secret: effective(`${side}_WEBHOOK_SECRET`, "WHOP_WEBHOOK_SECRET"),
      pro_plan: effective(`${side}_PRO_PLAN_ID`, "WHOP_PRO_PLAN_ID"),
      ultra_plan: effective(`${side}_ULTRA_PLAN_ID`, "WHOP_ULTRA_PLAN_ID"),
    },
    github: {
      token: present("GITHUB_TOKEN"),
      repo: process.env.GITHUB_REPO || "Ship-it-labs/opencode-plugin",
      executor: resolveBuildExecutor(),
      report_token: present("BUILD_REPORT_TOKEN"),
    },
    orchestrator_reachable: orchestratorReachable,
  };
}

/**
 * Tables the row-count diagnostic may probe. Mirrors the admin console's
 * browsable list; auth tables and secrets stay out for the same reason.
 */
export const COUNTABLE_TABLES = [
  "users",
  "plans",
  "subscriptions",
  "api_keys",
  "projects",
  "builds",
  "build_logs",
  "runtimes",
  "runtime_sessions",
  "usage_months",
  "webhook_events",
  "user_sessions",
  "user_preferences",
  "platform_settings",
  "env_overrides",
  "admin_audit",
] as const;

// One column guaranteed to exist per table. Not every table has an id
// (usage_months and subscriptions are keyed by user_id), so a blanket
// select("id") would fail on exactly the tables being measured.
const COUNT_COLUMNS: Record<string, string> = {
  users: "id",
  plans: "id",
  subscriptions: "user_id",
  api_keys: "id",
  projects: "id",
  builds: "id",
  build_logs: "build_id",
  runtimes: "id",
  runtime_sessions: "id",
  usage_months: "user_id",
  webhook_events: "id",
  user_sessions: "id",
  user_preferences: "user_id",
  platform_settings: "key",
  env_overrides: "key",
  admin_audit: "id",
};

export interface TableCount {
  table: string;
  rows: number | null;
}

/**
 * Per-table row counts for the database diagnostic. Each table is probed
 * independently and a failure yields null for that table rather than failing
 * the whole report — a not-yet-migrated table (e.g. admin_audit) shows as
 * unknown instead of breaking the page.
 */
export async function collectTableCounts(db: Database = supabase): Promise<TableCount[]> {
  const counts: TableCount[] = [];
  for (const table of COUNTABLE_TABLES) {
    try {
      const { data, error } = await db.from(table).select(COUNT_COLUMNS[table]);
      // No aggregate support in the local SQLite stand-in, and these tables
      // are small, so rows are counted in code with a single narrow column.
      if (error) {
        counts.push({ table, rows: null });
        continue;
      }
      counts.push({ table, rows: (data ?? []).length });
    } catch {
      counts.push({ table, rows: null });
    }
  }
  return counts;
}
