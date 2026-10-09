import { FastifyInstance, FastifyReply } from "fastify";
import { supabase, usingSqlite } from "../db/index.js";
import { generateApiKey } from "../utils/api-key.js";
import { isCommonPassword } from "../utils/passwords.js";
import { seedPlans } from "../services/plan-service.js";
import { BOOTSTRAP_ADMIN_EMAIL } from "../services/admin.js";
import { recordSession, hashSessionToken } from "../services/sessions.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { supabaseAdmin } from "./account.js";
import { getSetting } from "./admin.js";
import { logger } from "../utils/logger.js";

interface LocalCredentials {
  data: { user: { id: string; email: string } | null; session?: { access_token?: string } | null };
  error: { message: string } | null;
}

async function localSignUp(email: string, password: string): Promise<LocalCredentials> {
  const result = await supabase.auth.signUp({ email, password });
  const data = result.data as LocalCredentials["data"];
  return { data, error: result.error as LocalCredentials["error"] };
}

async function localSignIn(email: string, password: string): Promise<LocalCredentials> {
  const result = await supabase.auth.signInWithPassword({ email, password });
  const data = result.data as LocalCredentials["data"];
  return { data, error: result.error as LocalCredentials["error"] };
}

/**
 * True when a new account should start life as an admin: it is the first row
 * in the table, or it carries the bootstrap owner's address.
 *
 * Read as "is there any row at all" rather than a count, because the local
 * SQLite stand-in does not implement Supabase's head/count options. Two
 * simultaneous first signups can still race, but the loser only misses the
 * flag — the request-time email and order checks in isAdminUser still grant
 * access, so a wrong denial here is safe and a wrong grant is impossible.
 */
async function shouldStartAsAdmin(email: string): Promise<boolean> {
  if (email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) return true;

  try {
    const { data } = await supabase
      .from("users")
      .select("id")
      .limit(1)
      .single();

    return !data;
  } catch (err) {
    logger.warn({ err }, "Admin first-user check failed during signup");
    return false;
  }
}

/**
 * One-minute sliding-window brake. True when the caller is over the limit, in
 * which case the 429 is already sent and the handler returns. Limits live
 * next to each route so a reader sees the budget where it is spent.
 */
function limited(reply: FastifyReply, key: string, limit: number): boolean {
  const result = checkRateLimit(key, limit, 60_000);
  if (result.allowed) return false;
  reply.status(429).send({
    error: {
      code: "RATE_LIMITED",
      message: "Too many attempts. Wait a moment and try again.",
      retry_after_seconds: result.retryAfterSeconds,
    },
  });
  return true;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {  app.post("/auth/signup", async (req, reply) => {
    // Cheap abuse brake before any work: fake accounts are free to mint and
    // expensive to host. Per IP, not per email — per-email limits let anyone
    // lock anyone else out of signing up.
    if (limited(reply, `auth:signup:${req.ip}`, 10)) return;

    const { email, password } = req.body as { email: string; password: string };

    // Accounts are keyed by lowercase email everywhere downstream (the clash
    // check, the row, the response), so normalize once up front. Without this
    // "User@x.com" and "user@x.com" both passed the clash check and the second
    // insert died on the unique constraint with a 500.
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!normalizedEmail || !password) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "email and password are required" },
      });
    }

    if (password.length < 8) {
      return reply.status(400).send({
        error: { code: "WEAK_PASSWORD", message: "Password must be at least 8 characters" },
      });
    }

    if (isCommonPassword(password)) {
      return reply.status(400).send({
        error: { code: "WEAK_PASSWORD", message: "That password is too common. Choose something less guessable." },
      });
    }

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .single();

    if (existing) {
      return reply.status(409).send({
        error: { code: "EMAIL_EXISTS", message: "That email is already registered" },
      });
    }

    // The admin panel can close signups. Checked before any credential is
    // created so a refused signup leaves nothing behind to clean up.
    if (!(await getSetting<boolean>("signups_enabled", true))) {
      return reply.status(403).send({
        error: { code: "SIGNUPS_DISABLED", message: "Signups are currently disabled" },
      });
    }

    await seedPlans();

    // The driver owns credential storage: Supabase Auth in production, the
    // local scrypt store in development. Either returns the new account.
    const credentials = await localSignUp(normalizedEmail, password);

    if (credentials.error) {
      return reply.status(400).send({
        error: { code: "SIGNUP_FAILED", message: credentials.error.message },
      });
    }

    const userId = credentials.data.user?.id;
    const session = credentials.data.session;

    if (!userId) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Signup did not produce an account" },
      });
    }

    const { error: userError } = await supabase.from("users").insert({
      id: userId,
      email: normalizedEmail,
      plan_id: "free",
      // The first account owns the platform, and the bootstrap address owns it
      // no matter when it arrives. Either fact alone is enough; the request-time
      // check in isAdminUser covers databases created before this column existed.
      is_admin: (await shouldStartAsAdmin(normalizedEmail)) ? true : false,
    });

    if (userError) {
      logger.error({ err: userError, email: normalizedEmail }, "Failed to create user row");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not create the account" },
      });
    }

    const { key, hash, prefix } = generateApiKey();
    const keyId = `key_${userId.slice(0, 8)}_${Date.now().toString(36)}`;
    const { error: keyError } = await supabase.from("api_keys").insert({
      id: keyId,
      user_id: userId,
      key_hash: hash,
      key_prefix: prefix,
      name: "default",
      is_active: true,
    });

    if (keyError) {
      logger.error({ err: keyError, userId }, "Failed to create initial API key");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not create the account" },
      });
    }

    // Remembered for the settings device list and revocation. Best-effort:
    // a recording failure must never fail the signup it belongs to.
    if (session?.access_token) {
      const agent = req.headers["user-agent"];
      await recordSession({
        userId,
        token: session.access_token,
        userAgent: Array.isArray(agent) ? (agent[0] ?? "") : (agent ?? ""),
        ip: req.ip ?? "",
      });
    }

    return reply.status(201).send({
      user: { id: userId, email: normalizedEmail },
      api_key: key,
      session: session?.access_token ? { access_token: session.access_token } : null,
    });
  });

  app.post("/auth/login", async (req, reply) => {
    // 30 attempts per minute per IP: enough for a human retrying a password,
    // slow enough to make credential stuffing uneconomical.
    if (limited(reply, `auth:login:${req.ip}`, 30)) return;

    const { email, password } = req.body as { email: string; password: string };
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!normalizedEmail || !password) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "email and password are required" },
      });
    }

    const credentials = await localSignIn(normalizedEmail, password);

    if (credentials.error || !credentials.data.user) {
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
      });
    }

    const session = credentials.data.session;

    const { data: user } = await supabase
      .from("users")
      .select("id, email, plan_id, is_active")
      .eq("id", credentials.data.user.id)
      .single();

    if (user?.is_active === false || user?.is_active === 0) {
      return reply.status(403).send({
        error: { code: "ACCOUNT_DISABLED", message: "This account has been disabled. Contact support." },
      });
    }

    if (session?.access_token) {
      const agent = req.headers["user-agent"];
      await recordSession({
        userId: credentials.data.user.id,
        token: session.access_token,
        userAgent: Array.isArray(agent) ? (agent[0] ?? "") : (agent ?? ""),
        ip: req.ip ?? "",
      });
    }

    return reply.send({
      user: user ?? { id: credentials.data.user.id, email: normalizedEmail },
      session: session?.access_token ? { access_token: session.access_token } : null,
    });
  });

  app.post("/auth/logout", async (req, reply) => {
    // Forget the remembered row for this token, if one was presented. The
    // driver sign-out below is best-effort as before; clearing the local
    // session is what actually ends the browser's access.
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7).trim();
      try {
        const { data } = await supabase
          .from("user_sessions")
          .select("id, user_id")
          .eq("token_hash", hashSessionToken(token))
          .single();
        const row = (data ?? null) as { id: string } | null;
        if (row) {
          await supabase.from("user_sessions").delete().eq("id", row.id);
        }
      } catch {
        // Listing hygiene only; the sign-out below is what matters.
      }
    }

    await supabase.auth.signOut();
    return reply.send({ success: true });
  });

  app.post("/auth/reset-password", async (req, reply) => {
    if (limited(reply, `auth:reset:${req.ip}`, 10)) return;

    const { email } = req.body as { email: string };
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!normalizedEmail) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "email is required" },
      });
    }

    // Always reports success so the endpoint cannot be used to discover which
    // addresses are registered.
    if (!usingSqlite && normalizedEmail) {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail);
      if (error) {
        logger.warn({ error, email: normalizedEmail }, "Password reset request failed");
      }
    }

    return reply.send({ success: true });
  });

  // Completes a password reset from the email link. The link carries a
  // recovery token, not a session, so this route stays outside the API-key
  // middleware: the recovery token itself is the credential, verified below.
  // Local development has no email delivery, so the link never exists there
  // and this endpoint has nothing to complete.
  app.post("/auth/reset-confirm", async (req, reply) => {
    if (limited(reply, `auth:reset-confirm:${req.ip}`, 20)) return;

    const { recovery_token, new_password } = req.body as {
      recovery_token?: string;
      new_password?: string;
    };

    if (!recovery_token || !new_password || new_password.length < 8) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "A valid recovery link and an 8+ character password are required",
        },
      });
    }

    if (isCommonPassword(new_password)) {
      return reply.status(400).send({
        error: {
          code: "WEAK_PASSWORD",
          message: "That password is too common. Choose something less guessable.",
        },
      });
    }

    if (usingSqlite) {
      return reply.status(400).send({
        error: {
          code: "RESET_UNAVAILABLE",
          message: "Password reset links are not sent in local development. Change the password from Settings instead.",
        },
      });
    }

    const { data, error } = await supabase.auth.getUser(recovery_token);
    if (error || !data?.user?.id) {
      return reply.status(400).send({
        error: {
          code: "INVALID_LINK",
          message: "This reset link is invalid or has expired. Request a new one.",
        },
      });
    }

    const admin = supabaseAdmin();
    const { error: updateError } = await admin.updateUserById(data.user.id, {
      password: new_password,
    });

    if (updateError) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not set the new password" },
      });
    }

    logger.info({ userId: data.user.id }, "Password reset completed");
    return reply.send({ success: true });
  });
}
