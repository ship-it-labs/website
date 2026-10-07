import { supabase, type Database } from "../db/index.js";
import crypto from "node:crypto";
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

export interface AdminAuditEntry {
  adminId: string;
  action: string;
  target?: string | null;
  detail?: string | null;
}

/**
 * Appends one row to the admin audit log. Defensive by design: migration 0013
 * may not be wired into schema.ts / PROD_SETUP.sql yet (a sibling owns those),
 * in which case the insert fails and the caller's request must still succeed.
 * A missing table logs one warning and resolves; anything else is the caller's
 * problem only in the sense that it is logged, never thrown.
 */
export async function recordAdminAudit(
  db: Database,
  entry: AdminAuditEntry
): Promise<void> {
  try {
    const { error } = await db.from("admin_audit").insert({
      // Generated here rather than defaulted in SQL so SQLite and Postgres
      // accept the same row: neither schema needs a uuid generator.
      id: crypto.randomUUID(),
      admin_id: entry.adminId,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) {
      logger.warn(
        { err: error, action: entry.action },
        "Admin audit write failed; request continues unaudited"
      );
    }
  } catch (err) {
    logger.warn({ err, action: entry.action }, "Admin audit write threw; request continues unaudited");
  }
}

/** CSV-escapes one cell: quotes, commas and newlines are wrapped in quotes. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Builds a CSV document from headers plus rows of cells. Pure and testable. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * True when agent capacity is low: at or above the threshold of slots used.
 * Zero known slots is not "low", it is "unknown" (manager unreachable or no
 * agents), and must not raise the banner — otherwise every manager outage
 * also reads as a capacity crunch.
 */
export function isCapacityLow(totalUsed: number, totalMax: number, threshold = 0.8): boolean {
  if (totalMax <= 0) return false;
  return totalUsed / totalMax >= threshold;
}

/** Platform-wide pause on new runtime starts. Stored as JSON "true"/"false". */
export async function isMaintenanceMode(db: Database = supabase): Promise<boolean> {
  try {
    const { data } = await db
      .from("platform_settings")
      .select("value")
      .eq("key", "maintenance_mode")
      .single();
    if (!data) return false;
    const raw = (data as { value: unknown }).value;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) === true;
      } catch {
        return raw === "true";
      }
    }
    return raw === true;
  } catch (err) {
    // Fail open: a settings read failure must not take the platform down.
    logger.warn({ err }, "Maintenance-mode check failed; assuming platform is open");
    return false;
  }
}
