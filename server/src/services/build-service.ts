import { supabase } from "../db/index.js";
import { Build } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { v4 as uuidv4 } from "uuid";

// Read per call, not captured at import: the admin panel can rotate these
// values into process.env at runtime, and a captured constant would stay stale
// until the next restart.
const githubToken = () => process.env.GITHUB_TOKEN || "";
const githubRepo = () => process.env.GITHUB_REPO || "Ship-it-labs/opencode-plugin";

export async function createBuild(
  userId: string,
  projectId: string,
  installCommands: string[],
  buildCommands: string[],
  testCommands: string[],
  timeoutSeconds: number
): Promise<Build> {
  const id = `build_${uuidv4().slice(0, 12)}`;

  const { data, error } = await supabase
    .from("builds")
    .insert({
      id,
      user_id: userId,
      project_id: projectId,
      status: "pending",
      install_commands: installCommands,
      build_commands: buildCommands,
      test_commands: testCommands,
      // A plan row edited by hand (or a stale auth token) must not grant an
      // unbounded build: the value is clamped to a sane window here so every
      // caller is covered, including the rebuild route.
      timeout_seconds: clampBuildTimeout(timeoutSeconds),
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, userId }, "Failed to create build");
    throw new Error("Failed to create build");
  }

  return data as Build;
}

export async function triggerGitHubActionsBuild(buildId: string): Promise<void> {
  const { data: build, error } = await supabase
    .from("builds")
    .select("*")
    .eq("id", buildId)
    .single();

  if (error || !build) {
    throw new Error("Build not found");
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("upload_path, upload_url, upload_sha256, repo_url")
    .eq("id", build.project_id)
    .single();

  if (projectError || !project) {
    await supabase
      .from("builds")
      .update({ status: "failure", completed_at: new Date().toISOString() })
      .eq("id", buildId);
    throw new Error("Project has no uploaded source");
  }

  // A fresh signed URL is minted per build so the runner never receives a
  // long-lived or user-visible download link.
  const { data: signed, error: signError } = await supabase.storage
    .from("project-uploads")
    .createSignedUrl(project.upload_path!, 60 * 15);

  const sourceUrl = signed?.signedUrl ?? project.upload_url;
  if (!sourceUrl) {
    await supabase
      .from("builds")
      .update({ status: "failure", completed_at: new Date().toISOString() })
      .eq("id", buildId);
    throw new Error("Could not sign the project archive");
  }

  await supabase
    .from("builds")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", buildId);

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${githubRepo()}/actions/workflows/build.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken()}`,
          Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            build_id: buildId,
            install_commands: JSON.stringify(build.install_commands),
            build_commands: JSON.stringify(build.build_commands),
            test_commands: JSON.stringify(build.test_commands),
            source_url: sourceUrl,
            source_sha256: project.upload_sha256 ?? "",
            checkout_url: project.repo_url ?? "",
            checkout_ref: "",
          },
        }),
      }
    );

    if (!resp.ok) {
      throw await githubError(resp);
    }

    logger.info({ buildId }, "GitHub Actions build triggered");
  } catch (err) {
    await supabase
      .from("builds")
      .update({ status: "failure", completed_at: new Date().toISOString() })
      .eq("id", buildId);
    throw err;
  }
}

/**
 * A dispatch that GitHub refused, carrying a message worth showing. A bare 403
 * is ambiguous: it can mean the token is wrong, the token lacks Actions write,
 * or the token's lifetime is longer than the organisation allows.
 */
export class GitHubDispatchError extends Error {
  readonly status: number;

  /**
   * True when the refusal was transient, meaning the same request would
   * probably succeed later. The route turns this into a 429 so a caller can
   * retry rather than treating it as a broken integration.
   */
  readonly transient: boolean;

  constructor(status: number, explanation: string, transient = false) {
    super(`GitHub API error: ${status}`);
    this.name = "GitHubDispatchError";
    this.status = status;
    this.explanation = explanation;
    this.transient = transient;
  }

  readonly explanation: string;
}

/**
 * Distinguishes a transient refusal from a misconfiguration. 409 means a run is
 * already in progress, 429 and the rate limit wording mean throttling; a plain
 * 403 or 404 is a permission or configuration fault and must stay visible.
 */
export function isTransientDispatchFailure(status: number, detail: string): boolean {
  if (status === 409 || status === 429 || status === 503) return true;

  const text = detail.toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("secondary rate") ||
    text.includes("abuse detection") ||
    text.includes("was submitted too quickly")
  );
}

async function githubError(resp: Response): Promise<GitHubDispatchError> {
  let detail = "";
  try {
    const body = (await resp.json()) as { message?: string };
    detail = body.message ?? "";
  } catch {
    detail = "";
  }

  // GitHub throttles, and a throttled or momentarily conflicting dispatch is
  // exactly what a transient busy message is for. Anything else keeps GitHub's
  // own wording, because those are configuration problems a retry cannot fix.
  if (isTransientDispatchFailure(resp.status, detail)) {
    return new GitHubDispatchError(resp.status, OVER_CAPACITY_MESSAGE, true);
  }

  const explanation = detail || `GitHub refused the workflow dispatch with status ${resp.status}.`;
  return new GitHubDispatchError(resp.status, explanation, false);
}

/**
 * Shared wording for anything that means "we are busy, try again", covering both
 * our own capacity limits and GitHub refusing to take more work right now.
 */
export const OVER_CAPACITY_MESSAGE =
  "We are having heavy demand right now and cannot start another build. " +
  "Please try again in a few minutes.";

/**
 * Distinguishes a transient refusal from a misconfiguration. 409 means a run is
 * already in progress, 429 and the rate limit wording mean throttling; a plain
 * 403 or 404 is a permission or configuration fault and must stay visible.
 */
function isTransient(status: number, detail: string): boolean {
  if (status === 409 || status === 429 || status === 503) return true;

  const text = detail.toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("secondary rate") ||
    text.includes("abuse detection") ||
    text.includes("was submitted too quickly")
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Terminal states: once reached, polling slows down because nothing more will
 * arrive. Pending and running stay on the fast poll.
 */
export function isTerminalBuildStatus(status: string): boolean {
  return status === "success" || status === "failure" || status === "timeout";
}

/**
 * Seconds between start and finish, or start and now while still running.
 * Returns null when the build never started.
 */
export function buildDurationSeconds(
  build: { started_at?: string | null; completed_at?: string | null },
  nowMs = Date.now()
): number | null {
  if (!build.started_at) return null;
  const start = new Date(build.started_at).getTime();
  if (Number.isNaN(start)) return null;
  const end = build.completed_at ? new Date(build.completed_at).getTime() : nowMs;
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/** Narrow a build list to one status; "all" (or empty) returns everything. */
export function filterBuildsByStatus<T extends { status: string }>(builds: T[], status: string): T[] {
  if (!status || status === "all") return builds;
  return builds.filter((b) => b.status === status);
}

/**
 * Records which executor ran a build. Tolerates databases created before the
 * executor column existed: the column backfill runs at boot, but a build that
 * finishes in between must not fail over bookkeeping.
 */
export async function setBuildExecutor(buildId: string, executor: string): Promise<void> {
  try {
    const { error } = await supabase.from("builds").update({ executor }).eq("id", buildId);
    if (error) logger.warn({ error, buildId }, "Could not record build executor");
  } catch (err) {
    logger.warn({ err, buildId }, "Could not record build executor");
  }
}

/**
 * Deletes a build and everything attached to it (log rows, artifact rows).
 * Storage objects behind artifact URLs are left alone: they expire with the
 * bucket lifecycle rather than blocking the delete.
 */
export async function removeBuild(buildId: string): Promise<void> {
  await supabase.from("build_logs").delete().eq("build_id", buildId);
  await supabase.from("artifacts").delete().eq("build_id", buildId);
  const { error } = await supabase.from("builds").delete().eq("id", buildId);
  if (error) {
    logger.error({ error, buildId }, "Failed to delete build");
    throw new Error("Failed to delete build");
  }
}

export async function getBuild(buildId: string): Promise<Build | null> {
  const { data, error } = await supabase
    .from("builds")
    .select("*")
    .eq("id", buildId)
    .single();
  if (error) return null;
  return data as Build;
}

export async function listBuilds(userId: string, limit = 20): Promise<Build[]> {
  const { data, error } = await supabase
    .from("builds")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data as Build[];
}

export async function updateBuildStatus(
  buildId: string,
  status: Build["status"],
  exitCode?: number
): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (exitCode !== undefined) updates.exit_code = exitCode;
  if (status === "success" || status === "failure" || status === "timeout") {
    updates.completed_at = new Date().toISOString();
  }

  const { error } = await supabase.from("builds").update(updates).eq("id", buildId);
  if (error) {
    logger.error({ error, buildId, status }, "Failed to update build status");
  }
}

/** Fallback when the plan value is missing or unusable. Matches the free tier. */
export const DEFAULT_BUILD_TIMEOUT_SECONDS = 180;

/** Below this a build cannot even download its source; above it a runaway bill. */
export const MIN_BUILD_TIMEOUT_SECONDS = 30;
export const MAX_BUILD_TIMEOUT_SECONDS = 3600;

/**
 * Forces a build timeout into a sane window. Guards the builders against a
 * hand-edited plans row or a stale token carrying an absurd limit.
 */
export function clampBuildTimeout(value: unknown): number {
  const seconds = typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isFinite(seconds)) return DEFAULT_BUILD_TIMEOUT_SECONDS;
  return Math.min(
    MAX_BUILD_TIMEOUT_SECONDS,
    Math.max(MIN_BUILD_TIMEOUT_SECONDS, Math.floor(seconds))
  );
}

/**
 * True when a started build has been running longer than its own
 * timeout_seconds. The poller turns these into "timeout" rather than leaving
 * them running until the generic stale backstop fires.
 */
export function isBuildOverdue(
  build: { started_at?: string | null; timeout_seconds?: number | null },
  nowMs = Date.now()
): boolean {
  if (!build.started_at) return false;
  const start = new Date(build.started_at).getTime();
  if (Number.isNaN(start)) return false;
  const limit = clampBuildTimeout(build.timeout_seconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS);
  return nowMs - start > limit * 1000;
}

/** Order-insensitive command comparison; accepts the raw jsonb/text shapes. */
export function commandsEqual(a: unknown, b: unknown): boolean {
  const norm = (value: unknown): string[] => {
    const list = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string"
        ? (() => {
            try {
              const parsed = JSON.parse(value);
              return Array.isArray(parsed)
                ? parsed.filter((item): item is string => typeof item === "string")
                : [];
            } catch {
              return [];
            }
          })()
        : [];
    return [...list].sort();
  };

  const left = norm(a);
  const right = norm(b);
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

interface RebuildFingerprint {
  project_id: string;
  install_commands: unknown;
  build_commands: unknown;
  test_commands: unknown;
}

/**
 * Finds a build that is already running the exact same work, so a retried or
 * double-clicked rebuild returns the in-flight build instead of spawning a
 * duplicate. Only non-terminal builds count: a finished build is history and
 * rebuilding it must start fresh work.
 */
export function findInflightDuplicate<
  T extends RebuildFingerprint & { id: string; status: string },
>(builds: T[], fingerprint: RebuildFingerprint): T | null {
  return (
    builds.find(
      (b) =>
        !isTerminalBuildStatus(b.status) &&
        b.project_id === fingerprint.project_id &&
        commandsEqual(b.install_commands, fingerprint.install_commands) &&
        commandsEqual(b.build_commands, fingerprint.build_commands) &&
        commandsEqual(b.test_commands, fingerprint.test_commands)
    ) ?? null
  );
}

/** Where a build's source came from, snapshotted at dispatch time. */
export interface BuildProvenance {
  /** sha256 of the uploaded project archive the build ran against. */
  sourceSha256: string | null;
  /** Repository URL the archive was uploaded from, when the project has one. */
  sourceRepo: string | null;
}

/**
 * Snapshots build provenance onto the build row. Tolerates databases created
 * before the provenance columns existed, same as the executor bookkeeping:
 * provenance must never fail a build over bookkeeping.
 */
export async function setBuildProvenance(
  buildId: string,
  provenance: BuildProvenance
): Promise<void> {
  try {
    const { error } = await supabase
      .from("builds")
      .update({
        source_sha256: provenance.sourceSha256,
        source_repo: provenance.sourceRepo,
      })
      .eq("id", buildId);
    if (error) logger.warn({ error, buildId }, "Could not record build provenance");
  } catch (err) {
    logger.warn({ err, buildId }, "Could not record build provenance");
  }
}

/**
 * Reads provenance back without depending on the columns existing. Rows from
 * before provenance was recorded (or databases without the migration) come
 * back with nulls rather than throwing.
 */
export function readBuildProvenance(row: Record<string, unknown>): BuildProvenance {
  const sha = row["source_sha256"];
  const repo = row["source_repo"];
  return {
    sourceSha256: typeof sha === "string" ? sha : null,
    sourceRepo: typeof repo === "string" ? repo : null,
  };
}

/**
 * Retention policy: finished builds are kept for BUILD_RETENTION_DAYS and at
 * most MAX_BUILDS_PER_PROJECT per project (newest wins). Builds still working
 * are never purged, no matter their age.
 */
export const BUILD_RETENTION_DAYS = 30;
export const MAX_BUILDS_PER_PROJECT = 50;

export interface RetentionOptions {
  maxAgeDays?: number;
  maxPerProject?: number;
}

interface RetentionCandidate {
  id: string;
  project_id: string;
  status: string;
  created_at?: string | null;
}

/**
 * Picks the build ids a retention pass should delete. Pure so the policy is
 * testable without a database; purgeExpiredBuilds applies the selection.
 */
export function selectBuildsForPurge<T extends RetentionCandidate>(
  builds: T[],
  nowMs = Date.now(),
  opts: RetentionOptions = {}
): string[] {
  const maxAgeMs = (opts.maxAgeDays ?? BUILD_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const maxPerProject = opts.maxPerProject ?? MAX_BUILDS_PER_PROJECT;

  const doomed = new Set<string>();

  // Age cap first: anything finished longer ago than the window goes.
  for (const b of builds) {
    if (!isTerminalBuildStatus(b.status)) continue;
    const created = b.created_at ? new Date(b.created_at).getTime() : Number.NaN;
    if (Number.isNaN(created)) continue;
    if (nowMs - created > maxAgeMs) doomed.add(b.id);
  }

  // Count cap per project: newest survive, oldest go, finished or not is
  // irrelevant here because in-flight builds are excluded above and a project
  // with 50 pending builds has bigger problems than retention.
  const byProject = new Map<string, T[]>();
  for (const b of builds) {
    if (doomed.has(b.id) || !isTerminalBuildStatus(b.status)) continue;
    const list = byProject.get(b.project_id) ?? [];
    list.push(b);
    byProject.set(b.project_id, list);
  }
  for (const list of byProject.values()) {
    if (list.length <= maxPerProject) continue;
    list.sort((x, y) =>
      (y.created_at ?? "").localeCompare(x.created_at ?? "")
    );
    for (const extra of list.slice(maxPerProject)) doomed.add(extra.id);
  }

  return [...doomed];
}

/**
 * Deletes builds the retention policy selected, with their logs and artifact
 * rows (removeBuild cascades). Returns how many went. Wire this to a timer in
 * index.ts; it is deliberately not self-scheduling so tests can call it.
 */
export async function purgeExpiredBuilds(opts: RetentionOptions = {}): Promise<number> {
  const { data, error } = await supabase
    .from("builds")
    .select("id, project_id, status, created_at");

  if (error || !data) {
    logger.warn({ error }, "Build retention pass could not list builds");
    return 0;
  }

  const ids = selectBuildsForPurge(
    data as RetentionCandidate[],
    Date.now(),
    opts
  );

  for (const id of ids) {
    try {
      await removeBuild(id);
    } catch (err) {
      logger.warn({ err, buildId: id }, "Build retention pass could not delete build");
    }
  }

  if (ids.length > 0) logger.info({ count: ids.length }, "Build retention pass deleted builds");
  return ids.length;
}

/** Adds up artifact and upload bytes so the dashboard can show storage use. */
export function sumStorageUsage(
  artifacts: Array<{ size?: unknown }>,
  projects: Array<{ upload_bytes?: unknown }>
): { artifact_bytes: number; upload_bytes: number; total_bytes: number } {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  const artifact_bytes = artifacts.reduce((n, a) => n + num(a.size), 0);
  const upload_bytes = projects.reduce((n, p) => n + num(p.upload_bytes), 0);
  return { artifact_bytes, upload_bytes, total_bytes: artifact_bytes + upload_bytes };
}

/**
 * Storage currently attributed to a user: artifact rows from their builds
 * plus the uploaded archives on their projects. Per-plan caps do not exist
 * yet (see follow-up), so this reports usage; enforcement comes later.
 */
export async function getBuildStorageUsage(userId: string): Promise<{
  artifact_bytes: number;
  upload_bytes: number;
  total_bytes: number;
  build_count: number;
}> {
  const [{ data: builds }, { data: projects }] = await Promise.all([
    supabase.from("builds").select("id").eq("user_id", userId),
    supabase.from("projects").select("upload_bytes").eq("user_id", userId),
  ]);

  const buildIds = ((builds ?? []) as { id: string }[]).map((b) => b.id);
  let artifacts: Array<{ size?: unknown }> = [];
  if (buildIds.length > 0) {
    const { data } = await supabase
      .from("artifacts")
      .select("size")
      .in("build_id", buildIds);
    artifacts = (data ?? []) as Array<{ size?: unknown }>;
  }

  const sums = sumStorageUsage(artifacts, (projects ?? []) as Array<{ upload_bytes?: unknown }>);
  return { ...sums, build_count: buildIds.length };
}

/**
 * Marker the log capper appends when output was cut short. The builds route
 * and the log viewer both key off this prefix to show a truncation notice,
 * so it lives here rather than in the report route.
 */
export const LOG_TRUNCATED_MARKER = "[log truncated";

/** True when a stored log ends with the capper's truncation notice. */
export function logWasTruncated(lines: Array<{ content?: unknown }>): boolean {
  return lines.some(
    (line) => typeof line.content === "string" && line.content.startsWith(LOG_TRUNCATED_MARKER)
  );
}
