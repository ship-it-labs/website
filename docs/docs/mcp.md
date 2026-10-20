---
id: mcp
title: The MCP server
sidebar_position: 2
---

The server is one URL: `POST /mcp`. It speaks JSON-RPC 2.0, the transport
MCP clients use, and it is served by the same process that serves the site.

## What a client can do

| Group | Tools |
| --- | --- |
| auth | `login` |
| projects | `list_projects`, `upload_project` |
| builds | `submit_build`, `list_builds`, `get_build`, `get_build_logs` |
| runtimes | `start_runtime`, `list_runtimes`, `get_runtime`, `stop_runtime`, `runtime_logs`, `exec_in_runtime` |
| account | `get_usage`, `get_account` |
| docs | `search_docs` |

Every tool is a thin adapter over the same REST API the dashboard uses, and
it runs with the caller's own credential. There is no privileged path for AI
clients: the same plan limits, the same quota, the same rules.

## The login flow

The MCP server is a website endpoint, so your browser cannot call back to a
port on your machine the way a local CLI does. The login uses a
platform-hosted callback instead:

1. The agent calls `login` with no arguments and gets back an
   `authorize_url` and a `session_id`.
2. You open the URL, sign in if you are not already, and approve.
3. The agent calls `login` again with the `session_id` and gets the access
   token.

The authorization code is redeemed by the server, and the PKCE proof never
leaves it. The session is short-lived (ten minutes) and single-use.

## Starting a runtime

`start_runtime` takes a `build_id`:

- a build id such as `build_ab12cd34` runs **that exact build's** bundle;
- `"latest"` runs the newest successful build's bundle.

Being explicit matters: the bundle is the built app plus its toolchain, and
"run whatever was built last" is a different promise from "run this build".

## The manual as resources

The documentation is not only a website. The same text is served as MCP
resources, one per section:

```
shipit://docs/overview
shipit://docs/projects
shipit://docs/builds
...
```

List them with `resources/list`, read one with `resources/read`, and pull the
whole manual as a prompt with `prompts/get` and the name `shipit-guide`.

## The REST API underneath

Everything the MCP server does is available over plain HTTP as well, with the
same bearer token. See [the API reference](/docs/api).
