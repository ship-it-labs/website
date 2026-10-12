import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { optionalAuthUserId } from "../middleware/auth.js";
import { checkRateLimit } from "../services/rate-limit.js";
import { toErrorEventRow } from "../services/error-log.js";
import { logger } from "../utils/logger.js";

/**
 * Browser failure inbox. The frontend's global handlers (page crashes,
 * unhandled rejections, failed API calls) report here fire-and-forget; the
 * admin Errors tab reads them back alongside server-side 5xx rows.
 *
 * Attribution is fail-open anonymous: a *presented* bearer token is validated
 * and attached when it checks out, but an invalid or absent one still records
 * the failure anonymously. Dropping crash reports from logged-out pages (or
 * from a session whose token just expired) would blind exactly the failures
 * that matter most, and a forged attribution is harmless — it only tags a row.
 *
 * Abuse control is the rate limit: 30 reports a minute per address is room for
 * a genuinely broken page spamming reloads, while a deliberate flood ages out
 * in a minute. Length caps live in the schema and in the row builder.
 */
export const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  path: z.string().trim().min(1).max(500),
  kind: z.enum(["api", "render", "window", "rejection"]).default("window"),
  status: z.number().int().min(400).max(599).nullish(),
  code: z.string().trim().min(1).max(100).nullish(),
  stack: z.string().max(4000).nullish(),
});

export async function clientErrorRoutes(app: FastifyInstance): Promise<void> {
  app.post("/client-errors", async (req, reply) => {
    const userId = await optionalAuthUserId(req);

    const parsed = clientErrorSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid error report" },
      });
    }

    const limit = checkRateLimit(`client-errors:${req.ip}`, 30, 60_000);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many error reports. Try again in a moment.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    const report = parsed.data;
    const message = report.stack
      ? `${report.message}\n${report.stack.slice(0, 900)}`
      : report.message;

    const { error } = await supabase.from("error_events").insert({
      ...toErrorEventRow({
        source: "client",
        method: report.kind,
        path: report.path,
        statusCode: report.status ?? null,
        errorCode: report.code ?? null,
        message,
        userId,
      }),
    });

    if (error) {
      logger.warn({ err: error }, "Client error report insert failed");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not record the report" },
      });
    }

    return reply.status(201).send({ received: true });
  });
}
