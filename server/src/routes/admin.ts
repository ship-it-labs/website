import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase, usingSqlite } from "../db/index.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import { callOrchestrator } from "../services/orchestrator-client.js";
import { OrchestratorError } from "../routes/runtimes.js";
import { getPlan, getAllPlans } from "../services/plan-service.js";
import {
  retrieveMembership,
  planIdFromMembership,
  whopPlanIdOf,
} from "../services/whop-service.js";
import {
  MANAGED_ENV_KEYS,
  isManagedKey,
  loadEnvOverrides,
} from "../services/runtime-env.js";
import { collectDiagnostics, collectTableCounts } from "../services/diagnostics.js";
import { getCurrentPeriod } from "../services/quota-service.js";
import {
  isAdminUser,
  recordAdminAudit,
  toCsv,
} from "../services/admin.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { logger } from "../utils/logger.js";

/**
 * Tables the database console may browse. Credentials and raw secrets never
 * appear: auth tables are absent entirely, and hash/value columns are excluded
 * from the select so a screenshot cannot leak them.
 */
const DB_TABLES: { name: string; description: string; columns: string }[] = [
  { name: "users", description: "Accounts and tiers", columns: "id, email, plan_id, is_admin, is_active, created_at" },
  { name: "plans", description: "Pricing tiers", columns: "id, name, runtime_hours_per_month, max_runtime_hours, max_concurrent_runtimes, price_cents" },
  { name: "subscriptions", description: "Billing memberships", columns: "user_id, plan_id, promo_code, status, current_period_end, cancel_at_period_end, updated_at" },
  { name: "api_keys", description: "API keys (hashes never shown)", columns: "id, user_id, key_prefix, name, is_active, created_at, last_used_at, expires_at" },
  { name: "projects", description: "Uploaded projects", columns: "id, user_id, name, repo_url, file_count, created_at" },
  { name: "builds", description: "Build runs", columns: "id, user_id, project_id, status, exit_code, created_at, completed_at" },
  { name: "build_logs", description: "Build output lines", columns: "build_id, stream, created_at" },
  { name: "runtimes", description: "Runtime records", columns: "id, user_id, project_id, status, created_at" },
  { name: "runtime_sessions", description: "Billed sessions", columns: "id, user_id, started_at, stopped_at, duration_seconds" },
  { name: "usage_months", description: "Monthly usage totals", columns: "user_id, period_start, runtime_used_seconds, build_count" },
  { name: "webhook_events", description: "Inbound webhook log", columns: "provider, event_type, processed, created_at" },
  { name: "user_sessions", description: "Remembered logins (token hashes never shown)", columns: "id, user_id, user_agent, ip, created_at, last_seen_at" },
  { name: "user_preferences", description: "Notification and display prefs", columns: "user_id, email_notifications, theme, updated_at" },
  { name: "platform_settings", description: "Kill switches and overrides", columns: "key, updated_at" },
  { name: "env_overrides", description: "DB-managed config (values never shown)", columns: "key, environment, updated_at" },
  { name: "admin_audit", description: "Admin action log", columns: "id, admin_id, action, target, detail, created_at" },
];

const managerUrl = () => process.env.SERVER_MANAGER_URL || "http://manager:3001";
const managerSecret = () => process.env.ORCHESTRATOR_SECRET || "";

interface AgentInfo {
  agent_id?: string;
  id?: string;
  current_runtimes?: number;
  max_runtimes?: number;
}

/** Best-effort agent capacity. Null when the manager cannot be reached, so a
 * down manager degrades the overview instead of failing it. */
async function agentCapacity(): Promise<{
  agents: AgentInfo[];
  total_used: number;
  total_max: number;
} | null> {
  const secret = managerSecret();
  if (!secret) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${managerUrl()}/api/v1/agents/online`, {
        headers: { "x-service-secret": secret },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { agents?: AgentInfo[] };
      const agents = body.agents ?? [];
      return {
        agents,
        total_used: agents.reduce((n, a) => n + (a.current_runtimes ?? 0), 0),
        total_max: agents.reduce((n, a) => n + (a.max_runtimes ?? 0), 0),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn({ err }, "Admin overview could not reach server-manager");
    return null;
  }
}

const planChangeSchema = z.object({
  plan_id: z.string().min(1).max(32),
});

const planEditSchema = z
  .object({
    name: z.string().min(1).max(32).optional(),
    runtime_hours_per_month: z.number().int().min(0).max(100000).optional(),
    max_runtime_hours: z.number().min(0.1).max(24).optional(),
    max_concurrent_runtimes: z.number().int().min(1).max(100).optional(),
    max_ram_mb: z.number().int().min(128).max(16384).optional(),
    cpu: z.number().min(0.05).max(16).optional(),
    build_timeout_seconds: z.number().int().min(30).max(3600).optional(),
    price_cents: z.number().int().min(0).max(1000000).optional(),
    // Sale pricing. An empty note clears the tagline; a null previous price
    // ends the sale. The previous price must exceed the current one, otherwise
    // the crossed-out figure would advertise a price rise as a discount.
    note: z.string().trim().max(120).nullable().optional(),
    previous_price_cents: z.number().int().min(0).max(1000000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to change",
  });

const settingsSchema = z.record(z.string().min(1).max(64), z.unknown());

/** Setting keys the admin panel may write. Anything else is refused so a typo
 * cannot plant a dead key that looks configured but does nothing. */
const KNOWN_SETTINGS = new Set(["signups_enabled", "build_executor", "config_environment", "maintenance_mode"]);

function readSettingValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Reads one platform setting with its default. Exported so signup can honour
 * signups_enabled without duplicating the parsing.
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", key)
    .single();

  if (!data) return fallback;
  return readSettingValue((data as { value: unknown }).value) as T ?? fallback;
}

function clampDays(raw: string | undefined): number {
  return Math.min(90, Math.max(7, Number(raw ?? 30) || 30));
}

export interface AuditRow {
  id: string;
  admin_id: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

/**
 * Client- and server-side audit filter. Runs in code (not SQL) so SQLite and
 * Postgres share one path, and so the panel can filter an already-fetched page
 * without another round trip. "all" and empty mean no filtering.
 */
export function filterAuditEntries(entries: AuditRow[], action: string | undefined): AuditRow[] {
  const wanted = (action ?? "").trim();
  if (!wanted || wanted === "all") return entries;
  return entries.filter((entry) => entry.action === wanted);
}

/** Distinct action names for the viewer filter, newest-first by first sight. */
export function auditActions(entries: AuditRow[]): string[] {
  return [...new Set(entries.map((entry) => entry.action))].sort();
}

export interface WebhookRow {
  id: string;
  provider: string;
  event_type: string;
  processed: boolean | number | null;
  created_at: string;
}

/**
 * Webhook inspector filter. Type matches a substring (event names are long
 * and dotted); processed accepts "true"/"false"/"all". Runs in code so both
 * drivers share the path — SQLite stores booleans as 0/1.
 */
export function filterWebhookEvents(
  events: WebhookRow[],
  type: string | undefined,
  processed: string | undefined
): WebhookRow[] {
  const wantType = (type ?? "").trim().toLowerCase();
  const wantProcessed = (processed ?? "all").trim().toLowerCase();
  return events.filter((event) => {
    if (wantType && !event.event_type.toLowerCase().includes(wantType)) return false;
    if (wantProcessed === "true") return event.processed === true || event.processed === 1;
    if (wantProcessed === "false") return !(event.processed === true || event.processed === 1);
    return true;
  });
}

/**
 * Best-effort Whop manage URL for a subscription row. Fetched live, never
 * stored — a stored copy rots when sessions rotate. Null when the row names
 * no membership or Whop cannot be reached; the caller still renders the
 * subscription, just without the button.
 */
export async function subscriptionManageUrl(
  subscription: { whop_membership_id?: string | null }
): Promise<string | null> {
  const membershipId = subscription.whop_membership_id;
  if (!membershipId) return null;
  try {
    const membership = await retrieveMembership(membershipId);
    return membership.manage_url ?? null;
  } catch (err) {
    logger.warn({ err, membershipId }, "Admin subscription detail could not fetch manage URL");
    return null;
  }
}

interface AnalyticsDay {
  date: string;
  signups: number;
  builds_started: number;
  builds_succeeded: number;
  runtime_hours: number;
}

// Shared by the JSON view and the CSV export so the two can never disagree.
async function buildAnalytics(days: number): Promise<{
  days: number;
  series: AnalyticsDay[];
  totals: { signups: number; builds_started: number; builds_succeeded: number; runtime_hours: number };
}> {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);

  const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10);
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(since);
    date.setDate(date.getDate() + i);
    keys.push(date.toISOString().slice(0, 10));
  }

  // Three small queries bucketed in code: portable across SQLite and
  // Postgres, and 90 days of rows is trivially small either way.
  const [{ data: users }, { data: builds }, { data: sessions }] = await Promise.all([
    supabase.from("users").select("created_at"),
    supabase.from("builds").select("status, created_at"),
    supabase.from("runtime_sessions").select("started_at, duration_seconds"),
  ]);

  const empty = () => Object.fromEntries(keys.map((key) => [key, 0]));
  const signups = empty() as Record<string, number>;
  const started = empty() as Record<string, number>;
  const succeeded = empty() as Record<string, number>;
  const runtimeSeconds = empty() as Record<string, number>;

  for (const row of (users ?? []) as { created_at: string }[]) {
    const key = dayKey(row.created_at);
    if (key in signups) signups[key] += 1;
  }
  for (const row of (builds ?? []) as { status: string; created_at: string }[]) {
    const key = dayKey(row.created_at);
    if (!(key in started)) continue;
    started[key] += 1;
    if (row.status === "success") succeeded[key] += 1;
  }
  for (const row of (sessions ?? []) as { started_at: string; duration_seconds: number }[]) {
    const key = dayKey(row.started_at);
    if (key in runtimeSeconds) runtimeSeconds[key] += row.duration_seconds ?? 0;
  }

  const series = keys.map((date) => ({
    date,
    signups: signups[date],
    builds_started: started[date],
    builds_succeeded: succeeded[date],
    runtime_hours: Math.round((runtimeSeconds[date] / 3600) * 10) / 10,
  }));

  const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
  return {
    days,
    series,
    totals: {
      signups: sum(Object.values(signups)),
      builds_started: sum(Object.values(started)),
      builds_succeeded: sum(Object.values(succeeded)),
      runtime_hours: Math.round((sum(Object.values(runtimeSeconds)) / 3600) * 10) / 10,
    },
  };
}

/**
 * Platform administration. Every route here answers for all users at once,
 * which is why each one carries requireAdmin on top of authenticateApiKey.
 * A missing guard on any of these is a cross-account data leak, so the pair
 * is registered once for the whole plugin rather than per route.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);
  app.addHook("preHandler", requireAdmin);

  // Configuration self-check: presence booleans only, never secret values.
  // The common "it works locally but not on the deploy" class of failures is
  // always a missing env var, and reading Render's env list over screenshots
  // is slower than asking the deployment itself.
  app.get("/admin/diagnostics", async (_req, reply) => {
    return reply.send(await collectDiagnostics());
  });

  app.get("/admin/overview", async (req, reply) => {    const [{ data: users }, { data: builds }, capacity] = await Promise.all([
      supabase.from("users").select("id, plan_id"),
      supabase.from("builds").select("id, status, created_at").order("created_at", { ascending: false }).limit(200),
      agentCapacity(),
    ]);

    const userList = (users ?? []) as { id: string; plan_id: string }[];
    const buildList = (builds ?? []) as { id: string; status: string; created_at: string }[];

    // Monthly usage is summed in code rather than SQL: the local SQLite
    // stand-in does not implement aggregates, and user counts are small.
    const { start } = getCurrentPeriod();
    const { data: usageRows } = await supabase
      .from("usage_months")
      .select("runtime_used_seconds, build_count")
      .eq("period_start", start.toISOString());
    const usage = (usageRows ?? []) as { runtime_used_seconds: number; build_count: number }[];

    let runtimes: { status: string }[] = [];
    try {
      const result = await callOrchestrator<{ runtimes: { status: string }[] }>(
        "/runtime/list-all",
        {}
      );
      runtimes = result.runtimes ?? [];
    } catch (err) {
      logger.warn({ err }, "Admin overview could not list runtimes");
    }

    const byPlan: Record<string, number> = {};
    for (const user of userList) {
      byPlan[user.plan_id] = (byPlan[user.plan_id] ?? 0) + 1;
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const buildsToday = buildList.filter(
      (b) => new Date(b.created_at).getTime() >= dayAgo
    );

    return reply.send({
      users: { total: userList.length, by_plan: byPlan },
      runtimes: {
        total: runtimes.length,
        running: runtimes.filter((r) => r.status === "running").length,
        paused: runtimes.filter((r) => r.status === "paused").length,
      },
      builds: {
        today: buildsToday.length,
        succeeded_today: buildsToday.filter((b) => b.status === "success").length,
      },
      usage_month: {
        runtime_used_seconds: usage.reduce((n, u) => n + (u.runtime_used_seconds ?? 0), 0),
        build_count: usage.reduce((n, u) => n + (u.build_count ?? 0), 0),
      },
      capacity,
    });
  });

  app.get("/admin/users", async (req, reply) => {
    // Email substring filter. Applied with LIKE on a lowercased value so both
    // drivers share one code path (the stand-in has no ilike method, and LIKE
    // is ASCII case-insensitive in SQLite while emails are stored lowercase).
    const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    let query = supabase
      .from("users")
      .select("id, email, plan_id, is_admin, is_active, created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (q) query = query.like("email", `%${q}%`);

    const { data, error } = await query;

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to list users" },
      });
    }

    const users = (data ?? []) as {
      id: string;
      email: string;
      plan_id: string;
      is_admin?: boolean | number | null;
      created_at?: string;
    }[];

    // The flag alone is not the whole story: bootstrap and first-user admins
    // resolve at request time, so each row is evaluated the same way the guard
    // evaluates the caller.
    const enriched = await Promise.all(
      users.map(async (user) => ({ ...user, is_admin: await isAdminUser(user) }))
    );

    return reply.send({ users: enriched });
  });

  app.get("/admin/users/export", async (req, reply) => {
    const { data, error } = await supabase
      .from("users")
      .select("id, email, plan_id, is_admin, is_active, created_at")
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to export users" },
      });
    }

    const rows = ((data ?? []) as Record<string, unknown>[]).map((user) => [
      user.id,
      user.email,
      user.plan_id,
      user.is_admin ? "admin" : "",
      user.is_active === false || user.is_active === 0 ? "disabled" : "active",
      user.created_at,
    ]);
    const csv = toCsv(["id", "email", "plan_id", "role", "standing", "created_at"], rows);

    logger.info({ admin: req.auth!.userId, count: rows.length }, "Admin exported users");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="users.csv"')
      .send(csv);
  });

  // Who did what to whom, newest first. Empty (not an error) when migration
  // 0013 is not yet wired in — the audit writes are defensive, so a missing
  // table means no rows rather than a failed request. The optional action
  // filter narrows server-side; the panel also filters client-side for instant
  // switching between actions without refetching.
  app.get("/admin/audit", async (req, reply) => {
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 100));
    const action = (req.query as { action?: string }).action;
    try {
      const { data, error } = await supabase
        .from("admin_audit")
        .select("id, admin_id, action, target, detail, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        logger.warn({ err: error }, "Admin audit table unreadable; returning empty log");
        return reply.send({ entries: [], actions: [], pending_migration: true });
      }
      const rows = (data ?? []) as AuditRow[];
      return reply.send({
        entries: filterAuditEntries(rows, action),
        actions: auditActions(rows),
        pending_migration: false,
      });
    } catch (err) {
      logger.warn({ err }, "Admin audit table unreadable; returning empty log");
      return reply.send({ entries: [], actions: [], pending_migration: true });
    }
  });

  app.patch("/admin/users/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = planChangeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "plan_id is required" },
      });
    }

    if (!(await getPlan(parsed.data.plan_id))) {
      return reply.status(400).send({
        error: { code: "UNKNOWN_PLAN", message: `No plan named ${parsed.data.plan_id}` },
      });
    }

    const { error } = await supabase
      .from("users")
      .update({ plan_id: parsed.data.plan_id })
      .eq("id", id);

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to change the plan" },
      });
    }

      logger.info({ admin: req.auth!.userId, userId: id, plan: parsed.data.plan_id }, "Admin changed user plan");
      await recordAdminAudit(supabase, {
        adminId: req.auth!.userId,
        action: "plan_change",
        target: id,
        detail: `plan -> ${parsed.data.plan_id}`,
      });
      return reply.send({ success: true });
  });

  for (const action of ["disable", "enable"] as const) {
    app.post(`/admin/users/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };

      // An admin cannot disable themselves: the click would succeed and the
      // next request would 403, which reads exactly like the button broke.
      if (action === "disable" && id === req.auth!.userId) {
        return reply.status(400).send({
          error: { code: "CANNOT_DISABLE_SELF", message: "You cannot disable your own admin account" },
        });
      }

      const { error } = await supabase
        .from("users")
        .update({ is_active: action === "enable" })
        .eq("id", id);

      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: `Failed to ${action} the account` },
        });
      }

      // A disabled account must not keep burning quota. Best-effort: whatever
      // fails here is logged and the disable still succeeds — the lease-expiry
      // worker reaps stragglers anyway.
      let stoppedRuntimes = 0;
      if (action === "disable") {
        try {
          const listed = await callOrchestrator<{
            runtimes: { runtime_id: string; user_id: string }[];
          }>("/runtime/list-all", {});
          const owned = (listed.runtimes ?? []).filter((r) => r.user_id === id);
          for (const runtime of owned) {
            try {
              await callOrchestrator("/runtime/stop", {
                runtime_id: runtime.runtime_id,
                user_id: id,
              });
              stoppedRuntimes += 1;
            } catch (err) {
              logger.warn({ err, runtimeId: runtime.runtime_id }, "Disable could not stop a runtime");
            }
          }
        } catch (err) {
          logger.warn({ err, userId: id }, "Disable could not list runtimes");
        }
      }

      logger.info({ admin: req.auth!.userId, userId: id, action, stoppedRuntimes }, "Admin changed account standing");
      await recordAdminAudit(supabase, {
        adminId: req.auth!.userId,
        action,
        target: id,
        detail: action === "disable" ? `stopped ${stoppedRuntimes} runtime(s)` : null,
      });
      return reply.send({ success: true, stopped_runtimes: stoppedRuntimes });
    });
  }

  for (const action of ["promote", "demote"] as const) {
    app.post(`/admin/users/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };

      // Demoting yourself drops your own admin rights with this request, which
      // is a legitimate thing to do but never one to do by accident.
      if (action === "demote" && id === req.auth!.userId) {
        return reply.status(400).send({
          error: { code: "CANNOT_DEMOTE_SELF", message: "You cannot remove your own admin rights here" },
        });
      }

      const { error } = await supabase
        .from("users")
        .update({ is_admin: action === "promote" })
        .eq("id", id);

      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: `Failed to ${action} the account` },
        });
      }

      logger.info({ admin: req.auth!.userId, userId: id, action }, "Admin changed admin flag");
      await recordAdminAudit(supabase, {
        adminId: req.auth!.userId,
        action,
        target: id,
      });
      return reply.send({ success: true });
    });
  }

  app.get("/admin/runtimes", async (req, reply) => {
    let runtimes: Record<string, unknown>[] = [];
    try {
      const result = await callOrchestrator<{ runtimes: Record<string, unknown>[] }>(
        "/runtime/list-all",
        {}
      );
      runtimes = result.runtimes ?? [];
    } catch (err) {
      if (err instanceof OrchestratorError) {
        return reply.status(502).send({
          error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
        });
      }
      throw err;
    }

    // Owner emails are joined here rather than per row: one query for every
    // distinct owner no matter how many runtimes they run.
    const ownerIds = [...new Set(runtimes.map((r) => r.user_id).filter(Boolean))] as string[];
    let emails: Record<string, string> = {};
    if (ownerIds.length > 0) {
      const { data } = await supabase.from("users").select("id, email").in("id", ownerIds);
      emails = Object.fromEntries(
        ((data ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email])
      );
    }

    return reply.send({
      runtimes: runtimes.map((runtime) => ({
        ...runtime,
        owner_email: emails[runtime.user_id as string] ?? null,
      })),
    });
  });

  app.post("/admin/runtimes/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };

    // The orchestrator's stop is ownership-checked, so the owner's own user id
    // travels with the request rather than the admin's.
    const listed = await callOrchestrator<{
      runtimes: { runtime_id: string; user_id: string }[];
    }>("/runtime/list-all", {});
    const target = (listed.runtimes ?? []).find((r) => r.runtime_id === id);

    if (!target) {
      return reply.status(404).send({
        error: { code: "RUNTIME_NOT_FOUND", message: "Runtime not found" },
      });
    }

    try {
      await callOrchestrator("/runtime/stop", {
        runtime_id: id,
        user_id: target.user_id,
      });
    } catch (err) {
      if (err instanceof OrchestratorError && err.code === "RUNTIME_NOT_FOUND") {
        return reply.status(404).send({
          error: { code: "RUNTIME_NOT_FOUND", message: "Runtime not found" },
        });
      }
      logger.error({ err, runtimeId: id }, "Admin runtime stop failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }

    logger.info({ admin: req.auth!.userId, runtimeId: id, owner: target.user_id }, "Admin stopped runtime");
    return reply.send({ success: true });
  });

  app.get("/admin/builds", async (req, reply) => {
    const { data, error } = await supabase
      .from("builds")
      .select("id, user_id, project_id, status, exit_code, workflow_run_id, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to list builds" },
      });
    }

    const builds = (data ?? []) as { user_id: string }[];
    const ownerIds = [...new Set(builds.map((b) => b.user_id).filter(Boolean))];
    let emails: Record<string, string> = {};
    if (ownerIds.length > 0) {
      const { data: users } = await supabase.from("users").select("id, email").in("id", ownerIds);
      emails = Object.fromEntries(
        ((users ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email])
      );
    }

    return reply.send({
      builds: ((data ?? []) as Record<string, unknown>[]).map((build) => ({
        ...build,
        owner_email: emails[(build as { user_id: string }).user_id] ?? null,
      })),
    });
  });

  app.get("/admin/plans", async (req, reply) => {
    return reply.send({ plans: await getAllPlans() });
  });

  app.patch("/admin/plans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = planEditSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid plan values" },
      });
    }

    const current = await getPlan(id);
    if (!current) {
      return reply.status(404).send({
        error: { code: "UNKNOWN_PLAN", message: `No plan named ${id}` },
      });
    }

    // A crossed-out price below the current one is a price rise wearing a
    // discount's clothes. Refused rather than rendered.
    const nextPrice = parsed.data.price_cents ?? current.price_cents;
    if (
      parsed.data.previous_price_cents !== undefined &&
      parsed.data.previous_price_cents !== null &&
      parsed.data.previous_price_cents <= nextPrice
    ) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The previous price must be higher than the current price",
        },
      });
    }

    const { error } = await supabase
      .from("plans")
      .update(parsed.data)
      .eq("id", id);

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to update the plan" },
      });
    }

    logger.info({ admin: req.auth!.userId, plan: id, changes: parsed.data }, "Admin edited plan");
    return reply.send({ success: true });
  });

  app.get("/admin/settings", async (req, reply) => {    const { data } = await supabase.from("platform_settings").select("key, value");
    const settings: Record<string, unknown> = {
      signups_enabled: true,
      build_executor: "auto",
      maintenance_mode: false,
    };
    for (const row of (data ?? []) as { key: string; value: unknown }[]) {
      // SQLite stores the value as text, Postgres as jsonb. Normalise so the
      // panel never shows a quoted string where a toggle belongs.
      settings[row.key] = readSettingValue(row.value);
    }
    return reply.send({ settings });
  });

  app.patch("/admin/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid settings" },
      });
    }

    for (const [key, value] of Object.entries(parsed.data)) {
      if (!KNOWN_SETTINGS.has(key)) {
        return reply.status(400).send({
          error: { code: "UNKNOWN_SETTING", message: `Unknown setting: ${key}` },
        });
      }
      // A typo here would silently pin the deployment to one column with no
      // visible error, so the only accepted values are enumerated.
      if (
        key === "config_environment" &&
        value !== "auto" &&
        value !== "development" &&
        value !== "production"
      ) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "config_environment must be auto, development or production" },
        });
      }
      if (key === "maintenance_mode" && typeof value !== "boolean") {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "maintenance_mode must be true or false" },
        });
      }
    }

    for (const [key, value] of Object.entries(parsed.data)) {
      const { error } = await supabase
        .from("platform_settings")
        .upsert(
          { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: `Failed to save ${key}` },
        });
      }
    }

    logger.info({ admin: req.auth!.userId, settings: parsed.data }, "Admin changed settings");
    if ("maintenance_mode" in parsed.data) {
      await recordAdminAudit(supabase, {
        adminId: req.auth!.userId,
        action: "maintenance_mode",
        detail: `maintenance_mode -> ${String(parsed.data.maintenance_mode)}`,
      });
    }

    // Switching columns takes effect on the next refresh; do it now so the
    // admin sees the result of the flip instead of waiting a minute.
    if ("config_environment" in parsed.data) {
      await loadEnvOverrides();
    }

    return reply.send({ success: true });
  });

  app.get("/admin/env", async (req, reply) => {
    const { data } = await supabase
      .from("env_overrides")
      .select("key, environment, updated_at");

    const setKeys = new Set(
      ((data ?? []) as { key: string; environment: string }[]).map(
        (row) => `${row.key}:${row.environment}`
      )
    );

    // Values are never returned: presence is the whole diagnosis, and a value
    // on this response would land in browser history, logs and screenshots.
    return reply.send({
      keys: MANAGED_ENV_KEYS.map((entry) => ({
        ...entry,
        development_set: setKeys.has(`${entry.key}:development`),
        production_set: setKeys.has(`${entry.key}:production`),
        shell_set: (process.env[entry.key] ?? "").trim().length > 0,
      })),
      active: await getSetting<unknown>("config_environment", "auto"),
      runtime_mode: process.env.NODE_ENV === "production" ? "production" : "development",
    });
  });

  app.get("/admin/env/value", async (req, reply) => {
    const { key, environment } = req.query as { key?: string; environment?: string };
    if (!key || !isManagedKey(key)) {
      return reply.status(400).send({
        error: { code: "UNKNOWN_KEY", message: "That key is not manageable here" },
      });
    }
    if (environment !== "development" && environment !== "production") {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "environment must be development or production" },
      });
    }

    // On-demand single value, never bulk: only the revealed secret transits,
    // and every reveal is logged with who and what so the audit trail shows
    // exactly which secrets were displayed where.
    const { data } = await supabase
      .from("env_overrides")
      .select("value")
      .eq("key", key)
      .eq("environment", environment)
      .single();

    const dbValue = (data as { value?: unknown } | null)?.value;
    if (typeof dbValue === "string" && dbValue) {
      logger.info({ admin: req.auth!.userId, key, environment, source: "db" }, "Admin revealed env value");
      return reply.send({ key, environment, source: "db", value: dbValue });
    }

    const shellValue = (process.env[key] ?? "").trim();
    logger.info({ admin: req.auth!.userId, key, environment, source: shellValue ? "shell" : "unset" }, "Admin revealed env value");
    return reply.send({
      key,
      environment,
      source: shellValue ? "shell" : "unset",
      value: shellValue || null,
    });
  });

  app.put("/admin/env", async (req, reply) => {
    const parsed = z
      .object({
        key: z.string().min(1).max(64),
        environment: z.enum(["development", "production"]),
        // Empty clears back to the shell value. Absent is a caller error, not
        // a clear, so accidental {} bodies cannot wipe configuration.
        value: z.string().max(4000),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request" },
      });
    }

    const { key, environment, value } = parsed.data;
    if (!isManagedKey(key)) {
      return reply.status(400).send({
        error: {
          code: "UNKNOWN_KEY",
          message: "That key is not manageable here. Boot-identity values stay in the shell.",
        },
      });
    }

    // Explicit select-then-write rather than upsert: the local SQLite stand-in
    // only understands single-column conflict targets, and a composite target
    // would generate invalid SQL there while working on Postgres.
    if (value.trim() === "") {
      const { error } = await supabase
        .from("env_overrides")
        .delete()
        .eq("key", key)
        .eq("environment", environment);
      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Could not clear the value" },
        });
      }
    } else {
      const { data: existing } = await supabase
        .from("env_overrides")
        .select("key")
        .eq("key", key)
        .eq("environment", environment)
        .single();

      const row = {
        key,
        environment,
        value: value.trim(),
        updated_at: new Date().toISOString(),
      };
      const { error } = existing
        ? await supabase.from("env_overrides").update(row).eq("key", key).eq("environment", environment)
        : await supabase.from("env_overrides").insert(row);
      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Could not save the value" },
        });
      }
    }

    // Apply now rather than at the next minute tick: the admin just changed
    // this and will immediately test it.
    await loadEnvOverrides();

    logger.info({ admin: req.auth!.userId, key, environment, cleared: value.trim() === "" }, "Admin changed env override");
    // The value itself never lands in the audit row — presence of the change
    // is the record, and a secret in the log defeats the not-shown policy.
    await recordAdminAudit(supabase, {
      adminId: req.auth!.userId,
      action: value.trim() === "" ? "env_clear" : "env_set",
      target: `${key}:${environment}`,
    });
    return reply.send({ success: true });
  });

  app.get("/admin/payments", async (req, reply) => {    const [{ data: subs }, { data: plans }, { data: events }] = await Promise.all([
      supabase.from("subscriptions").select("user_id, plan_id, promo_code, status, current_period_end, cancel_at_period_end, updated_at").order("updated_at", { ascending: false }).limit(500),
      supabase.from("plans").select("id, name, price_cents"),
      supabase.from("webhook_events").select("event_type, created_at, processed").eq("provider", "whop").order("created_at", { ascending: false }).limit(30),
    ]);

    const subscriptions = (subs ?? []) as {
      user_id: string;
      plan_id: string;
      promo_code?: string | null;
      status: string;
      current_period_end: string | null;
      cancel_at_period_end?: boolean | number | null;
      updated_at: string;
    }[];
    const priceByPlan: Record<string, { name: string; price_cents: number }> = {};
    for (const plan of (plans ?? []) as { id: string; name: string; price_cents: number }[]) {
      priceByPlan[plan.id] = { name: plan.name, price_cents: plan.price_cents };
    }

    // MRR counts money expected every month: active subscriptions at their plan
    // price. Past-due still owes and is reported separately as at risk rather
    // than counted, because counting it as revenue hides a collection problem.
    let mrrCents = 0;
    let atRiskCents = 0;
    const byStatus: Record<string, number> = {};
    const byPlan: Record<string, number> = {};
    for (const sub of subscriptions) {
      byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
      if (sub.status === "active") {
        byPlan[sub.plan_id] = (byPlan[sub.plan_id] ?? 0) + 1;
        mrrCents += priceByPlan[sub.plan_id]?.price_cents ?? 0;
      } else if (sub.status === "past_due") {
        atRiskCents += priceByPlan[sub.plan_id]?.price_cents ?? 0;
      }
    }

    const ownerIds = [...new Set(subscriptions.map((s) => s.user_id).filter(Boolean))];
    let emails: Record<string, string> = {};
    if (ownerIds.length > 0) {
      const { data: users } = await supabase.from("users").select("id, email").in("id", ownerIds);
      emails = Object.fromEntries(
        ((users ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email])
      );
    }

    return reply.send({
      mrr_cents: mrrCents,
      at_risk_cents: atRiskCents,
      by_status: byStatus,
      by_plan: byPlan,
      subscriptions: subscriptions.slice(0, 100).map((sub) => ({
        ...sub,
        owner_email: emails[sub.user_id] ?? null,
        plan_name: priceByPlan[sub.plan_id]?.name ?? sub.plan_id,
      })),
      // Individual charges live in Whop, which owns the money. The local event
      // log shows what the platform saw and when, which is what reconciles a
      // "why was I charged" question to an actual subscription change.
      recent_events: ((events ?? []) as { event_type: string; created_at: string; processed?: boolean | number | null }[]).map((event) => ({
        ...event,
        note: "Full transaction history lives in the Whop dashboard.",
      })),
    });
  });

  // One subscription with its owner and the platform's view of billing events.
  // Charges themselves live in Whop; this is the reconciliation view for a
  // "why was I charged" question, not a ledger.
  app.get("/admin/subscriptions/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };

    const [{ data: sub }, { data: owner }, { data: events }] = await Promise.all([
      supabase.from("subscriptions").select("*").eq("user_id", userId).single(),
      supabase.from("users").select("id, email, plan_id, is_admin, is_active, created_at").eq("id", userId).single(),
      supabase.from("webhook_events").select("event_type, created_at, processed").eq("provider", "whop").order("created_at", { ascending: false }).limit(20),
    ]);

    if (!sub) {
      return reply.status(404).send({
        error: { code: "SUBSCRIPTION_NOT_FOUND", message: "No subscription for that account" },
      });
    }

    // Live manage link for the modal's "Manage in Whop" button. Best-effort:
    // a missing link hides the button, never the subscription.
    const manageUrl = await subscriptionManageUrl(
      sub as { whop_membership_id?: string | null }
    );

    return reply.send({
      subscription: sub,
      owner: owner ?? null,
      recent_events: events ?? [],
      manage_url: manageUrl,
    });
  });

  // Webhook event inspector. Payloads are excluded on purpose: they carry raw
  // customer data and would drown the response — the inspector answers "what
  // arrived and did we act on it", and the full body waits in the database.
  app.get("/admin/webhooks", async (req, reply) => {
    const query = req.query as { type?: string; processed?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    try {
      const { data, error } = await supabase
        .from("webhook_events")
        .select("id, provider, event_type, processed, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        logger.warn({ err: error }, "Admin webhook table unreadable; returning empty log");
        return reply.send({ events: [], event_types: [], pending_migration: true });
      }
      const rows = (data ?? []) as WebhookRow[];
      return reply.send({
        events: filterWebhookEvents(rows, query.type, query.processed),
        event_types: [...new Set(rows.map((row) => row.event_type))].sort(),
        pending_migration: false,
      });
    } catch (err) {
      logger.warn({ err }, "Admin webhook table unreadable; returning empty log");
      return reply.send({ events: [], event_types: [], pending_migration: true });
    }
  });

  app.get("/admin/analytics", async (req, reply) => {
    const days = clampDays((req.query as { days?: string }).days);
    return reply.send(await buildAnalytics(days));
  });

  app.get("/admin/analytics/export", async (req, reply) => {
    const days = clampDays((req.query as { days?: string }).days);
    const { series } = await buildAnalytics(days);
    const csv = toCsv(
      ["date", "signups", "builds_started", "builds_succeeded", "runtime_hours"],
      series.map((day) => [day.date, day.signups, day.builds_started, day.builds_succeeded, day.runtime_hours])
    );

    logger.info({ admin: req.auth!.userId, days }, "Admin exported analytics");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="analytics.csv"')
      .send(csv);
  });

  app.post("/admin/subscriptions/attach", async (req, reply) => {    const brake = checkRateLimit(`admin:attach:${req.ip}`, 10, 60_000);
    // Same sliding-window brake as the auth endpoints: attaching moves real
    // money between accounts, so a shared-secret leak must not allow a flood.
    if (!brake.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many attach attempts. Wait a moment and try again.",
          retry_after_seconds: brake.retryAfterSeconds,
        },
      });
    }

    const parsed = z
      .object({
        user_email: z.string().trim().email().max(254).optional(),
        user_id: z.string().min(1).max(64).optional(),
        whop_membership_id: z.string().trim().min(1).max(64),
      })
      .refine((value) => value.user_email || value.user_id, {
        message: "Provide user_email or user_id",
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request" },
      });
    }

    const { user_email, user_id, whop_membership_id } = parsed.data;

    const lookupColumn = user_email ? "email" : "id";
    const lookupValue = user_email ? user_email.toLowerCase() : user_id!;
    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq(lookupColumn, lookupValue)
      .single();

    const account = user as { id: string; email: string } | null;
    if (!account) {
      return reply.status(404).send({
        error: { code: "USER_NOT_FOUND", message: "No account matches" },
      });
    }

    let membership;
    try {
      membership = await retrieveMembership(whop_membership_id);
    } catch (err) {
      logger.warn({ err, whop_membership_id }, "Admin attach could not read membership");
      return reply.status(502).send({
        error: { code: "WHOP_UNREACHABLE", message: "Could not read that membership from Whop" },
      });
    }

    // Only membership objects back a subscription. Payments (pay_…) and
    // refunds (re_…) resolve in lookup but corrupt the row the same way the
    // webhook once did, so they are refused with a message that says what to
    // paste instead.
    if (!membership.id.startsWith("mem_")) {
      return reply.status(400).send({
        error: {
          code: "NOT_A_MEMBERSHIP",
          message: "That id is not a membership (memberships start with mem_). Paste the membership id from the Whop dashboard, not the payment id.",
        },
      });
    }

    // A membership carrying another account's id refuses to attach: without
    // this, a pasted id could move anyone's payment onto anyone's account.
    // Memberships with no embedded id attach on the admin's explicit say-so.
    const embedded = membership.metadata?.user_id;
    if (typeof embedded === "string" && embedded && embedded !== account.id) {
      return reply.status(409).send({
        error: { code: "MEMBERSHIP_OWNED", message: "That membership belongs to a different account" },
      });
    }

    const planId = planIdFromMembership(membership.metadata ?? {}, null);
    if (!planId || !(await getPlan(planId))) {
      return reply.status(400).send({
        error: { code: "UNKNOWN_PLAN", message: "That membership names no known plan" },
      });
    }

    const liveStatus = String(membership.status ?? "").toLowerCase();
    if (["canceled", "expired", "deactivated", "completed"].includes(liveStatus)) {
      return reply.status(400).send({
        error: { code: "MEMBERSHIP_DEAD", message: `That membership is ${liveStatus}, not billable` },
      });
    }
    const status = membership.cancel_at_period_end ? "canceled" : "active";

    const now = new Date().toISOString();
    const { error } = await supabase.from("subscriptions").upsert(
      {
        user_id: account.id,
        plan_id: planId,
        whop_membership_id: membership.id,
        whop_plan_id: whopPlanIdOf(membership),
        status,
        current_period_end: membership.current_period_end ?? null,
        cancel_at_period_end: membership.cancel_at_period_end ?? false,
        updated_at: now,
      },
      { onConflict: "user_id" }
    );
    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not store the subscription" },
      });
    }

    await supabase
      .from("users")
      .update({ plan_id: planId })
      .eq("id", account.id);

    logger.info(
      { admin: req.auth!.userId, userId: account.id, membershipId: membership.id, planId },
      "Admin attached Whop membership"
    );
    await recordAdminAudit(supabase, {
      adminId: req.auth!.userId,
      action: "subscription_attach",
      target: account.id,
      detail: `${membership.id} -> ${planId} (${status})`,
    });
    // The manage URL is fetched live, never stored — by the time anyone reads
    // a stored copy it may point at a rotated session. Missing hides nothing
    // here: the attach already succeeded, and the billing page fetches its own.
    let manageUrl: string | null = null;
    try {
      const fresh = await retrieveMembership(membership.id);
      manageUrl = fresh.manage_url ?? null;
    } catch (err) {
      logger.warn({ err, membershipId: membership.id }, "Admin attach could not fetch manage URL");
    }
    return reply.send({ success: true, plan_id: planId, status, manage_url: manageUrl });
  });

  app.get("/admin/db", async (_req, reply) => {
    return reply.send({
      driver: usingSqlite ? "sqlite" : "supabase",
      raw_sql: usingSqlite,
      tables: DB_TABLES.map((table) => ({ name: table.name, description: table.description })),
    });
  });

  // Per-table row counts. Null means the table could not be read — typically a
  // migration not yet applied — and renders as "unknown", never as zero.
  app.get("/admin/db/counts", async (_req, reply) => {
    return reply.send({ driver: usingSqlite ? "sqlite" : "supabase", tables: await collectTableCounts() });
  });

  app.get("/admin/db/rows", async (req, reply) => {
    const { table, limit } = req.query as { table?: string; limit?: string };
    const entry = DB_TABLES.find((candidate) => candidate.name === table);
    if (!entry) {
      return reply.status(400).send({
        error: { code: "UNKNOWN_TABLE", message: "That table is not browsable" },
      });
    }

    const count = Math.min(200, Math.max(1, Number(limit) || 50));
    const { data, error } = await supabase.from(entry.name).select(entry.columns).limit(count);
    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not read the table" },
      });
    }

    // Long cells (build logs, payloads) would drown the response and the UI,
    // so values arrive truncated with their full length noted.
    return reply.send({
      table: entry.name,
      rows: ((data ?? []) as Record<string, unknown>[]).map((row) => {
        const clipped: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          clipped[key] =
            typeof value === "string" && value.length > 500
              ? `${value.slice(0, 500)}… (${value.length} chars)`
              : value;
        }
        return clipped;
      }),
    });
  });

  app.post("/admin/db/query", async (req, reply) => {
    // Raw execution exists only where the driver allows it: node:sqlite runs
    // anything, PostgREST runs table queries. Offering a fake textarea on
    // Supabase that secretly whitelists statements would be dishonest, so
    // production gets a clear refusal pointing at the dashboard SQL editor.
    if (!usingSqlite) {
      return reply.status(400).send({
        error: {
          code: "SQL_NOT_SUPPORTED",
          message: "Raw SQL runs on development SQLite only. Use the Supabase dashboard SQL editor for production.",
        },
      });
    }

    const parsed = z
      .object({ sql: z.string().trim().min(1).max(20000) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Provide a SQL statement" },
      });
    }

    const client = supabase as unknown as {
      execRaw?: (sql: string) => { columns: string[]; rows: Record<string, unknown>[] };
    };
    if (typeof client.execRaw !== "function") {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Raw execution is unavailable" },
      });
    }

    let result;
    try {
      result = client.execRaw(parsed.data.sql);
    } catch (err) {
      return reply.status(400).send({
        error: { code: "SQL_ERROR", message: err instanceof Error ? err.message : "Query failed" },
      });
    }

    logger.info(
      { admin: req.auth!.userId, sql: parsed.data.sql.slice(0, 200), rows: result.rows.length },
      "Admin ran raw SQL"
    );

    const clipped = result.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[key] =
          typeof value === "string" && value.length > 500
            ? `${value.slice(0, 500)}… (${value.length} chars)`
            : value;
      }
      return out;
    });

    return reply.send({ columns: result.columns, rows: clipped });
  });
}
