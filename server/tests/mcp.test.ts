import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { handleMcpMessage, mcpToolList, MCP_SERVER_INFO } from "../src/mcp/server.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";

/**
 * The MCP server is the new front door for AI clients, and the thing it must
 * never become is a second, weaker set of permissions. These tests pin the
 * two properties that matter: the protocol handshake is well formed, and every
 * tool call runs as the caller — the same credential, the same REST rules.
 */

function context(app: unknown, token = "ox_live_test") {
  return { app: app as never, token, userId: "user-1" };
}

describe("MCP handshake", () => {
  it("answers initialize with the protocol version and server info", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    const result = response?.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe(MCP_SERVER_INFO.name);
  });

  it("echoes a protocol version it knows and falls back otherwise", async () => {
    const known = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect((known?.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");

    const unknown = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect((unknown?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("stays silent for a notification", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response).toBeNull();
  });

  it("refuses a method it does not implement", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 7,
      method: "sampling/createMessage",
    });
    expect(response?.error?.code).toBe(-32601);
  });
});

describe("MCP tool catalogue", () => {
  it("exposes the whole platform surface with a schema each", () => {
    const { tools } = mcpToolList();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "list_projects",
        "upload_project",
        "submit_build",
        "get_build_logs",
        "start_runtime",
        "runtime_logs",
        "exec_in_runtime",
        "get_usage",
        "search_docs",
      ])
    );
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("names every tool it lists exactly once", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("MCP tool calls run as the caller", () => {
  it("replays the caller's own credential into the platform API", async () => {
    const app = Fastify();
    app.get("/api/v1/projects", async (req) => ({
      seen: req.headers.authorization,
    }));

    const response = await handleMcpMessage(context(app, "ox_live_abc"), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    });

    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text) as { seen: string };
    expect(payload.seen).toBe("Bearer ox_live_abc");
  });
  it("reports a platform failure as a tool error, not a crash", async () => {
    const app = Fastify();
    app.get("/api/v1/builds/:id", async (_req, reply) =>
      reply.status(404).send({ error: { code: "BUILD_NOT_FOUND", message: "Build not found" } })
    );

    const response = await handleMcpMessage(context(app), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_build", arguments: { build_id: "build_missing" } },
    });

    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("BUILD_NOT_FOUND");
  });

  it("refuses an unknown tool with invalid params", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    expect(response?.error?.code).toBe(-32602);
  });

  it("keeps a missing argument inside the result", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_build", arguments: {} },
    });

    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("build_id");
  });

  it("asks an unauthenticated caller to sign in first", async () => {
    const response = await handleMcpMessage(context({}, ""), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    });

    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("login");
  });
});

describe("MCP login", () => {
  it("hands back an authorization page and a session id", async () => {
    const response = await handleMcpMessage(context({}, ""), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "login", arguments: {} },
    });

    const result = response?.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      status: string;
      session_id: string;
      authorize_url: string;
    };
    expect(payload.status).toBe("authorize");
    expect(payload.session_id.length).toBeGreaterThan(20);
    expect(payload.authorize_url).toContain("/oauth/authorize");
    expect(payload.authorize_url).toContain("client_id=mcp");
  });

  it("reports a login nobody approved yet as pending", async () => {
    const first = await handleMcpMessage(context({}, ""), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "login", arguments: {} },
    });
    const payload = JSON.parse(
      (first?.result as { content: Array<{ text: string }> }).content[0].text
    ) as { session_id: string };

    const second = await handleMcpMessage(context({}, ""), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "login", arguments: { session_id: payload.session_id, wait_seconds: 0 } },
    });
    const status = JSON.parse(
      (second?.result as { content: Array<{ text: string }> }).content[0].text
    ) as { status: string };
    expect(status.status).toBe("pending");
  });

  it("refuses an unknown session", async () => {
    const response = await handleMcpMessage(context({}, ""), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "login", arguments: { session_id: "not-a-real-session" } },
    });
    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
  });
});

describe("MCP documentation resources", () => {
  it("lists the manual as resources", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
    });
    const result = response?.result as {
      resources: Array<{ uri: string; name: string; mimeType: string }>;
    };
    expect(result.resources.length).toBeGreaterThan(0);
    expect(result.resources[0].uri.startsWith("shipit://docs/")).toBe(true);
    expect(result.resources[0].mimeType).toBe("text/markdown");
  });

  it("reads a section of the manual", async () => {
    const listed = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
    });
    const resources = (listed?.result as { resources: Array<{ uri: string }> }).resources;

    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: resources[0].uri },
    });
    const result = response?.result as { contents: Array<{ text: string }> };
    expect(result.contents[0].text.length).toBeGreaterThan(0);
  });

  it("refuses a resource that does not exist", async () => {
    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "shipit://docs/nope" },
    });
    expect(response?.error?.code).toBe(-32602);
  });

  it("offers a guide prompt carrying the manual", async () => {
    const list = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/list",
    });
    const prompts = (list?.result as { prompts: Array<{ name: string }> }).prompts;
    expect(prompts.map((prompt) => prompt.name)).toContain("shipit-guide");

    const response = await handleMcpMessage(context({}), {
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/get",
      params: { name: "shipit-guide", arguments: { topic: "runtimes" } },
    });
    const result = response?.result as { messages: Array<{ content: { text: string } }> };
    expect(result.messages[0].content.text).toContain("runtimes");
  });
});
