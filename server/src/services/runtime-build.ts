import { supabase } from "../db/index.js";
import { callOrchestrator } from "./orchestrator-client.js";
import { logger } from "../utils/logger.js";
import type { Build } from "../types/index.js";

/**
 * Runs a build inside the platform's own runtime rather than on a hosted runner.
 *
 * This is the executor used whenever the control plane is not reachable from the
 * internet, which is the normal case in development: a GitHub runner cannot
 * download a project from a loopback address, so the build would fail before
 * running a single command.
 *
 * The build itself runs in a container on an agent and reports back here; this
 * function only submits it and returns. The poller in build-poller.ts records the
 * outcome.
 */

const SOURCE_URL_TTL_SECONDS = 15 * 60;

/** How often an unfinished build is checked for a result. */
export const BUILD_POLL_INTERVAL_MS = 4_000;

/** A build still running after this long is treated as lost, not as pending. */
const BUILD_STALE_MS = 30 * 60_000;

/**
 * Normalises a command list.
 *
 * Postgres returns jsonb columns already parsed, while the local SQLite store
 * hands back the raw JSON text. Sending that text straight through made the
 * orchestrator reject the request as malformed, so both shapes are accepted here
 * rather than depending on which database is in use.
 */
function toCommandList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      // Not JSON: treat a single command as a one item list, which is what the
      // caller meant.
      return value.trim() ? [value] : [];
    }
  }

  return [];
}

export async function triggerRuntimeBuild(buildId: string): Promise<void> {
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
    .select("upload_path, upload_sha256")
    .eq("id", build.project_id)
    .single();

  if (projectError || !project?.upload_path) {
    await markFailed(buildId, "The project has no uploaded source to build.");
    throw new Error("Project has no uploaded source");
  }

  // Minted per build and addressed for the private network, because the agent
  // pulls it from a sibling container rather than from the internet.
  const { data: signed, error: signError } = await supabase.storage
    .from("project-uploads")
    .createSignedUrl(project.upload_path, SOURCE_URL_TTL_SECONDS, { audience: "internal" });

  if (signError || !signed?.signedUrl) {
    await markFailed(buildId, "The project archive could not be prepared for the build.");
    throw new Error("Could not sign the project archive");
  }

  await supabase
    .from("builds")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", buildId);

  await callOrchestrator("/build/start", {
    build_id: buildId,
    source_url: signed.signedUrl,
    source_sha256: project.upload_sha256 ?? "",
    install_commands: toCommandList(build.install_commands),
    build_commands: toCommandList(build.build_commands),
    test_commands: toCommandList(build.test_commands),
    timeout_seconds: build.timeout_seconds ?? 180,
  });
}

interface RuntimeBuildResult {
  build_id: string;
  status: "running" | "success" | "failure";
  exit_code: number;
  logs: string;
  error?: string;
}

async function markFailed(buildId: string, message: string): Promise<void> {
  await supabase
    .from("builds")
    .update({ status: "failure", completed_at: new Date().toISOString() })
    .eq("id", buildId);

  await appendLog(buildId, "stderr", message);
}

/**
 * Records what a build printed, so the dashboard can show why it failed.
 *
 * Log rows are replaced rather than appended so a poller that runs twice cannot
 * duplicate the output.
 */
async function appendLog(buildId: string, stream: "stdout" | "stderr", content: string): Promise<void> {
  if (!content.trim()) return;

  await supabase.from("build_logs").delete().eq("build_id", buildId);
  await supabase.from("build_logs").insert({
    build_id: buildId,
    stream,
    content,
  });
}

/**
 * Checks every unfinished build and records whatever the agents report.
 *
 * A build left pending forever is worse than one marked failed: it occupies the
 * dashboard with no explanation and the caller has nothing to act on. Anything
 * still running past BUILD_STALE_MS is failed with that explanation.
 */
export async function pollRuntimeBuilds(): Promise<void> {
  const { data: builds, error } = await supabase
    .from("builds")
    .select("id, status, started_at, created_at")
    .in("status", ["running", "pending"]);

  if (error || !builds || builds.length === 0) return;

  for (const build of builds) {
    const startedAt = new Date(build.started_at ?? build.created_at ?? Date.now()).getTime();
    if (Date.now() - startedAt > BUILD_STALE_MS) {
      await supabase
        .from("builds")
        .update({ status: "failure", completed_at: new Date().toISOString() })
        .eq("id", build.id);
      await appendLog(
        build.id,
        "stderr",
        "This build stopped reporting and was marked failed. The agent running it may have restarted."
      );
      continue;
    }

    try {
      const result = await callOrchestrator<RuntimeBuildResult>("/build/result", {
        runtime_id: build.id,
      });

      if (result.status === "running") continue;

      await supabase
        .from("builds")
        .update({
          status: result.status,
          exit_code: result.exit_code,
          completed_at: new Date().toISOString(),
        })
        .eq("id", build.id);

      await appendLog(build.id, result.status === "success" ? "stdout" : "stderr", result.logs || result.error || "");
    } catch (err) {
      // The build may not have reached an agent yet, or the orchestrator may be
      // briefly unavailable. Neither is worth failing the build over; the stale
      // check above is the backstop.
      logger.debug({ err, buildId: build.id }, "build result not available yet");
    }
  }
}

export function startBuildPoller(): void {
  const timer = setInterval(() => {
    pollRuntimeBuilds().catch((err) =>
      logger.error({ err }, "build poller pass failed")
    );
  }, BUILD_POLL_INTERVAL_MS);

  // The poller should not hold the process open on shutdown.
  timer.unref?.();
}
