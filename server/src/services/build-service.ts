import { supabase } from "../db/client.js";
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
      throw new Error(`GitHub API error: ${resp.status}`);
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
