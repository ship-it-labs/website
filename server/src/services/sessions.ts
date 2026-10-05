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
): Promise<void> {
  try {
    await db.from("user_sessions").insert({
      id: randomUUID(),
      user_id: options.userId,
      token_hash: hashSessionToken(options.token),
      user_agent: (options.userAgent ?? "").slice(0, 256) || null,
      ip: (options.ip ?? "").slice(0, 64) || null,
    });
  } catch (err) {
    logger.warn({ err, userId: options.userId }, "Failed to record login session");
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
