import crypto from "node:crypto";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";
import { PROJECT_BUCKET } from "./upload-finalize.js";

/**
 * Project-zip storage retention.
 *
 * Supabase holds one zip per upload; unattended projects would accumulate
 * them forever. The sweeper deletes only the zip object of projects idle
 * past their tier's inactivity budget — free 24h, pro 3 days, ultra 7 days.
 * Rows, builds, artifacts and runtime history are never touched: a wiped
 * project keeps its settings and history, and the next upload revives it
 * (starts in the meantime fail with "re-upload", not with missing rows).
 *
 * "Activity" is an upload, a CI bundle delivery, or a runtime start — the
 * three paths that call `touchProjectActivity` / write `last_activity_at`.
 * The hourly CI cron hits `POST /internal/retention/sweep`; the sweep is
 * idempotent (null `upload_path` rows are skipped) and paginated, so a
 * re-run or an interrupted run simply continues.
 */

const HOUR_MS = 60 * 60 * 1000;

const INACTIVITY_BUDGET_MS: Record<string, number> = {
  free: 24 * HOUR_MS,
  pro: 3 * 24 * HOUR_MS,
  ultra: 7 * 24 * HOUR_MS,
};

export function inactivityBudgetMs(planId: string | null | undefined): number {
  return INACTIVITY_BUDGET_MS[planId ?? "free"] ?? INACTIVITY_BUDGET_MS.free;
}

export interface WipedProject {
  project_id: string;
  user_id: string;
  plan_id: string;
  upload_bytes: number;
}

export interface RetentionSummary {
  checked: number;
  wiped: number;
  bytes_reclaimed: number;
  wiped_projects: WipedProject[];
}

interface Candidate {
  id: string;
  user_id: string;
  upload_path: string;
  upload_bytes: number | null;
  last_activity_at: string | null;
}

async function wipeProject(candidate: Candidate, planId: string): Promise<number> {
  const path = candidate.upload_path;
  try {
    // The storage union types remove() as an intersection of the Supabase
    // (array) and local (single path) signatures. One path at a time keeps
    // both backends correct: a single-element array stringifies to itself
    // under path.join locally, and Supabase gets the array it wants.
    const { error: removeError } = await supabase.storage
      .from(PROJECT_BUCKET)
      .remove([path] as never);
    if (removeError) throw removeError;
  } catch (err) {
    logger.error({ err, projectId: candidate.id, path }, "Retention wipe could not delete the zip");
    throw err;
  }

  const { error: clearError } = await supabase
    .from("projects")
    .update({ upload_path: null, upload_url: null })
    .eq("id", candidate.id);
  if (clearError) {
    logger.error({ err: clearError, projectId: candidate.id }, "Retention wipe deleted the zip but could not clear its columns");
    throw clearError;
  }

  const bytes = Number(candidate.upload_bytes ?? 0);
  try {
    await supabase.from("admin_audit").insert({
      id: crypto.randomUUID(),
      admin_id: "retention-sweeper",
      action: "retention.wipe",
      target: candidate.id,
      detail: JSON.stringify({ plan_id: planId, upload_path: path, upload_bytes: bytes }),
    });
  } catch (err) {
    logger.warn({ err, projectId: candidate.id }, "Retention wipe audit write failed");
  }
  return bytes;
}

export async function runRetentionSweep(opts?: { dryRun?: boolean }): Promise<RetentionSummary> {
  const dryRun = opts?.dryRun === true;
  const now = Date.now();
  const summary: RetentionSummary = { checked: 0, wiped: 0, bytes_reclaimed: 0, wiped_projects: [] };

  // The union query builder has no OR/IS-NULL filters, so the scan pages
  // over rows ordered by oldest activity and decides per row in code —
  // portable across sqlite and PostgREST, and bounded (10 pages of 200).
  // Rows without an activity stamp (pre-0028) read as epoch: uploads going
  // forward always stamp, so legacy rows drain out on the first sweep.
  const PAGE = 200;
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from("projects")
      .select("id, user_id, upload_path, upload_bytes, last_activity_at")
      .order("last_activity_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    const candidates = ((data ?? []) as Candidate[]).filter((c) => !!c.upload_path);
    if (candidates.length === 0) break;
    summary.checked += candidates.length;

    const userIds = [...new Set(candidates.map((c) => c.user_id))];
    const { data: users } = await supabase.from("users").select("id, plan_id").in("id", userIds);
    const planByUser = new Map(
      ((users ?? []) as { id: string; plan_id?: string | null }[]).map((u) => [u.id, u.plan_id ?? "free"])
    );

    for (const candidate of candidates) {
      const planId = planByUser.get(candidate.user_id) ?? "free";
      const budget = inactivityBudgetMs(planId);
      const lastActive = candidate.last_activity_at ? Date.parse(candidate.last_activity_at) : 0;
      if (Number.isNaN(lastActive) || now - lastActive < budget) continue;

      const bytes = Number(candidate.upload_bytes ?? 0);
      if (!dryRun) {
        try {
          await wipeProject(candidate, planId);
        } catch {
          continue;
        }
      }
      summary.wiped += 1;
      summary.bytes_reclaimed += bytes;
      summary.wiped_projects.push({
        project_id: candidate.id,
        user_id: candidate.user_id,
        plan_id: planId,
        upload_bytes: bytes,
      });
      logger.info(
        { projectId: candidate.id, planId, bytes, dryRun },
        dryRun ? "Retention sweep would wipe project zip" : "Retention sweep wiped project zip"
      );
    }
    if (candidates.length < PAGE) break;
  }
  return summary;
}
