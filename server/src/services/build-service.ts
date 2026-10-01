import { supabase } from "../db/index.js";
import { Build } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { v4 as uuidv4 } from "uuid";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "Ship-it-labs/opencode-plugin";

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
      timeout_seconds: timeoutSeconds,
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
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/build.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
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
