import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import { createBuild, triggerGitHubActionsBuild, getBuild, listBuilds } from "../services/build-service.js";
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
      await triggerGitHubActionsBuild(build.id);
      await recordBuild(req.auth!.userId);
    } catch (err) {
      logger.error({ err, buildId: build.id }, "Failed to trigger build");
      return reply.status(502).send({
        error: { code: "GITHUB_UNAVAILABLE", message: "Failed to trigger build workflow" },
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
