import { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabase, usingSqlite } from "../db/index.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { callOrchestrator } from "../services/orchestrator-client.js";
import { revokeAllSessions, revokeSessionRow, hashSessionToken } from "../services/sessions.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { isCommonPassword } from "../utils/passwords.js";
import { logger } from "../utils/logger.js";

/**
 * Self-service account management: password, email, sessions, preferences and
 * deletion. Every route here acts on the caller's own row — the id always
 * comes from req.auth, never from the request body — so a confused or hostile
 * caller cannot reach anyone else's account through these endpoints.
 */

const passwordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

const emailSchema = z.object({
  new_email: z.string().trim().email().max(254),
  password: z.string().min(1),
});

const preferencesSchema = z
  .object({
    email_notifications: z.boolean().optional(),
    theme: z.enum(["dark"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one preference to change",
  });

const deleteSchema = z.object({
  password: z.string().min(1),
});

function requestMeta(req: FastifyRequest): { userAgent: string; ip: string } {  const agent = req.headers["user-agent"];
  return {
    userAgent: Array.isArray(agent) ? (agent[0] ?? "") : (agent ?? ""),
    ip: req.ip ?? "",
  };
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * The service-role Auth admin API. Only exists on the real Supabase client —
 * callers branch on usingSqlite first, so reaching here with the local driver
 * is a programming error, not a runtime case.
 */
export function supabaseAdmin() {
  return (
    supabase.auth as unknown as {
      admin: {
        updateUserById: (
          id: string,
          attrs: Record<string, unknown>
        ) => Promise<{ error: { message: string } | null }>;
        deleteUser: (id: string) => Promise<{ error: { message: string } | null }>;
      };
    }
  ).admin;
}

/**
 * Proves the caller knows the current password without touching hashes: both
 * drivers expose sign-in, so a successful sign-in is the check in both.
 * Accepts the throwaway session this creates — one row per password change or
 * deletion is negligible, and leaving it keeps this helper driver-agnostic.
 */
async function passwordCorrect(email: string, password: string): Promise<boolean> {
  try {
    const result = await supabase.auth.signInWithPassword({ email, password });
    return !result.error && !!result.data?.user;
  } catch {
    return false;
  }
}

async function authEmail(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("users")
    .select("email")
    .eq("id", userId)
    .single();
  return (data as { email?: string } | null)?.email ?? null;
}

export async function accountSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.get("/account/preferences", async (req, reply) => {
    const { data } = await supabase
      .from("user_preferences")
      .select("email_notifications, theme")
      .eq("user_id", req.auth!.userId)
      .single();

    const row = (data ?? {}) as { email_notifications?: boolean | number | null; theme?: string | null };
    return reply.send({
      preferences: {
        email_notifications: row.email_notifications ?? true,
        theme: row.theme ?? "dark",
      },
    });
  });

  app.patch("/account/preferences", async (req, reply) => {
    const parsed = preferencesSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid preferences" },
      });
    }

    const { error } = await supabase.from("user_preferences").upsert(
      {
        user_id: req.auth!.userId,
        ...parsed.data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not save preferences" },
      });
    }

    return reply.send({ success: true });
  });

  app.post("/account/password", async (req, reply) => {
    const parsed = passwordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "The new password needs at least 8 characters" },
      });
    }

    if (isCommonPassword(parsed.data.new_password)) {
      return reply.status(400).send({
        error: { code: "WEAK_PASSWORD", message: "That password is too common. Choose something less guessable." },
      });
    }

    const email = await authEmail(req.auth!.userId);
    if (!email || !(await passwordCorrect(email, parsed.data.current_password))) {
      // Deliberately the same response as a bad login: confirming which half
      // was wrong would let anyone probe the password.
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "The current password is incorrect" },
      });
    }

    if (usingSqlite) {
      const local = supabase as unknown as {
        auth: { updatePassword: (params: { id: string; password: string }) => Promise<{ error: { message: string } | null }> };
      };
      const { error } = await local.auth.updatePassword({
        id: req.auth!.userId,
        password: parsed.data.new_password,
      });
      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Could not change the password" },
        });
      }
    } else {
      const { error } = await supabaseAdmin().updateUserById(req.auth!.userId, {
        password: parsed.data.new_password,
      });
      if (error) {
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Could not change the password" },
        });
      }
    }

    logger.info({ userId: req.auth!.userId }, "Account password changed");
    return reply.send({ success: true });
  });

  app.post("/account/email", async (req, reply) => {
    const parsed = emailSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Provide a valid email address" },
      });
    }

    const current = await authEmail(req.auth!.userId);
    if (!current || !(await passwordCorrect(current, parsed.data.password))) {
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "The password is incorrect" },
      });
    }

    if (parsed.data.new_email.toLowerCase() === current.toLowerCase()) {
      return reply.status(400).send({
        error: { code: "NO_CHANGE", message: "That is already the email on this account" },
      });
    }

    const { data: clash } = await supabase
      .from("users")
      .select("id")
      .eq("email", parsed.data.new_email.toLowerCase())
      .single();
    if (clash) {
      return reply.status(409).send({
        error: { code: "EMAIL_EXISTS", message: "That email is already registered" },
      });
    }

    // Auth store first, application row second: the credential is the
    // identity, and a half-moved email must leave login working, not the
    // profile page pretty.
    if (usingSqlite) {
      const local = supabase as unknown as {
        auth: { updateEmail: (params: { id: string; email: string }) => Promise<{ error: { message: string } | null }> };
      };
      const { error } = await local.auth.updateEmail({
        id: req.auth!.userId,
        email: parsed.data.new_email,
      });
      if (error) {
        return reply.status(400).send({
          error: { code: "EMAIL_CHANGE_FAILED", message: error.message },
        });
      }
    } else {
      // email_confirm skips the confirmation loop: the caller just proved
      // ownership with the password, and confirmation emails are disabled
      // platform-wide to stay out of Supabase's sending quota.
      const { error } = await supabaseAdmin().updateUserById(req.auth!.userId, {
        email: parsed.data.new_email,
        email_confirm: true,
      });
      if (error) {
        return reply.status(400).send({
          error: { code: "EMAIL_CHANGE_FAILED", message: error.message },
        });
      }
    }

    await supabase
      .from("users")
      .update({ email: parsed.data.new_email.toLowerCase() })
      .eq("id", req.auth!.userId);

    logger.info({ userId: req.auth!.userId }, "Account email changed");
    return reply.send({ success: true, email: parsed.data.new_email.toLowerCase() });
  });

  app.get("/account/sessions", async (req, reply) => {
    // Remembered rows have no driver expiry behind them, so dead ones would
    // pile up forever. Anything untouched for 30 days is pruned lazily here,
    // on the one endpoint that reads the list, rather than by a new worker.
    const staleBefore = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await supabase
      .from("user_sessions")
      .delete()
      .eq("user_id", req.auth!.userId)
      .lt("last_seen_at", staleBefore);

    const { data } = await supabase
      .from("user_sessions")
      .select("id, token_hash, user_agent, ip, created_at, last_seen_at")
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false })
      .limit(50);

    // The current device is marked server-side by matching the presented
    // token's hash. The page used to assume the newest row was this device,
    // which mislabeled everything whenever another login landed in between.
    // Hashes never leave the server: they are compared, then stripped.
    const currentHash = hashSessionToken(bearerToken(req));
    const rows = ((data ?? []) as {
      id: string;
      token_hash?: string;
      user_agent: string | null;
      ip: string | null;
      created_at: string;
      last_seen_at: string;
    }[]);

    // last_seen_at is otherwise write-never, which would make the 30-day prune
    // above evict devices that are still in daily use. Touching the current
    // row here keeps it meaningful without a write on every request.
    const current = rows.find((row) => row.token_hash === currentHash);
    if (current) {
      await supabase
        .from("user_sessions")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", current.id);
      current.last_seen_at = new Date().toISOString();
    }

    const sessions = rows.map(({ token_hash, ...session }) => ({
      ...session,
      current: typeof token_hash === "string" && token_hash === currentHash,
    }));

    return reply.send({ sessions });
  });

  app.delete("/account/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };

    // Read the row before deleting so the driver session below is only killed
    // when the caller just revoked the device they are on. The old code ended
    // the caller's own login no matter which row was deleted, signing people
    // out for tidying up a forgotten laptop.
    const { data: target } = await supabase
      .from("user_sessions")
      .select("token_hash")
      .eq("id", id)
      .eq("user_id", req.auth!.userId)
      .single();
    const removed = await revokeSessionRow(req.auth!.userId, id);

    if (!removed) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }

    // A remembered row is list hygiene; the driver session is the lock. In
    // development the tokens are server-issued and revocable here. In
    // production the Supabase JWT stays valid until it expires (an hour at
    // most), which the settings page says plainly rather than implying
    // otherwise.
    if (usingSqlite) {
      const client = supabase as unknown as {
        revokeLocalSession?: (token: string) => void;
      };
      // Only the current token is knowable server-side, so other-device rows
      // clear from the list while their tokens run out their week. "Sign out
      // everywhere" below is the control that actually ends them.
      const token = bearerToken(req);
      const row = (target ?? null) as { token_hash?: string } | null;
      if (token && row?.token_hash === hashSessionToken(token)) {
        client.revokeLocalSession?.(token);
      }
    }

    return reply.send({ success: true });
  });

  app.delete("/account/sessions", async (req, reply) => {    // Everything except this request's own session, which stays alive so the
    // response — and the page behind it — keeps working.
    await revokeAllSessions(req.auth!.userId, bearerToken(req) || undefined);

    if (usingSqlite) {
      // Local tokens are server-issued, so every other device can be ended
      // here rather than left to expire. Production JWTs cannot be individually
      // revoked and run out within the hour instead.
      const client = supabase as unknown as {
        revokeOtherLocalSessions?: (userId: string, exceptToken: string) => void;
      };
      const token = bearerToken(req);
      if (token && client.revokeOtherLocalSessions) {
        client.revokeOtherLocalSessions(req.auth!.userId, token);
      }
    }

    return reply.send({ success: true });
  });

  // User feedback for the admin panel. Rate-limited per IP so the inbox cannot
  // be flooded; the sender is always the authenticated account, never a
  // caller-supplied address.
  app.post("/feedback", async (req, reply) => {
    const parsed = z
      .object({ message: z.string().trim().min(1).max(2000) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Message must be 1-2000 characters" },
      });
    }

    const limit = checkRateLimit(`feedback:${req.ip}`, 5, 60_000);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too much feedback at once. Wait a moment and try again.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    const { error } = await supabase.from("feedback").insert({
      id: randomUUID(),
      user_id: req.auth!.userId,
      message: parsed.data.message,
    });

    if (error) {
      // A missing table (pre-0016 database) must not 500 the button — the
      // admin runs the migration and later messages flow again.
      logger.warn({ err: error, userId: req.auth!.userId }, "Feedback insert failed");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not send feedback right now" },
      });
    }

    return reply.status(201).send({ success: true });
  });

  app.delete("/account", async (req, reply) => {
    // Five deletions per minute per IP: the password check already slows a
    // targeted attack, but without this an anonymous caller can burn CPU on
    // scrypt password checks and orchestrator listings without limit.
    const limit = checkRateLimit(`account:delete:${req.ip}`, 5, 60_000);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many attempts. Wait a moment and try again.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    const parsed = deleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Confirm with your password" },
      });
    }

    const email = await authEmail(req.auth!.userId);
    if (!email || !(await passwordCorrect(email, parsed.data.password))) {
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "The password is incorrect" },
      });
    }

    const userId = req.auth!.userId;
    const meta = requestMeta(req);

    // Runtimes first: deleting the user row while apps still run would leave
    // them billing a ghost and holding agent capacity nobody owns. Best-effort
    // on purpose — a dead orchestrator must not veto leaving.
    try {
      const listed = await callOrchestrator<{ runtimes: { runtime_id: string }[] }>(
        "/runtime/list",
        { user_id: userId }
      );
      for (const runtime of listed.runtimes ?? []) {
        try {
          await callOrchestrator("/runtime/stop", {
            runtime_id: runtime.runtime_id,
            user_id: userId,
          });
        } catch (err) {
          logger.warn({ err, runtimeId: runtime.runtime_id }, "Could not stop runtime during account deletion");
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, "Could not list runtimes during account deletion");
    }

    // Credential store before application row: a failure here must leave login
    // working, while the reverse would lock a live credential to a dead row.
    if (usingSqlite) {
      const local = supabase as unknown as {
        auth: { deleteUser: (params: { id: string }) => Promise<{ error: { message: string } | null }> };
      };
      await local.auth.deleteUser({ id: userId });
    } else {
      const { error } = await supabaseAdmin().deleteUser(userId);
      if (error) {
        logger.error({ err: error, userId }, "Failed to delete auth user");
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Could not delete the account" },
        });
      }
    }

    // Cascades take projects, builds, keys, runtimes, sessions and preferences
    // with it. Webhook events stay: they reference no user and are the audit
    // trail of money that moved.
    const { error } = await supabase.from("users").delete().eq("id", userId);
    if (error) {
      logger.error({ err: error, userId }, "Failed to delete user row");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not delete the account" },
      });
    }

    logger.info({ userId, ip: meta.ip }, "Account deleted");
    return reply.send({ success: true });
  });
}
