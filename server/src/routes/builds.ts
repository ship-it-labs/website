import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import {
  createBuild,
  triggerGitHubActionsBuild,
  getBuild,
  listBuilds,
  GitHubDispatchError,
} from "../services/build-service.js";
import { resolveBuildExecutor } from "../services/build-executor.js";
import { triggerRuntimeBuild } from "../services/runtime-build.js";
import { recordBuild } from "../services/quota-service.js";
import { isCommandAllowed, firstBlockedCommand } from "../services/command-guard.js";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";

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
  })
  .refine(
    (value) =>
      value.install_commands.length + value.build_commands.length + value.test_commands.length >
      0,
    { message: "Provide at least one install, build or test command" }
  );

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
      .select("id")
      .eq("id", project_id)
      .eq("user_id", req.auth!.userId)
      .single();

    if (!project) {
      return reply.status(404).send({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found" } });
    }

    const build = await createBuild(
      req.auth!.userId,
      project_id,
      install_commands,
      build_commands,
      test_commands,
      req.auth!.plan.build_timeout_seconds
    );

    try {
      const executor = resolveBuildExecutor();

      // GitHub only works when a hosted runner can reach this deployment. Locally
      // it cannot, so the build runs in the platform's own runtime instead of
      // failing at the download step.
      if (executor === "github") {
        await triggerGitHubActionsBuild(build.id);
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
      return reply.status(404).send({ error: { code: "BUILD_NOT_FOUND", message: "Build not found" } });
    }

    return reply.send({ build });
  });

  app.get("/builds/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const build = await getBuild(id);

    if (!build || build.user_id !== req.auth!.userId) {
      return reply.status(404).send({ error: { code: "BUILD_NOT_FOUND", message: "Build not found" } });
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
      return reply.status(404).send({ error: { code: "BUILD_NOT_FOUND", message: "Build not found" } });
    }

    const { data: artifacts } = await supabase
      .from("artifacts")
      .select("id, name, sha256, size, url, created_at")
      .eq("build_id", id);

    return reply.send({ artifacts: artifacts || [] });
  });

  app.get("/builds", async (req, reply) => {
    const builds = await listBuilds(req.auth!.userId);
    return reply.send({ builds });
  });
}
