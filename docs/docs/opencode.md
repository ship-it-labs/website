---
id: opencode
title: OpenCode (deprecated)
sidebar_position: 3
---

The OpenCode plugin is **deprecated**. It still works, and it will keep
working, but it no longer receives updates: every new capability lands in the
[MCP server](/docs/mcp), which every other client uses.

## Connecting OpenCode

One command:

```bash
npx opencode-shipit-runtime login
```

It starts a temporary server on your own machine, opens the Ship-It
authorize page, and on approval exchanges a one-time code plus a PKCE proof
for an access token. The token is stored next to your OpenCode config, with
owner-only permissions. Restart OpenCode afterwards so the tools register.

## What it can still do

| Group | Tools |
| --- | --- |
| auth | `shipit_login` |
| project | `project_upload` |
| build | `build_submit`, `build_status`, `build_logs`, `build_list` |
| runtime | `runtime_start`, `runtime_stop`, `runtime_restart`, `runtime_status`, `runtime_list`, `runtime_logs`, `runtime_info`, `runtime_health`, `runtime_exec` |
| fs | `list`, `read`, `write`, `delete`, `move`, `copy`, `mkdir`, `stat`, `exists`, `chmod`, `symlink` |
| network | `list`, `expose`, `close` |
| usage | `usage_quota`, `runtime_monitoring` |
| artifact | `artifact_list`, `artifact_verify` |

## Moving to MCP

The MCP server covers the same ground — projects, builds, runtimes, usage —
through the `tools/call` protocol, and it is the only surface that will
change from now on. If you are starting fresh, connect your client to
`/mcp` instead.

## Revoking access

The plugin's token is a key on your account, like any other: **Settings →
Connected apps**.
