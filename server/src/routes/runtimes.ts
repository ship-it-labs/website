import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import { getQuotaStatus } from "../services/quota-service.js";
import { callOrchestrator } from "../services/orchestrator-client.js";
import { logger } from "../utils/logger.js";

const startSchema = z.object({
  project_id: z.string().min(1),
});

export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.post("/runtimes", async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid runtime request" },
      });
    }

    try {
      const result = await callOrchestrator<{ runtime: unknown }>("/runtime/start", {
        user_id: req.auth!.userId,
        project_id: parsed.data.project_id,
        plan: {
          runtime_hours_per_month: req.auth!.plan.runtime_hours_per_month,
          max_runtime_hours: req.auth!.plan.max_runtime_hours,
          max_ram_mb: req.auth!.plan.max_ram_mb,
          cpu: Number(req.auth!.plan.cpu),
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
        logger.error({ err, runtimeId: id, action }, `Orchestrator ${action} failed`);
        return reply.status(502).send({
          error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
        });
      }
    });
  }

  app.get("/usage", async (req, reply) => {
    const quota = await getQuotaStatus(req.auth!.userId, req.auth!.plan);
    return reply.send({
      monthly_runtime_limit_seconds: quota.monthlyLimitSeconds,
      runtime_used_seconds: quota.usedSeconds,
      runtime_remaining_seconds: quota.remainingSeconds,
      max_session_seconds: quota.maxSessionSeconds,
      plan: req.auth!.plan,
    });
  });
}

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}
