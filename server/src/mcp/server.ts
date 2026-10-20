import { MCP_TOOLS, mcpTool, type McpToolContext, type McpToolResult } from "./tools.js";
import { logger } from "../utils/logger.js";

/**
 * The Model Context Protocol, spoken over JSON-RPC 2.0 on a single HTTP
 * endpoint.
 *
 * Only the parts the platform needs are implemented: initialize, the tool
 * list, tool calls, and the empty resource/prompt lists clients ask for
 * during the handshake. There are no resources or prompts by design — the
 * platform's surface is tools that act on the caller's own account.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Versions this server speaks. The client's choice is echoed when known. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export const MCP_SERVER_INFO = {
  name: "ship-it",
  version: "1.0.0",
  title: "Ship-It",
};

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** The caller's id, or null for a notification that expects no reply. */
function requestId(raw: unknown): string | number | null {
  if (typeof raw === "string" || typeof raw === "number") return raw;
  return null;
}

function isNotification(raw: unknown): boolean {
  return raw === undefined || raw === null;
}

function paramsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** The tool catalogue in the shape the protocol expects. */
export function mcpToolList(): {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
} {
  return {
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

/**
 * Runs one tool and shapes the result. A tool that throws is an execution
 * error, not a protocol error: the client is told the call failed and keeps
 * its session.
 */
async function callTool(ctx: McpToolContext, params: Record<string, unknown>): Promise<McpToolResult> {
  const name = params.name;
  if (typeof name !== "string" || !name) {
    throw new Error("tools/call requires a tool name");
  }
  const tool = mcpTool(name);
  if (!tool) {
    throw new McpProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  const args = params.arguments;
  const argsObject = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  return tool.handler(ctx, argsObject);
}

class McpProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
  }
}

/**
 * Handles one JSON-RPC message. Returns null for notifications, which by
 * definition get no reply.
 */
export async function handleMcpMessage(
  ctx: McpToolContext,
  message: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || typeof message.method !== "string") {
    return fail(requestId(message?.id), INVALID_REQUEST, "Invalid JSON-RPC request");
  }

  const id = requestId(message.id);
  const method = message.method;
  const params = paramsOf(message.params);

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
        ? asked
        : MCP_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "Ship-It builds and runs the caller's projects. Upload a project, submit a build, then start a runtime. Every tool acts on the authenticated account only.",
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, mcpToolList());

    case "tools/call": {
      try {
        const result = await callTool(ctx, params);
        return ok(id, result);
      } catch (err) {
        if (err instanceof McpProtocolError) {
          return fail(id, err.code, err.message);
        }
        // A tool that blew up is reported in the result, with isError set, so
        // the model can see what happened and try something else.
        logger.error({ err, userId: ctx.userId }, "MCP tool call threw");
        const message = err instanceof Error ? err.message : String(err);
        return ok(id, {
          content: [{ type: "text", text: `Tool failed: ${message}` }],
          isError: true,
        } satisfies McpToolResult);
      }
    }

    case "resources/list":
      return ok(id, { resources: [] });

    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });

    case "prompts/list":
      return ok(id, { prompts: [] });

    case "logging/setLevel":
      return ok(id, {});

    default:
      if (isNotification(message.id)) return null;
      return fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}
