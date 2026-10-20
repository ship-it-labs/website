import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateApiKey } from "../middleware/auth.js";
import { handleMcpMessage, MCP_PARSE_ERROR, type JsonRpcRequest } from "./server.js";
import { logger } from "../utils/logger.js";

/**
 * The MCP endpoint.
 *
 * One URL, `/mcp`, speaks JSON-RPC 2.0. The caller's Ship-It API key travels
 * in the `Authorization` header (or `x-api-key`), and the same credential is
 * replayed into the platform's own REST API for each tool call — so an MCP
 * client has exactly the powers an API key has, and no more.
 */

/** The caller's bearer token, however the client chose to present it. */
function callerToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) {
    return apiKey.trim();
  }
  return "";
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mcp", { preHandler: authenticateApiKey }, async (req, reply) => {
    const token = callerToken(req);
    if (!token) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Missing credentials" },
      });
    }

    const ctx = { app, token, userId: req.auth!.userId };
    const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;

    if (body === undefined || body === null) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: MCP_PARSE_ERROR, message: "Empty request body" },
      });
    }

    // A batch is answered with a batch; a notification gets no body at all,
    // which is what the protocol says an HTTP 202 with nothing in it means.
    if (Array.isArray(body)) {
      const responses = [];
      for (const message of body) {
        const response = await handleMcpMessage(ctx, message);
        if (response) responses.push(response);
      }
      if (responses.length === 0) {
        return reply.status(202).send();
      }
      return reply.send(responses);
    }

    const response = await handleMcpMessage(ctx, body);
    if (!response) {
      return reply.status(202).send();
    }
    return reply.send(response);
  });

  // The streamable HTTP transport lets a client open a server-sent event
  // stream here. This server answers every request synchronously, so there is
  // nothing to stream: say so plainly instead of leaving the client hanging.
  app.get("/mcp", async (_req, reply) => {
    return reply.status(405).send({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "This MCP server answers synchronously over POST. Use POST /mcp.",
      },
    });
  });

  // Session teardown. There are no server-held sessions, so this only exists
  // so a client that ends a session cleanly gets a clean answer.
  app.delete("/mcp", async (_req, reply) => {
    return reply.status(200).send({ ok: true });
  });

  logger.info("MCP server mounted at /mcp");
}
