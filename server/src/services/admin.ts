import { supabase, type Database } from "../db/index.js";
import { logger } from "../utils/logger.js";

/**
 * The address that is always an admin, no matter when it signed up. Kept in
 * code rather than the environment on purpose: there is exactly one bootstrap
 * owner and a missing env var must never be the reason nobody can administer
 * the platform. Admin rights still come from identity, never from a password —
 * nothing here stores or compares one.
 */
export const BOOTSTRAP_ADMIN_EMAIL = "londonhussein1992@gmail.com";

export interface AdminUser {
  id: string;
  email: string;
  plan_id?: string;
  is_admin?: boolean | number | null;
  is_active?: boolean | number | null;
  created_at?: string;
}

/**
 * True when any of the three independent facts holds: the flag was set, the
 * address is the bootstrap owner, or this is the oldest account on record.
 *
 * Three paths rather than one because each covers the others' blind spot. The
 * flag survives renames and transfers. The email covers databases created
 * before the flag existed. Signup order covers a fresh database where nobody
 * has been flagged yet. All three read indexed columns, so the check costs one
 * small query on top of the authentication that already ran.
 *
 * The database is a parameter rather than the module singleton so tests can
 * hand in a throwaway SQLite file instead of touching the real one.
 */
export async function isAdminUser(user: AdminUser, db: Database = supabase): Promise<boolean> {
  if (user.is_admin === true || user.is_admin === 1) return true;

  if (
    typeof user.email === "string" &&
    user.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase()
  ) {
    return true;
  }

  try {
    const { data } = await db
      .from("users")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    return !!data && (data as { id: string }).id === user.id;
  } catch (err) {
    // A failed lookup must fail closed. Logging the user id without the email
    // is enough to trace it, and keeps addresses out of the log.
    logger.warn({ err, userId: user.id }, "Admin first-user check failed");
    return false;
  }
}

/** Shorthand for routes that already loaded the user row. */
export async function requireAdminUser(user: AdminUser | null): Promise<boolean> {
  if (!user) return false;
  return isAdminUser(user);
}
