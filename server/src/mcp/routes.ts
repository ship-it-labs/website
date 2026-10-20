import type { FastifyInstance, FastifyRequest } from "fastify";
import { optionalAuth } from "../middleware/auth.js";
import { handleMcpMessage, MCP_PARSE_ERROR, type JsonRpcRequest } from "./server.js";
import { supabase } from "../db/index.js";
import { exchangeCode } from "../services/oauth.js";
import {
  MCP_OAUTH_CLIENT_ID,
  approveMcpLoginSession,
  denyMcpLoginSession,
  getMcpLoginSession,
} from "../services/mcp-login.js";
import { logger } from "../utils/logger.js";

/**
 * The MCP endpoint.
 *
 * One URL, `/mcp`, speaks JSON-RPC 2.0. The caller's Ship-It API key travels
 * in the `Authorization` header (or `x-api-key`), and the same credential is
 * replayed into the platform's own REST API for each tool call — so an MCP
 * client has exactly the powers an API key has, and no more.
 *
 * The endpoint is not guarded by the usual 401: the `login` tool has to work
 * before any credential exists. Tools that need an account say so themselves.
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

/** The page the browser lands on once the authorization is decided. */
function loginPage(message: string, ok: boolean): string {
  const colour = ok ? "#22c55e" : "#f59e0b";
  return [
    "<!doctype html><html><head><meta charset='utf-8'>",
    "<title>Ship-It</title></head>",
    "<body style='background:#09090b;color:#e4e4e7;font-family:system-ui;",
    "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>",
    `<div style='max-width:32rem;text-align:center'>`,
    `<div style='font-size:2rem;color:${colour}'>${ok ? "✓" : "!"}</div>`,
    `<p style='font-size:1.05rem;line-height:1.6'>${message}</p>`,
    "</div></body></html>",
  ].join("");
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mcp", async (req, reply) => {
    const token = callerToken(req);
    const auth = token ? await optionalAuth(req) : null;

    const ctx = { app, token: auth ? token : "", userId: auth?.userId ?? "" };
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

  // The browser's landing place after the user approves. The code arrives
  // here; this server holds the PKCE proof, so the browser never carries
  // anything that could be replayed somewhere else.
  app.get("/mcp/login/callback/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { code?: string; state?: string; error?: string };

    const session = getMcpLoginSession(id);
    if (!session) {
      return reply
        .status(404)
        .type("text/html")
        .send(loginPage("This login link is no longer valid. Start the login again.", false));
    }

    if (query.error) {
      denyMcpLoginSession(id);
      return reply
        .status(200)
        .type("text/html")
        .send(loginPage("Authorization was denied. Nothing was connected.", false));
    }

    if (!query.code || query.state !== session.state) {
      return reply
        .status(400)
        .type("text/html")
        .send(loginPage("The authorization response did not match this login.", false));
    }

    try {
      const { accessToken, userId } = await exchangeCode(supabase, {
        code: query.code,
        clientId: MCP_OAUTH_CLIENT_ID,
        redirectUri: session.redirectUri,
        codeVerifier: session.verifier,
      });
      approveMcpLoginSession(id, accessToken, userId);
      logger.info({ userId }, "MCP login approved");
      return reply
        .status(200)
        .type("text/html")
        .send(
          loginPage(
            "Ship-It is connected. You can close this tab and go back to your AI assistant.",
            true
          )
        );
    } catch (err) {
      logger.error({ err }, "MCP login exchange failed");
      return reply
        .status(400)
        .type("text/html")
        .send(loginPage("The authorization could not be completed. Start the login again.", false));
    }
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
