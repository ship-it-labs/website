---
id: connect
title: Connect your AI assistant
sidebar_position: 1
---

Ship-It speaks the **Model Context Protocol**, so one server works with every
client that speaks it. There is nothing to install: the server lives at
`/mcp` on this site.

## The three steps

1. **Paste your client's snippet.** The tab below has the exact file and the
   exact contents.
2. **Ask your agent to log in.** It calls the `login` tool, which opens a
   Ship-It page in your browser.
3. **Approve.** You sign in if you are not already, and the agent gets an
   access token it uses from then on.

Nothing secret passes through the chat: the browser carries a one-time code,
the platform redeems it, and the agent receives a token it keeps to itself.

## Claude

Add this to `claude_desktop_config.json` (Claude Desktop) or to
**Settings → Connectors → Add custom MCP server**:

```json
{
  "mcpServers": {
    "ship-it": {
      "type": "http",
      "url": "https://ship-it-fri1.onrender.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Leave the header as it is for now: the agent calls the login tool, which
opens the Ship-It page for you to approve. If you would rather use a key, it
is in **Settings → Connected apps**.

## Codex

Add the server to `~/.codex/config.toml`, then restart Codex:

```toml
[mcp_servers.ship-it]
url = "https://ship-it-fri1.onrender.com/mcp"

# The agent signs in with the login tool on first use.
# To use a key instead, export it and point Codex at it:
# bearer_token_env_var = "SHIPIT_API_KEY"
```

## Cursor

Drop this into `.cursor/mcp.json` in your project, or
`~/.cursor/mcp.json` to have it everywhere:

```json
{
  "mcpServers": {
    "ship-it": {
      "url": "https://ship-it-fri1.onrender.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

## VS Code

Works with Copilot's agent mode and any VS Code build that speaks MCP —
`.vscode/mcp.json`:

```json
{
  "servers": {
    "ship-it": {
      "type": "http",
      "url": "https://ship-it-fri1.onrender.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ship-it": {
      "url": "https://ship-it-fri1.onrender.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

## OpenCode

The OpenCode plugin is **deprecated**: it no longer receives updates, and
everything new lands in the MCP server. It still works, and it is still the
shortest way to connect OpenCode itself:

```bash
npx opencode-shipit-runtime login
```

That opens the authorize page, stores an access token for you and adds the
plugin to your OpenCode config. Restart OpenCode afterwards so the tools
register.

## Revoking access

Every authorization is a key on your account, visible in **Settings →
Connected apps**. Revoking one cuts it off immediately.
