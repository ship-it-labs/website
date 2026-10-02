import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import { supabase } from "../db/index.js";
import { getQuotaStatus } from "../services/quota-service.js";
import { callOrchestrator } from "../services/orchestrator-client.js";
import { logger } from "../utils/logger.js";

const startSchema = z.object({
  project_id: z.string().min(1),
});

// How long the agent may hold the archive link. The download begins
    // immediately on start, so this only needs to survive a slow queue.
const SOURCE_URL_TTL_SECONDS = 15 * 60;

export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.post("/runtimes", async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid runtime request" },
      });
    }

    const userId = req.auth!.userId;
    const projectId = parsed.data.project_id;

    // The project lives in this process's own store, so the start command and
    // the archive location are resolved here. Previously the orchestrator looked
    // the command up in a different database entirely and always came back
    // empty, which left the container with nothing to run.
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, run_command, upload_path, upload_sha256")
      .eq("id", projectId)
      .eq("user_id", userId)
      .single();

    if (projectError || !project) {
      return reply.status(404).send({
        error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
      });
    }

    // A signed link the agent can actually reach: it pulls from inside the
    // private network, where the public hostname would not resolve.
    const { data: signed, error: signError } = await supabase.storage
      .from("project-uploads")
      .createSignedUrl(project.upload_path!, SOURCE_URL_TTL_SECONDS, {
        audience: "internal",
      });

    if (signError || !signed?.signedUrl) {
      logger.error({ err: signError, projectId }, "Could not sign the project archive");
      return reply.status(500).send({
        error: {
          code: "SOURCE_UNAVAILABLE",
          message: "The project archive could not be prepared for this runtime.",
        },
      });
    }

    try {
      const result = await callOrchestrator<{ runtime: unknown }>("/runtime/start", {
        user_id: userId,
        project_id: projectId,
        run_command: project.run_command ?? "",
        source_url: signed.signedUrl,
        source_sha256: project.upload_sha256 ?? "",
        plan: {
          runtime_hours_per_month: req.auth!.plan.runtime_hours_per_month,
          max_runtime_hours: req.auth!.plan.max_runtime_hours,
          max_concurrent_runtimes: req.auth!.plan.max_concurrent_runtimes,
          max_ram_mb: req.auth!.plan.max_ram_mb,
          cpu: Number(req.auth!.plan.cpu),
          plan_id: req.auth!.plan.id,
        },
      });

      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof OrchestratorError) {
        // Surface the orchestrator's own reason instead of masking everything
        // as unreachable: quota, capacity and agent failures each need a
        // different response from the caller.
        const status =
          err.code === "RUNTIME_QUOTA_EXCEEDED"
            ? 403
            : err.code === "RUNTIME_NOT_FOUND"
              ? 404
              : // Capacity is temporary rather than a fault, so it stays a 429
                // and the message is written for the person reading it.
                err.code === "CAPACITY_EXHAUSTED"
                ? 429
                : err.code === "CONCURRENCY_LIMIT_REACHED"
                  ? 409
                  : 502;

        return reply.status(status).send({
          error: { code: err.code, message: err.message },
        });
      }
      logger.error({ err, userId: req.auth!.userId }, "Orchestrator start failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }
  });

  app.get("/runtimes", async (req, reply) => {
    try {
      const result = await callOrchestrator<{ runtimes: unknown[] }>("/runtime/list", {
        user_id: req.auth!.userId,
      });
      return reply.send(result);
    } catch (err) {
      logger.error({ err }, "Orchestrator list failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }
  });

  app.get("/runtimes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await callOrchestrator<unknown>("/runtime/status", {
        runtime_id: id,
        user_id: req.auth!.userId,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof OrchestratorError && err.code === "RUNTIME_NOT_FOUND") {
        return reply.status(404).send({
          error: { code: "RUNTIME_NOT_FOUND", message: "Runtime not found" },
        });
      }
      logger.error({ err, runtimeId: id }, "Orchestrator status failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }
  });

  const simpleActions = ["stop", "restart", "logs", "info", "health"] as const;

  for (const action of simpleActions) {
    app.post(`/runtimes/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await callOrchestrator<unknown>(`/runtime/${action}`, {
          runtime_id: id,
          user_id: req.auth!.userId,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof OrchestratorError && err.code === "RUNTIME_NOT_FOUND") {
          return reply.status(404).send({
            error: { code: "RUNTIME_NOT_FOUND", message: "Runtime not found" },
          });
        }
        logger.error({ err, runtimeId: id, action }, `Orchestrator ${action} failed`);
        return reply.status(502).send({
          error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
        });
      }
    });
  }

  const proxiedActions = [
    "exec",
    "fs",
    "network",
    "cpu",
    "memory",
    "disk",
    "uptime",
  ] as const;

  for (const action of proxiedActions) {
    app.post(`/runtimes/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await callOrchestrator<unknown>(`/runtime/${action}`, {
          runtime_id: id,
          user_id: req.auth!.userId,
          ...(req.body as Record<string, unknown> | undefined),
        });
        return reply.send(result);
      } catch (err) {
        // A rejected request is not an unreachable orchestrator. Collapsing every
        // failure into 502 reported a bad argument as a dead service, which sent
        // people looking in the wrong place.
        if (err instanceof OrchestratorError && isCallerError(err.code)) {
          return reply.status(400).send({
            error: { code: err.code, message: err.message },
          });
        }

        logger.error({ err, runtimeId: id, action }, `Orchestrator ${action} failed`);
        return reply.status(502).send({
          error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
        });
      }
    });
  }

  app.get("/usage", async (req, reply) => {
    const plan = req.auth!.plan;

    // The orchestrator is asked first because it owns the runtime lifecycle and
    // is the only service that saw the session begin and end. Reading the local
    // usage table first was how usage stayed at zero: nothing ever wrote a row
    // there, because the billing happens in the orchestrator's own store.
    try {
      const snapshot = await callOrchestrator<{
        monthly_runtime_limit_seconds: number;
        runtime_used_seconds: number;
        runtime_remaining_seconds: number;
        max_session_seconds: number;
        runtime_live_seconds: number;
      }>("/usage/snapshot", {
        user_id: req.auth!.userId,
        plan_hours_per_month: plan.runtime_hours_per_month,
        plan_max_runtime_hours: plan.max_runtime_hours,
      });

      return reply.send({
        monthly_runtime_limit_seconds: snapshot.monthly_runtime_limit_seconds,
        runtime_used_seconds: snapshot.runtime_used_seconds,
        runtime_remaining_seconds: snapshot.runtime_remaining_seconds,
        max_session_seconds: snapshot.max_session_seconds,
        // Split out so a total that keeps moving can be explained: this is the
        // part being spent right now rather than time already billed.
        runtime_live_seconds: snapshot.runtime_live_seconds ?? 0,
        plan,
      });
    } catch (err) {
      // Falling back keeps the dashboard usable if the orchestrator is down;
      // it just shows the locally accounted number rather than failing outright.
      logger.warn({ err }, "Orchestrator usage unavailable, falling back to local totals");
    }

    const quota = await getQuotaStatus(req.auth!.userId, plan);
    return reply.send({
      monthly_runtime_limit_seconds: quota.monthlyLimitSeconds,
      runtime_used_seconds: quota.usedSeconds,
      runtime_remaining_seconds: quota.remainingSeconds,
      max_session_seconds: quota.maxSessionSeconds,
      plan,
    });
  });
}

/**
 * Codes that mean the caller sent something the orchestrator refused, rather
 * than the orchestrator being unable to answer. These deserve a 400 rather than
 * a 502, because retrying them unchanged will fail identically.
 */
function isCallerError(code: string): boolean {
  return (
    code === "INVALID_REQUEST" ||
    code === "VALIDATION_ERROR" ||
    code === "INVALID_OPERATION" ||
    code === "PATH_TRAVERSAL" ||
    code === "RUNTIME_NOT_FOUND"
  );
}

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}
