import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { supabase, type Database } from "../db/index.js";
import { logger } from "../utils/logger.js";

/**
 * Remembered login sessions, shared by signup, login, logout, the settings
 * device list and the auth middleware.
 *
 * Only hashes are stored — a database read must never yield a usable token,
 * the same rule API keys follow. Every writer here is best-effort: recording
 * a session must never fail a login, and a missing table (a database created
 * before migration 0009) must never lock anyone out. Errors are logged and
 * the caller proceeds as if sessions were not tracked.
 */

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function recordSession(
  options: {
    userId: string;
    token: string;
    userAgent?: string;
    ip?: string;
  },
  db: Database = supabase
): Promise<boolean> {
  try {
    const { error } = await db.from("user_sessions").insert({
      id: randomUUID(),
      user_id: options.userId,
      token_hash: hashSessionToken(options.token),
      user_agent: (options.userAgent ?? "").slice(0, 256) || null,
      ip: (options.ip ?? "").slice(0, 64) || null,
    });
    if (error) {
      // Logged AND reported: the caller turns this into a loud login failure.
      // A session that is not recorded can never validate, so swallowing this
      // produced logins that 401d on the very next request with
      // SESSION_REVOKED and no trace of why.
      logger.warn({ err: error, userId: options.userId }, "Failed to record login session");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, userId: options.userId }, "Failed to record login session");
    return false;
  }
}

/**
 * True when the token's hash is on record for this user. API keys never reach
 * here — the plugin has no session, so requiring one would sign out every
 * integration. Unknown tokens fail closed (sign in again); a database error
 * fails open (a missing table must not lock out the whole platform).
 */
export async function hasSessionRow(
  userId: string,
  token: string,
  db: Database = supabase
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("user_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("token_hash", hashSessionToken(token))
      .single();

    // "No rows" is the answer, not a failure: the session was revoked, never
    // recorded, or belongs to another user. Anything else (a missing table on
    // an old database, a timeout) fails open instead of locking everyone out.
    if (error) {
      const code = (error as { code?: string }).code;
      const message = (error as { message?: string }).message ?? "";
      if (code === "PGRST116" || message.includes("No rows")) return false;
      logger.warn({ err: error, userId }, "Session lookup failed, allowing request");
      return true;
    }
    return !!data;
  } catch (err) {
    logger.warn({ err, userId }, "Session lookup failed, allowing request");
    return true;
  }
}

export async function revokeSessionRow(
  userId: string,
  sessionId: string,
  db: Database = supabase
): Promise<boolean> {
  try {
    const { data } = await db
      .from("user_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .single();

    if (!data) return false;

    const { error } = await db
      .from("user_sessions")
      .delete()
      .eq("id", sessionId);

    return !error;
  } catch (err) {
    logger.warn({ err, userId }, "Failed to revoke session");
    return false;
  }
}

export async function revokeAllSessions(
  userId: string,
  exceptToken?: string,
  db: Database = supabase
): Promise<void> {
  try {
    if (exceptToken) {
      const keep = hashSessionToken(exceptToken);
      // The shim has no "not equal" filter; delete-all then re-add is racy, so
      // instead remove every row whose hash differs in application code.
      const { data } = await db
        .from("user_sessions")
        .select("id, token_hash")
        .eq("user_id", userId);

      for (const row of (data ?? []) as { id: string; token_hash: string }[]) {
        if (row.token_hash !== keep) {
          await db.from("user_sessions").delete().eq("id", row.id);
        }
      }
      return;
    }

    await db.from("user_sessions").delete().eq("user_id", userId);
  } catch (err) {
    logger.warn({ err, userId }, "Failed to revoke sessions");
  }
}

export type SessionWriteProbe =
  | { status: "ok" }
  | { status: "fatal"; message: string }
  | { status: "warn"; message: string };

/**
 * Interprets a session-write probe insert. The probe inserts a row for a
 * user id that cannot exist, so the informative outcomes are all failures:
 * a foreign-key rejection proves writes reach the table (healthy), an RLS
 * rejection proves writes are blocked (fatal, boot must fail), and anything
 * else is logged without blocking boot. Pure for testability; probeSessionWrites
 * below performs the insert.
 */
export function interpretProbeError(error: { code?: string; message?: string } | null | undefined): SessionWriteProbe {
  if (!error) {
    // Unexpected success: the table accepted a dangling row (no FK?). The
    // caller deletes it; writes demonstrably work either way.
    return { status: "ok" };
  }
  if (error.code === "42501" || /row-level security/i.test(error.message ?? "")) {
    return {
      status: "fatal",
      message:
        "user_sessions writes are blocked by row level security (42501). " +
        "Either SUPABASE_SERVICE_ROLE_KEY is not the service_role key, or RLS " +
        "is FORCED on the table (run migration 0018). Logins cannot work until fixed.",
    };
  }
  if (error.code === "23503" || /foreign key/i.test(error.message ?? "")) {
    // Expected: the fake user does not exist, so the FK correctly refused.
    // Writes reach the table, which is all the probe needs to know.
    return { status: "ok" };
  }
  if (error.code === "42P01" || /relation .* does not exist|Could not find the table/i.test(error.message ?? "")) {
    return {
      status: "warn",
      message:
        "user_sessions table is missing; logins will fail open (revocation unchecked) until migration 0009/0017 runs.",
    };
  }
  return {
    status: "warn",
    message: `session write probe failed unexpectedly: ${error.code ?? "unknown"} ${error.message ?? ""}`,
  };
}

/**
 * Verifies at boot that login sessions can actually be recorded. Throws on a
 * fatal misconfiguration (RLS blocking writes) so the deployment fails
 * loudly instead of serving logins that 401 on next use. Skipped on SQLite,
 * which has no row level security. Cleans up after itself in every outcome.
 */
export async function probeSessionWrites(db: Database = supabase): Promise<void> {
  // Bare UUID: the id column is uuid-typed, so any prefix makes the probe die
  // with a syntax error instead of proving anything about write access.
  const probeId = randomUUID();
  const { error } = await db.from("user_sessions").insert({
    id: probeId,
    user_id: `00000000-0000-0000-0000-${probeId.slice(-12)}`,
    token_hash: "probe",
  });

  const verdict = interpretProbeError(
    error as { code?: string; message?: string } | null | undefined
  );

  if (!error) {
    await db.from("user_sessions").delete().eq("id", probeId);
  }

  if (verdict.status === "fatal") {
    throw new Error(verdict.message);
  }
  if (verdict.status === "warn") {
    logger.warn({ message: verdict.message }, "Session write probe degraded");
  } else {
    logger.info("Session write probe passed; login sessions are recordable");
  }
}
