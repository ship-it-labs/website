import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import { callOrchestrator } from "../services/orchestrator-client.js";
import { OrchestratorError } from "../routes/runtimes.js";
import { getPlan, getAllPlans } from "../services/plan-service.js";
import {
  retrieveMembership,
  planIdFromMembership,
} from "../services/whop-service.js";
import { collectDiagnostics } from "../services/diagnostics.js";
import { getCurrentPeriod } from "../services/quota-service.js";
import { isAdminUser } from "../services/admin.js";
import { logger } from "../utils/logger.js";

/**
 * Platform administration. Every route here answers for all users at once,
 * which is why each one carries requireAdmin on top of authenticateApiKey.
 * A missing guard on any of these is a cross-account data leak, so the pair
 * is registered once for the whole plugin rather than per route.
 */

const MANAGER_URL = process.env.SERVER_MANAGER_URL || "http://manager:3001";
const MANAGER_SECRET = process.env.ORCHESTRATOR_SECRET || "";

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
  if (!MANAGER_SECRET) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${MANAGER_URL}/api/v1/agents/online`, {
        headers: { "x-service-secret": MANAGER_SECRET },
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
const KNOWN_SETTINGS = new Set(["signups_enabled", "build_executor"]);

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
    const { data, error } = await supabase
      .from("users")
      .select("id, email, plan_id, is_admin, is_active, created_at")
      .order("created_at", { ascending: false })
      .limit(500);

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

      logger.info({ admin: req.auth!.userId, userId: id, action }, "Admin changed account standing");
      return reply.send({ success: true });
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
    return reply.send({ success: true });
  });

  app.get("/admin/payments", async (req, reply) => {    const [{ data: subs }, { data: plans }, { data: events }] = await Promise.all([
      supabase.from("subscriptions").select("user_id, plan_id, status, current_period_end, cancel_at_period_end, updated_at").order("updated_at", { ascending: false }).limit(500),
      supabase.from("plans").select("id, name, price_cents"),
      supabase.from("webhook_events").select("event_type, created_at, processed").eq("provider", "whop").order("created_at", { ascending: false }).limit(30),
    ]);

    const subscriptions = (subs ?? []) as {
      user_id: string;
      plan_id: string;
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

  app.get("/admin/analytics", async (req, reply) => {
    const days = Math.min(
      90,
      Math.max(7, Number((req.query as { days?: string }).days ?? 30) || 30)
    );

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

    return reply.send({
      days,
      series: keys.map((date) => ({
        date,
        signups: signups[date],
        builds_started: started[date],
        builds_succeeded: succeeded[date],
        runtime_hours: Math.round((runtimeSeconds[date] / 3600) * 10) / 10,
      })),
      totals: {
        signups: Object.values(signups).reduce((n, v) => n + v, 0),
        builds_started: Object.values(started).reduce((n, v) => n + v, 0),
        builds_succeeded: Object.values(succeeded).reduce((n, v) => n + v, 0),
        runtime_hours: Math.round((Object.values(runtimeSeconds).reduce((n, v) => n + v, 0) / 3600) * 10) / 10,
      },
    });
  });

  app.post("/admin/subscriptions/attach", async (req, reply) => {
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
        whop_plan_id: membership.plan_id,
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
    return reply.send({ success: true, plan_id: planId, status });
  });
}
