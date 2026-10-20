---
id: api
title: API reference
sidebar_position: 1
---

Everything the MCP server does is available over plain HTTP. The same bearer
token, the same rules.

```
Authorization: Bearer <your token>
```

## Projects

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/projects/upload` | Upload a project (multipart: `file`, `project_id`, `project_name`, `run_command`, `language`, `env`, `manifest`). |
| `GET` | `/api/v1/projects` | List projects. |

## Builds

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/builds` | Submit a build: `project_id`, `install_commands`, `build_commands`, `test_commands`, optional `language` and `env`. |
| `GET` | `/api/v1/builds` | List builds. Optional `status` filter. |
| `GET` | `/api/v1/builds/:id` | One build. |
| `GET` | `/api/v1/builds/:id/logs` | The build's log lines. |
| `GET` | `/api/v1/builds/:id/artifacts` | The build's artifacts. |
| `GET` | `/api/v1/builds/:id/bundle` | The runtime bundle, streamed. |
| `POST` | `/api/v1/builds/:id/rebuild` | Rebuild the same source. |

## Runtimes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/runtimes` | Start one: `project_id`, optional `build_id` (`"latest"` by default). |
| `GET` | `/api/v1/runtimes` | List runtimes. |
| `GET` | `/api/v1/runtimes/:id` | One runtime. |
| `POST` | `/api/v1/runtimes/:id/stop` | Stop it. |
| `POST` | `/api/v1/runtimes/:id/restart` | Restart it. |
| `POST` | `/api/v1/runtimes/:id/logs` | Recent output. |
| `POST` | `/api/v1/runtimes/:id/exec` | Run a command in the sandbox. |
| `GET` | `/api/v1/usage` | Usage against your plan. |

## Account

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/account` | The account and its keys. |
| `GET` | `/api/v1/account/api-keys` | List keys. |
| `POST` | `/api/v1/account/api-keys` | Mint a key. |
| `POST` | `/api/v1/account/api-keys/:id/revoke` | Revoke one. |

## Errors

Errors share one shape:

```json
{ "error": { "code": "PROJECT_NOT_FOUND", "message": "Project not found" } }
```

Branch on `code`, not on the message.

| Code | Meaning |
| --- | --- |
| `UNAUTHORIZED` | Missing or invalid credentials. |
| `KEY_EXPIRED` | The key has expired. |
| `ACCOUNT_DISABLED` | The account is disabled. |
| `PROJECT_NOT_FOUND` | No such project, or not yours. |
| `BUILD_NOT_FOUND` | No such build, or not yours. |
| `RUNTIME_NOT_FOUND` | No such runtime, or not yours. |
| `START_FAILED` | The app started and died. The message carries the reason. |
| `CAPACITY_EXHAUSTED` | Every instance was busy. |
| `RUNTIME_QUOTA_EXCEEDED` | The month's allowance is used up. |
| `SOURCE_EXPIRED` | The project archive was deleted after inactivity. |
