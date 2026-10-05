import { FastifyInstance } from "fastify";
import { callOrchestrator } from "../services/orchestrator-client.js";

/**
 * Public platform status for the status page. Deliberately unauthenticated
 * and deliberately coarse: "ok" or "unreachable" per dependency, nothing
 * countable, nothing attributable. A status page that leaks user counts or
 * agent addresses is a reconnaissance feed with good CSS.
 */
export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status", async (_req, reply) => {
    let orchestrator: "ok" | "unreachable" = "unreachable";
    try {
      await callOrchestrator<{ status: string }>("/health", {}, 5000);
      orchestrator = "ok";
    } catch {
      // Best-effort is the point: the page must render the outage, not join it.
    }

    return reply.send({
      site: "ok" as const,
      orchestrator,
      time: new Date().toISOString(),
    });
  });
}
