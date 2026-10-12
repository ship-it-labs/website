import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { AgentUnavailableError, agentEnabled, agentModels } from "../services/pollinations.js";
import {
  deleteConversation,
  getConversation,
  listConversations,
  reportProblem,
  sendMessage,
} from "../services/agent-service.js";
import { logger } from "../utils/logger.js";

/**
 * The signed-in assistant. Every route is authenticated and every read is
 * scoped to the caller's own id, so one account can never see another's
 * threads. The model itself is reached only through agent-service; this file
 * validates input, applies a per-user rate limit and translates the
 * "model unavailable" failure into something the widget can show.
 *
 * The rate limit is per account, not per IP: the widget lives behind a login,
 * and one account asking twenty questions a minute is a bot, while a person
 * refining a question is not.
 */

const MESSAGE_LIMIT = 30;
const MESSAGE_WINDOW_MS = 60_000;

async function requireUser(req: Parameters<typeof authenticateApiKey>[0], reply: Parameters<typeof authenticateApiKey>[1]) {
  await authenticateApiKey(req, reply);
  return req.auth?.userId ?? null;
}

function unavailable(reply: Parameters<typeof authenticateApiKey>[1], err: AgentUnavailableError) {
  return reply.status(503).send({
    error: {
      code: "AGENT_UNAVAILABLE",
      message: err.lowBalance
        ? "The assistant is temporarily unavailable (the AI account is out of credit). Please try again later or contact support."
        : "The assistant is temporarily unavailable. Please try again in a moment.",
      low_balance: err.lowBalance,
    },
  });
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agent/status", async () => ({
    enabled: agentEnabled(),
    models: agentModels(),
  }));

  app.get("/agent/conversations", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const conversations = await listConversations(userId);
    return reply.send({ conversations });
  });

  app.get("/agent/conversations/:id", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;

    const { id } = req.params as { id: string };
    const conversation = await getConversation(userId, id);
    if (!conversation) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Conversation not found" } });
    }
    return reply.send(conversation);
  });

  app.delete("/agent/conversations/:id", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;

    const { id } = req.params as { id: string };
    const removed = await deleteConversation(userId, id);
    if (!removed) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "Conversation not found" } });
    }
    return reply.send({ success: true });
  });

  app.post("/agent/messages", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;

    const parsed = z
      .object({
        message: z.string().trim().min(1).max(4000),
        conversation_id: z.string().uuid().nullish(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Message must be 1-4000 characters" },
      });
    }

    const limit = checkRateLimit(`agent:user:${userId}`, MESSAGE_LIMIT, MESSAGE_WINDOW_MS);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "You are asking faster than the assistant can answer. Wait a moment.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    try {
      const turn = await sendMessage(userId, parsed.data.conversation_id ?? null, parsed.data.message);
      return reply.send(turn);
    } catch (err) {
      if (err instanceof AgentUnavailableError) return unavailable(reply, err);
      logger.error({ err, userId }, "Assistant message failed");
      return reply
        .status(500)
        .send({ error: { code: "INTERNAL_ERROR", message: "The assistant could not answer" } });
    }
  });

  app.post("/agent/report", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;

    const parsed = z
      .object({
        summary: z.string().trim().min(3).max(200),
        details: z.string().trim().max(1800).optional().default(""),
        severity: z.enum(["low", "normal", "high"]).optional().default("normal"),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Provide a summary of 3-200 characters" },
      });
    }

    const limit = checkRateLimit(`agent-report:user:${userId}`, 5, 600_000);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "You have filed several reports already. Try again later.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    try {
      await reportProblem(userId, parsed.data.summary, parsed.data.details, parsed.data.severity);
      return reply.status(201).send({ success: true });
    } catch (err) {
      logger.error({ err, userId }, "Assistant report failed");
      return reply
        .status(500)
        .send({ error: { code: "INTERNAL_ERROR", message: "Could not file the report" } });
    }
  });
}
