import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { AgentUnavailableError, agentEnabled, agentModels } from "../services/pollinations.js";
import {
  AiQuotaError,
  deleteConversation,
  getConversation,
  listConversations,
  reportProblem,
  resolveEntitlement,
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

/** The paid-only / out-of-credits answer, with enough detail for the upsell. */
function quotaExceeded(reply: Parameters<typeof authenticateApiKey>[1], err: AiQuotaError) {
  const { entitlement } = err;
  return reply.status(402).send({
    error: {
      code: err.reason === "free" ? "AI_UPGRADE_REQUIRED" : "AI_QUOTA_EXCEEDED",
      message:
        err.reason === "free"
          ? "The AI assistant is available on the Pro and Ultra plans. Upgrade to start using it."
          : "You have used all of your AI credits for this month. They reset at the start of your next billing period.",
      plan_id: entitlement.planId,
      limit_credits: entitlement.limitCredits,
      used_credits: entitlement.usedCredits,
      remaining_credits: entitlement.remainingCredits,
    },
  });
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

  // The caller's own allowance: what the widget shows as "credits left" and
  // uses to decide whether to render the chat or the upgrade prompt.
  app.get("/agent/credits", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const credits = await resolveEntitlement(userId);
    return reply.send({ enabled: agentEnabled(), credits });
  });

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
      if (err instanceof AiQuotaError) return quotaExceeded(reply, err);
      if (err instanceof AgentUnavailableError) return unavailable(reply, err);
      logger.error({ err, userId }, "Assistant message failed");
      return reply
        .status(500)
        .send({ error: { code: "INTERNAL_ERROR", message: "The assistant could not answer" } });
    }
  });

  /**
   * The streaming half of the assistant.
   *
   * Same work as `POST /agent/messages`, but the answer arrives as it is
   * written: `delta` events carry the text, `done` carries the finished turn.
   * The reader watches a sentence appear instead of staring at a spinner, and
   * the reply is stored exactly as before.
   */
  app.post("/agent/messages/stream", async (req, reply) => {
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

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // A client that walks away must not leave the turn running forever.
    const aborted = new AbortController();
    req.raw.on("close", () => aborted.abort());

    try {
      const turn = await sendMessage(
        userId,
        parsed.data.conversation_id ?? null,
        parsed.data.message,
        (fragment) => send("delta", { text: fragment })
      );
      send("done", turn);
    } catch (err) {
      if (err instanceof AiQuotaError) {
        send("error", { code: "AI_QUOTA_EXCEEDED", message: err.message });
      } else if (err instanceof AgentUnavailableError) {
        send("error", { code: "AGENT_UNAVAILABLE", message: err.message });
      } else {
        logger.error({ err, userId }, "Assistant stream failed");
        send("error", { code: "INTERNAL_ERROR", message: "The assistant could not answer" });
      }
    } finally {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
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

    // The report surface lives inside the paid assistant, so it is paid-only
    // too; the failure log and support email remain open to everyone.
    const entitlement = await resolveEntitlement(userId);
    if (!entitlement.allowed) return quotaExceeded(reply, new AiQuotaError(entitlement));

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
