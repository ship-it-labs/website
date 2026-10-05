import { FastifyInstance } from "fastify";
import { supabase, usingSqlite } from "../db/index.js";
import { generateApiKey } from "../utils/api-key.js";
import { seedPlans } from "../services/plan-service.js";
import { BOOTSTRAP_ADMIN_EMAIL } from "../services/admin.js";
import { recordSession, hashSessionToken } from "../services/sessions.js";
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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/signup", async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "email and password are required" },
      });
    }

    if (password.length < 8) {
      return reply.status(400).send({
        error: { code: "WEAK_PASSWORD", message: "Password must be at least 8 characters" },
      });
    }

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
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
    const credentials = await localSignUp(email, password);

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
      email,
      plan_id: "free",
      // The first account owns the platform, and the bootstrap address owns it
      // no matter when it arrives. Either fact alone is enough; the request-time
      // check in isAdminUser covers databases created before this column existed.
      is_admin: (await shouldStartAsAdmin(email)) ? true : false,
    });

    if (userError) {
      logger.error({ err: userError, email }, "Failed to create user row");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not create the account" },
      });
    }

    const { key, hash, prefix } = generateApiKey();
    await supabase.from("api_keys").insert({
      id: `key_${userId.slice(0, 8)}`,
      user_id: userId,
      key_hash: hash,
      key_prefix: prefix,
      name: "default",
      is_active: true,
    });

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
      user: { id: userId, email },
      api_key: key,
      session: session?.access_token ? { access_token: session.access_token } : null,
    });
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "email and password are required" },
      });
    }

    const credentials = await localSignIn(email, password);

    if (credentials.error || !credentials.data.user) {
      return reply.status(401).send({
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
      });
    }

    const session = credentials.data.session;

    const { data: user } = await supabase
      .from("users")
      .select("id, email, plan_id")
      .eq("id", credentials.data.user.id)
      .single();

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
      user: user ?? { id: credentials.data.user.id, email },
      session: session?.access_token ? { access_token: session.access_token } : null,
    });
  });

  app.post("/auth/logout", async (req, reply) => {
    // Forget the remembered row for this token, if one was presented. The
    // driver sign-out below is best-effort as before; clearing the local
    // session is what actually ends the browser's access.
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7);
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
    const { email } = req.body as { email: string };

    if (!email) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "email is required" },
      });
    }

    // Always reports success so the endpoint cannot be used to discover which
    // addresses are registered.
    if (!usingSqlite) {
      const { error } = await supabase.auth.resetPasswordForEmail(email);
      if (error) {
        logger.warn({ error, email }, "Password reset request failed");
      }
    }

    return reply.send({ success: true });
  });
}
