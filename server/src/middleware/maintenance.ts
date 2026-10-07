import { FastifyRequest, FastifyReply } from "fastify";
import { isMaintenanceMode } from "../services/admin.js";
import { errorEnvelope } from "./request-id.js";

/**
 * Maintenance mode: while the platform_settings flag is on, new runtime starts
 * are refused with a 503 the dashboard can quote verbatim. Read as a global
 * hook (rather than inside the runtime route, which another batch owns) so the
 * pause cannot be bypassed by route order and needs no edit outside this
 * batch's files. Existing runtimes, builds and reads are untouched — the flag
 * stops new spend, it does not strand running work.
 */
export async function maintenanceHook(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (req.method !== "POST") return;
  if (req.url !== "/api/v1/runtimes" && req.url.split("?")[0] !== "/api/v1/runtimes") {
    return;
  }

  if (await isMaintenanceMode()) {
    reply.status(503).send(
      errorEnvelope(
        req,
        "MAINTENANCE_MODE",
        "The platform is in maintenance mode. New runtimes cannot start right now — running apps are unaffected."
      )
    );
  }
}
