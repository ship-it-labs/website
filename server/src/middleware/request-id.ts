import crypto from "node:crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestId?: string;
  }
}

/**
 * One id per request, echoed back on the response. Clients paste it with a bug
 * report and the matching log line is one grep away. Reuses the client's
 * x-request-id when present so a retried call keeps its identity end to end.
 */
export function requestIdHook(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const incoming = req.headers["x-request-id"];
    const id =
      (Array.isArray(incoming) ? incoming[0] : incoming)?.trim() ||
      crypto.randomUUID();
    req.requestId = id;
    reply.header("x-request-id", id);
  });
}

/** Builds the error envelope every handler and the error handler share. */
export function errorEnvelope(
  req: FastifyRequest,
  code: string,
  message: string
): { error: { code: string; message: string; request_id?: string } } {
  return {
    error: {
      code,
      message,
      ...(req.requestId ? { request_id: req.requestId } : {}),
    },
  };
}
