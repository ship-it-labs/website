import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import {
  createBuild,
  triggerGitHubActionsBuild,
  getBuild,
  listBuilds,
  setBuildExecutor,
  setBuildProvenance,
  removeBuild,
  filterBuildsByStatus,
  findInflightDuplicate,
  getBuildStorageUsage,
  logWasTruncated,
  GitHubDispatchError,
} from "../services/build-service.js";
import { resolveBuildExecutorWithSettings } from "../services/build-executor.js";
import { isLanguage } from "../services/languages.js";
import { parseEnvVars, EnvCryptoError } from "../utils/env-crypto.js";
import { triggerRuntimeBuild } from "../services/runtime-build.js";
import { recordBuild } from "../services/quota-service.js";
import { isCommandAllowed, firstBlockedCommand } from "../services/command-guard.js";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";
import type { Build } from "../types/index.js";

/**
 * A project does not have to be compiled. Static sites and plain scripts can be
 * run straight from source, so build_commands is optional, but the request must
 * still ask for something to happen.
 */
const buildSchema = z
  .object({
    project_id: z.string().min(1),
    install_commands: z.array(z.string().min(1)).max(20).default([]),
    build_commands: z.array(z.string().min(1)).max(20).default([]),
    test_commands: z.array(z.string().min(1)).max(20).default([]),
    language: z.string().optional(),
    // Build-time environment (registry tokens, build flags). Validated and
    // forwarded to the runner only — never stored, never logged.
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (value) =>
      value.install_commands.length + value.build_commands.length + value.test_commands.length >
      0,
    { message: "Provide at least one install, build or test command" }
  );

/**
 * Unknown build ids share one 404 shape with unknown runtime ids, so callers
 * branch on a single NOT_FOUND code.
 */
function buildNotFound(message = "Build not found"): { error: { code: string; message: string } } {
  return { error: { code: "NOT_FOUND", message } };
}

/** Records the executor without failing the request on older databases. */
async function recordExecutor(buildId: string, executor: string): Promise<void> {
  await setBuildExecutor(buildId, executor);
}

export { isCommandAllowed } from "../services/command-guard.js";

export async function buildRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.post("/builds", async (req, reply) => {
    const parsed = buildSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid build request", details: parsed.error.flatten() },
      });
    }

    const { project_id, install_commands, build_commands, test_commands } = parsed.data;

    const allCommands = [...install_commands, ...build_commands, ...test_commands];
    const blocked = firstBlockedCommand(allCommands);
    if (blocked) {
      return reply.status(400).send({
        error: { code: "COMMAND_BLOCKED", message: `Command rejected: ${blocked}` },
      });
    }

    const { data: project } = await supabase
      .from("projects")
      .select("id, upload_sha256, repo_url, language")
      .eq("id", project_id)
      .eq("user_id", req.auth!.userId)
      .single();

    if (!project) {
      return reply.status(404).send({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found" } });
    }

    // An explicit valid declaration wins; otherwise the build inherits the
    // project's language so the workflow sets up the right toolchain without
    // the caller repeating it on every submit.
    const proj = project as { language?: unknown };
    const buildLanguage = isLanguage(parsed.data.language)
      ? parsed.data.language
      : isLanguage(proj.language)
        ? proj.language
        : null;

    const build = await createBuild(
      req.auth!.userId,
      project_id,
      install_commands,
      build_commands,
      test_commands,
      req.auth!.plan.build_timeout_seconds,
      buildLanguage
    );

    // Build env is validated here so a malformed map fails before dispatch,
    // not mid-run on the runner. Values are never logged.
    let buildEnv: Record<string, string> | undefined;
    if (parsed.data.env !== undefined) {
      try {
        buildEnv = parseEnvVars(parsed.data.env);
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: err instanceof EnvCryptoError ? err.message : "Invalid env",
          },
        });
      }
    }

    try {
      const executor = await resolveBuildExecutorWithSettings();
      await recordExecutor(build.id, executor);
      // Provenance is a snapshot of what the build ran against, taken before
      // dispatch: the archive hash identifies the exact source even if the
      // project is re-uploaded while the build is queued.
      const proj = project as { upload_sha256?: unknown; repo_url?: unknown };
      await setBuildProvenance(build.id, {
        sourceSha256: typeof proj.upload_sha256 === "string" ? proj.upload_sha256 : null,
        sourceRepo: typeof proj.repo_url === "string" ? proj.repo_url : null,
      });

      // GitHub only works when a hosted runner can reach this deployment. Locally
      // it cannot, so the build runs in the platform's own runtime instead of
      // failing at the download step.
      if (executor === "github") {
        // Rebuilds cannot resupply build env (it is never stored), so only the
        // fresh submit path carries it; the rebuild call below dispatches
        // without.
        await triggerGitHubActionsBuild(build.id, buildEnv ? { buildEnv } : undefined);
      } else {
        await triggerRuntimeBuild(build.id);
      }

      await recordBuild(req.auth!.userId);
    } catch (err) {
      logger.error({ err, buildId: build.id }, "Failed to trigger build");

      // GitHub rejects a dispatch for many reasons, and they need different
      // fixes: a bad token, a missing permission, or a token lifetime the
      // organisation refuses. Reporting only "GitHub unavailable" sent someone
      // looking for a network problem that was really a permissions one, so the
      // upstream reason is passed through.
      const reason =
        err instanceof GitHubDispatchError
          ? err.explanation
          : err instanceof Error
            ? err.message
            : String(err);

      // A throttled or conflicting dispatch is temporary, so it gets a 429 and
      // the caller knows to retry. A rejected token or missing workflow is a
      // configuration fault and stays a 502 with GitHub's own wording.
      const transient = err instanceof GitHubDispatchError && err.transient;

      return reply.status(transient ? 429 : 502).send({
        error: {
          code: transient ? "BUILD_CAPACITY" : "BUILD_DISPATCH_FAILED",
          message: `Could not start the build pipeline: ${reason}`,
        },
      });
    }

    return reply.status(202).send({ build_id: build.id, status: build.status });
  });

  app.get("/builds/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);

    if (!build || build.user_id !== req.auth!.userId) {
      return reply.status(404).send(buildNotFound());
    }

    return reply.send({ build });
  });

  // Re-runs a build with its original commands. Idempotent while the same work
  // is already in flight: a retried or double-clicked request returns the
  // running build instead of queueing a duplicate. Otherwise creates a new
  // build row (the old one keeps its logs) and dispatches it through the
  // current executor.
  app.post("/builds/:id/rebuild", async (req, reply) => {
    const { id } = req.params as { id: string };
    const previous = await getBuild(id);

    if (!previous || previous.user_id !== req.auth!.userId) {
      return reply.status(404).send(buildNotFound());
    }

    const toCommands = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];

    const fingerprint = {
      project_id: previous.project_id,
      install_commands: toCommands(previous.install_commands),
      build_commands: toCommands(previous.build_commands),
      test_commands: toCommands(previous.test_commands),
    };

    const inflight = findInflightDuplicate(
      await listBuilds(req.auth!.userId, 50),
      fingerprint
    );
    if (inflight) {
      return reply.send({ build_id: inflight.id, status: inflight.status, deduped: true });
    }

    const build = await createBuild(
      req.auth!.userId,
      previous.project_id,
      toCommands(previous.install_commands),
      toCommands(previous.build_commands),
      toCommands(previous.test_commands),
      req.auth!.plan.build_timeout_seconds,
      (previous as { language?: string | null }).language ?? null
    );

    try {
      const executor = await resolveBuildExecutorWithSettings();
      await recordExecutor(build.id, executor);

      // The source may have been re-uploaded since the original build, so
      // provenance comes from the project's current archive, not the old row.
      const { data: source } = await supabase
        .from("projects")
        .select("upload_sha256, repo_url")
        .eq("id", previous.project_id)
        .eq("user_id", req.auth!.userId)
        .single();
      const src = (source ?? {}) as { upload_sha256?: unknown; repo_url?: unknown };
      await setBuildProvenance(build.id, {
        sourceSha256: typeof src.upload_sha256 === "string" ? src.upload_sha256 : null,
        sourceRepo: typeof src.repo_url === "string" ? src.repo_url : null,
      });

      if (executor === "github") {
        await triggerGitHubActionsBuild(build.id);
      } else {
        await triggerRuntimeBuild(build.id);
      }

      await recordBuild(req.auth!.userId);
    } catch (err) {
      logger.error({ err, buildId: build.id }, "Failed to trigger rebuild");
      const reason = err instanceof Error ? err.message : String(err);
      const transient = err instanceof GitHubDispatchError && err.transient;
      return reply.status(transient ? 429 : 502).send({
        error: {
          code: transient ? "BUILD_CAPACITY" : "BUILD_DISPATCH_FAILED",
          message: `Could not start the build pipeline: ${reason}`,
        },
      });
    }

    return reply.status(202).send({ build_id: build.id, status: build.status });
  });

  // Deletes the build plus its logs and artifact rows. Storage blobs behind
  // artifact URLs expire via bucket lifecycle instead of blocking the delete.
  app.delete("/builds/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);

    if (!build || build.user_id !== req.auth!.userId) {
      return reply.status(404).send(buildNotFound());
    }

    try {
      await removeBuild(id);
    } catch {
      return reply.status(500).send({
        error: { code: "BUILD_DELETE_FAILED", message: "Could not delete the build" },
      });
    }

    return reply.send({ deleted: true });
  });

  app.get("/builds/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);

    if (!build || build.user_id !== req.auth!.userId) {
      return reply.status(404).send(buildNotFound());
    }

    const { data: logs } = await supabase
      .from("build_logs")
      .select("stream, content, created_at")
      .eq("build_id", id)
      .order("created_at", { ascending: true });

    return reply.send({ logs: logs || [] });
  });

  app.get("/builds/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);

    if (!build || build.user_id !== req.auth!.userId) {
      return reply.status(404).send(buildNotFound());
    }

    const { data: artifacts } = await supabase
      .from("artifacts")
      .select("id, name, sha256, size, url, created_at")
      .eq("build_id", id);

    return reply.send({ artifacts: artifacts || [] });
  });

  app.get("/builds", async (req, reply) => {
    const builds = await listBuilds(req.auth!.userId);
    const query = req.query as { status?: string };
    const filtered = filterBuildsByStatus(builds, query.status ?? "all");
    // The browser cannot build the run link itself: it has no idea which
    // repository the workflow runs in.
    return reply.send({ builds: filtered.map(withRunUrl) });
  });
}

const githubRepo = () => process.env.GITHUB_REPO || "Ship-it-labs/opencode-plugin";

/**
 * A link to the GitHub run behind a build, when there is one. Builds executed by
 * the platform's own runtime never have a run id and get no link.
 */
function withRunUrl(build: Build) {
  return {
    ...build,
    github_run_url: build.workflow_run_id
      ? `https://github.com/${githubRepo()}/actions/runs/${build.workflow_run_id}`
      : null,
  };
}
