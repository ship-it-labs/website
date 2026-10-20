---
id: intro
title: What Ship-It is
sidebar_position: 1
slug: /
---

Ship-It turns a folder of source into a running app, and it does it from
inside your AI assistant. You tell the agent what you want; the agent uploads
the project, submits a build, reads the logs, fixes what broke, and starts a
runtime with a public URL.

There is no pipeline configuration to write. The agent decides the install,
build and test commands, and the platform enforces the rules.

## How the pieces fit

| Piece | What it does |
| --- | --- |
| **Your client** | Claude, Codex, Cursor, VS Code, Windsurf — anything that speaks MCP. The OpenCode plugin still works too. |
| **The control plane** | This site. It stores your projects, dispatches builds, decides which agent runs what, and enforces your plan. |
| **GitHub Actions** | Where builds run. The workflow is shipped with the platform; you never write it. |
| **The server agent** | The host that runs your app inside a sandbox: no interpreter of its own, a bundle with everything your app needs. |

## The three things you will do

1. **Upload a project.** A zip of your source, or a git repository.
2. **Build it.** The agent submits the job; you watch the logs.
3. **Run it.** A runtime with a public URL, capped by your plan.

Every one of those is a tool on the MCP server, and every one of them is
authorised against your account on the server — never in the client.

## Where to go next

- [Connect your assistant](/docs/connect) — one URL, one snippet, per client.
- [The MCP server](/docs/mcp) — the tools, the login flow and the manual as resources.
- [How a build works](/docs/builds) and [how a runtime works](/docs/runtimes).
