import type { FastifyInstance } from "fastify";
import { logger } from "../utils/logger.js";
import { searchDocs } from "../services/agent-docs.js";
import { finalizeProjectUpload } from "../services/upload-finalize.js";
import { isReachableFromTheInternet } from "../services/build-executor.js";
import { LANGUAGES } from "../services/languages.js";

/**
 * The tools the MCP server exposes.
 *
 * Every tool is a thin adapter over the platform's own REST API, replayed
 * in-process through `app.inject`. That is deliberate: the REST contract is
 * what the dashboard, the (deprecated) OpenCode plugin and the API keys all
 * speak, so a second implementation of the same rules would be a second set of
 * bugs. Auth, validation, command guards, rate limits and quota accounting
 * therefore all apply to MCP calls exactly as they do to HTTP calls — there is
 * no privileged path.
 *
 * The one exception is `upload_project`, which takes a URL rather than a
 * multipart body: MCP tool arguments are JSON, so the archive is fetched by
 * the server and handed to the same finalize service the HTTP route uses.
 */

/** Largest project archive the upload tool accepts, matching the HTTP route. */
const MAX_UPLOAD_BYTES = 400 * 1024 * 1024;

export interface McpToolContext {
  /** The Fastify instance, for in-process REST calls. */
  app: FastifyInstance;
  /** The caller's own credential, replayed into the REST API. */
  token: string;
  /** The authenticated owner of the call. */
  userId: string;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<McpToolResult>;
}

interface RestCall {
  method: "GET" | "POST";
  url: string;
  payload?: unknown;
}

/** Turns a REST response into an MCP tool result, preserving the error code. */
async function rest(ctx: McpToolContext, call: RestCall): Promise<McpToolResult> {
  let response;
  try {
    response = await ctx.app.inject({
      method: call.method,
      url: call.url,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        ...(call.payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(call.payload === undefined ? {} : { payload: JSON.stringify(call.payload) }),
    });
  } catch (err) {
    logger.error({ err, url: call.url }, "MCP tool call failed");
    return {
      content: [{ type: "text", text: `Request failed: ${(err as Error).message}` }],
      isError: true,
    };
  }

  const text = response.body ?? "";
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (response.statusCode >= 400) {
    const failure = parsed as { error?: { code?: string; message?: string } } | null;
    const message = failure?.error?.message ?? `Request failed with status ${response.statusCode}`;
    const code = failure?.error?.code ? ` [${failure.error.code}]` : "";
    return { content: [{ type: "text", text: `${message}${code}` }], isError: true };
  }

  return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value.trim();
}

function optStr(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_projects",
    description:
      "List the projects on this account. Each project has an id, a name and the archive it was uploaded from.",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => rest(ctx, { method: "GET", url: "/api/v1/projects" }),
  },
  {
    name: "upload_project",
    description:
      "Register a project from a zip archive. The archive is fetched from source_url (a public https URL) and stored for this account. Re-uploading the same project_id updates it in place.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Stable id for the project, e.g. 'my-app'." },
        source_url: { type: "string", description: "Public https URL of a .zip archive." },
        project_name: { type: "string", description: "Display name. Defaults to the project id." },
        run_command: {
          type: "string",
          description: "Command that starts the app inside the runtime, e.g. 'node dist/server.js'.",
        },
        language: {
          type: "string",
          enum: [...LANGUAGES],
          description: "Language of the project. Detected from the sources when omitted.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment variables for the runtime. Stored encrypted, never logged.",
        },
      },
      required: ["project_id", "source_url"],
    },
    handler: async (ctx, args) => {
      let projectId: string;
      let sourceUrl: string;
      try {
        projectId = str(args, "project_id");
        sourceUrl = str(args, "source_url");
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }

      if (!sourceUrl.startsWith("https://") || !isReachableFromTheInternet(sourceUrl)) {
        return {
          content: [
            {
              type: "text",
              text: "source_url must be a public https URL (private and local addresses are refused).",
            },
          ],
          isError: true,
        };
      }

      let archive: Buffer;
      try {
        const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Could not fetch the archive: HTTP ${response.status}` }],
            isError: true,
          };
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) {
          return { content: [{ type: "text", text: "The archive is empty." }], isError: true };
        }
        if (bytes.length > MAX_UPLOAD_BYTES) {
          return {
            content: [
              { type: "text", text: `The archive exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.` },
            ],
            isError: true,
          };
        }
        archive = bytes;
      } catch (err) {
        return {
          content: [{ type: "text", text: `Could not fetch the archive: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const envArg = args.env;
      const envRaw =
        envArg && typeof envArg === "object" && !Array.isArray(envArg)
          ? JSON.stringify(envArg)
          : null;

      const outcome = await finalizeProjectUpload({
        userId: ctx.userId,
        requestedId: projectId,
        projectName: optStr(args, "project_name"),
        runCommand: optStr(args, "run_command"),
        declaredLanguage: optStr(args, "language"),
        envRaw,
        manifest: null,
        filename: "archive.zip",
        store: { kind: "buffer", data: archive },
      });

      return {
        content: [{ type: "text", text: JSON.stringify(outcome.body, null, 2) }],
        isError: outcome.status >= 400,
      };
    },
  },
  {
    name: "submit_build",
    description:
      "Start a build for a project. The build runs in CI and produces a self-contained runtime bundle. Poll with get_build and get_build_logs.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project to build." },
        install_commands: {
          type: "array",
          items: { type: "string" },
          description: "Dependency installation commands, e.g. ['npm ci'].",
        },
        build_commands: {
          type: "array",
          items: { type: "string" },
          description: "Build commands, e.g. ['npm run build'].",
        },
        test_commands: {
          type: "array",
          items: { type: "string" },
          description: "Test commands, e.g. ['npm test'].",
        },
        language: { type: "string", enum: [...LANGUAGES], description: "Overrides the project's language." },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Build-time environment. Forwarded to the runner, never stored.",
        },
      },
      required: ["project_id"],
    },
    handler: (ctx, args) => {
      let projectId: string;
      try {
        projectId = str(args, "project_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      const payload: Record<string, unknown> = {
        project_id: projectId,
        install_commands: strList(args, "install_commands"),
        build_commands: strList(args, "build_commands"),
        test_commands: strList(args, "test_commands"),
      };
      const language = optStr(args, "language");
      if (language) payload.language = language;
      const env = args.env;
      if (env && typeof env === "object" && !Array.isArray(env)) payload.env = env;
      return rest(ctx, { method: "POST", url: "/api/v1/builds", payload });
    },
  },
  {
    name: "list_builds",
    description: "List the builds on this account, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "pending", "running", "success", "failure", "timeout"],
          description: "Filter by status. Defaults to all.",
        },
      },
    },
    handler: (ctx, args) => {
      const status = optStr(args, "status");
      const url = status && status !== "all" ? `/api/v1/builds?status=${encodeURIComponent(status)}` : "/api/v1/builds";
      return rest(ctx, { method: "GET", url });
    },
  },
  {
    name: "get_build",
    description: "Get one build: its status, timings, exit code and the GitHub Actions run behind it.",
    inputSchema: {
      type: "object",
      properties: { build_id: { type: "string", description: "Build id, e.g. 'build_ab12cd34'." } },
      required: ["build_id"],
    },
    handler: (ctx, args) => {
      let buildId: string;
      try {
        buildId = str(args, "build_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, { method: "GET", url: `/api/v1/builds/${encodeURIComponent(buildId)}` });
    },
  },
  {
    name: "get_build_logs",
    description: "Get the captured log lines of a build.",
    inputSchema: {
      type: "object",
      properties: { build_id: { type: "string", description: "Build id." } },
      required: ["build_id"],
    },
    handler: (ctx, args) => {
      let buildId: string;
      try {
        buildId = str(args, "build_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, { method: "GET", url: `/api/v1/builds/${encodeURIComponent(buildId)}/logs` });
    },
  },
  {
    name: "start_runtime",
    description:
      "Start a runtime for a project. The runtime runs the project's CI bundle when there is one, so the app starts with its own toolchain and dependencies.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project to run." } },
      required: ["project_id"],
    },
    handler: (ctx, args) => {
      let projectId: string;
      try {
        projectId = str(args, "project_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, { method: "POST", url: "/api/v1/runtimes", payload: { project_id: projectId } });
    },
  },
  {
    name: "list_runtimes",
    description: "List the running runtimes on this account.",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => rest(ctx, { method: "GET", url: "/api/v1/runtimes" }),
  },
  {
    name: "get_runtime",
    description: "Get one runtime: its status, the public address of the app and the host it runs on.",
    inputSchema: {
      type: "object",
      properties: { runtime_id: { type: "string", description: "Runtime id." } },
      required: ["runtime_id"],
    },
    handler: (ctx, args) => {
      let runtimeId: string;
      try {
        runtimeId = str(args, "runtime_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, { method: "GET", url: `/api/v1/runtimes/${encodeURIComponent(runtimeId)}` });
    },
  },
  {
    name: "stop_runtime",
    description: "Stop a running runtime.",
    inputSchema: {
      type: "object",
      properties: { runtime_id: { type: "string", description: "Runtime id." } },
      required: ["runtime_id"],
    },
    handler: (ctx, args) => {
      let runtimeId: string;
      try {
        runtimeId = str(args, "runtime_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, { method: "POST", url: `/api/v1/runtimes/${encodeURIComponent(runtimeId)}/stop` });
    },
  },
  {
    name: "runtime_logs",
    description: "Get the recent output of a running runtime.",
    inputSchema: {
      type: "object",
      properties: { runtime_id: { type: "string", description: "Runtime id." } },
      required: ["runtime_id"],
    },
    handler: (ctx, args) => {
      let runtimeId: string;
      try {
        runtimeId = str(args, "runtime_id");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, { method: "POST", url: `/api/v1/runtimes/${encodeURIComponent(runtimeId)}/logs` });
    },
  },
  {
    name: "exec_in_runtime",
    description: "Run a shell command inside a running runtime and get its output.",
    inputSchema: {
      type: "object",
      properties: {
        runtime_id: { type: "string", description: "Runtime id." },
        command: { type: "string", description: "Command to run inside the sandbox." },
      },
      required: ["runtime_id", "command"],
    },
    handler: (ctx, args) => {
      let runtimeId: string;
      let command: string;
      try {
        runtimeId = str(args, "runtime_id");
        command = str(args, "command");
      } catch (err) {
        return Promise.resolve({
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        });
      }
      return rest(ctx, {
        method: "POST",
        url: `/api/v1/runtimes/${encodeURIComponent(runtimeId)}/exec`,
        payload: { command },
      });
    },
  },
  {
    name: "get_usage",
    description: "Get the account's current usage against its plan: runtime hours, concurrency and storage.",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => rest(ctx, { method: "GET", url: "/api/v1/usage" }),
  },
  {
    name: "get_account",
    description: "Get the account: email, plan and the API keys it owns.",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => rest(ctx, { method: "GET", url: "/api/v1/account" }),
  },
  {
    name: "search_docs",
    description: "Search the Ship-It documentation for a topic.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, e.g. 'retention policy' or 'API key'." },
      },
      required: ["query"],
    },
    handler: async (_ctx, args) => {
      let query: string;
      try {
        query = str(args, "query");
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
      const sections = searchDocs(query, 4);
      if (sections.length === 0) {
        return {
          content: [{ type: "text", text: "No documentation section matched that query." }],
        };
      }
      const text = sections
        .map((section) => `## ${section.title}\n${section.body}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  },
];

/** Tool lookup by name. */
export function mcpTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
