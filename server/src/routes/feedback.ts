import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { logger } from "../utils/logger.js";

/**
 * Public feedback inbox. Signed-in senders attach their account (the sender
 * email in the admin view comes from it); anonymous senders from the homepage
 * store null instead. No silent downgrade: a *presented* bearer token must
 * validate, otherwise the request fails rather than laundering an invalid
 * credential into an anonymous message.
 *
 * Abuse control is the rate limit, tiered by attribution: account holders get
 * room for real threads, anonymous senders get just enough for one report an
 * hour. Length-capped at both layers.
 */
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post("/feedback", async (req, reply) => {
    let userId: string | null = null;
    if (req.headers.authorization) {
      await authenticateApiKey(req, reply);
      if (!req.auth) return;
      userId = req.auth.userId;
    }

    const parsed = z
      .object({ message: z.string().trim().min(1).max(2000) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Message must be 1-2000 characters" },
      });
    }

    const limit = userId
      ? checkRateLimit(`feedback:user:${userId}`, 10, 60_000)
      : checkRateLimit(`feedback:anon:${req.ip}`, 3, 3_600_000);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: userId
            ? "Too much feedback at once. Wait a moment and try again."
            : "Too many messages from this address. Try again in a while.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    const { error } = await supabase.from("feedback").insert({
      id: randomUUID(),
      user_id: userId,
      message: parsed.data.message,
    });

    if (error) {
      logger.warn({ err: error, userId }, "Feedback insert failed");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not send feedback right now" },
      });
    }

    return reply.status(201).send({ success: true });
  });
}
