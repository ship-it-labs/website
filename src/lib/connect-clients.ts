/**
 * The clients Ship-It can connect to, and the snippet each one needs.
 *
 * Every modern MCP client keeps its server list in its own file, so the only
 * thing that differs between them is the shape of the config and where it
 * lives. The MCP server is the only integration surface: one server, one
 * login, and the same tools for everybody.
 */

export interface ConnectClient {
  id: string;
  name: string;
  /** Where the snippet goes. */
  location: string;
  /** One line: what the user does with it. */
  summary: string;
  language: "json" | "toml" | "shell";
  snippet: (mcpUrl: string) => string;
  deprecated?: boolean;
  note?: string;
}

export const CONNECT_CLIENTS: ConnectClient[] = [
  {
    id: "claude",
    name: "Claude",
    location: "claude_desktop_config.json (or Settings → Connectors)",
    summary:
      "Paste this into your Claude config. The agent signs in for you the first time it needs the platform.",
    language: "json",
    snippet: (url) =>
      JSON.stringify(
        {
          mcpServers: {
            "ship-it": {
              type: "http",
              url,
              headers: { Authorization: "Bearer YOUR_API_KEY" },
            },
          },
        },
        null,
        2
      ),
    note: "Leave the header as-is for now: the agent calls the login tool, which opens the Ship-It page for you to approve.",
  },
  {
    id: "codex",
    name: "Codex",
    location: "~/.codex/config.toml",
    summary: "Add the server to your Codex config, then restart Codex.",
    language: "toml",
    snippet: (url) =>
      [
        "[mcp_servers.ship-it]",
        `url = "${url}"`,
        "",
        "# The agent signs in with the login tool on first use.",
        "# To use a key instead, export it and point Codex at it:",
        '# bearer_token_env_var = "SHIPIT_API_KEY"',
      ].join("\n"),
  },
  {
    id: "cursor",
    name: "Cursor",
    location: ".cursor/mcp.json",
    summary: "Drop this into your project (or ~/.cursor/mcp.json for every project).",
    language: "json",
    snippet: (url) =>
      JSON.stringify(
        {
          mcpServers: {
            "ship-it": {
              url,
              headers: { Authorization: "Bearer YOUR_API_KEY" },
            },
          },
        },
        null,
        2
      ),
  },
  {
    id: "vscode",
    name: "VS Code",
    location: ".vscode/mcp.json",
    summary: "Works with Copilot's agent mode and any VS Code build that speaks MCP.",
    language: "json",
    snippet: (url) =>
      JSON.stringify(
        {
          servers: {
            "ship-it": {
              type: "http",
              url,
              headers: { Authorization: "Bearer YOUR_API_KEY" },
            },
          },
        },
        null,
        2
      ),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    location: "~/.codeium/windsurf/mcp_config.json",
    summary: "Add the server to Windsurf's MCP config and restart it.",
    language: "json",
    snippet: (url) =>
      JSON.stringify(
        {
          mcpServers: {
            "ship-it": {
              url,
              headers: { Authorization: "Bearer YOUR_API_KEY" },
            },
          },
        },
        null,
        2
      ),
  },
];
