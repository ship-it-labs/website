---
id: runtimes
title: Runtimes
sidebar_position: 3
---

A runtime is your app, running inside a sandbox, with a public URL.

## Starting one

`start_runtime` takes a project id and the build to run:

```
start_runtime(project_id="mini-app", build_id="latest")
```

`"latest"` runs the newest successful build's bundle. A build id runs that
exact build, which is the honest choice when you are comparing two builds.

## What runs where

The agent host has **no language runtimes of its own**. A runtime only works
because the bundle carries everything it needs: the pinned interpreter, the
dependencies, and the built app. The sandbox then:

- reads the system directories and nothing else — no host secrets, no other
  tenants' sandboxes;
- may only write inside its own directory;
- may only bind its own port, and may only reach the outbound ports an app
  legitimately needs.

The process is confined by the kernel (Landlock on Linux) and dropped the
moment it exits or its lease ends.

## The lease

A runtime lives for the shortest of:

- your plan's session limit;
- the three-hour hard cap;
- the time you have left in the month.

When the lease expires the sandbox is destroyed along with its filesystem.
Nothing outlives its session.

## Talking to it

| Tool | What it does |
| --- | --- |
| `list_runtimes` | The runtimes on your account. |
| `get_runtime` | One runtime: status, public address, host. |
| `runtime_logs` | The recent output. |
| `exec_in_runtime` | Run a command inside the sandbox and read the output. |
| `stop_runtime` | Stop it now. |

## Errors worth knowing

| Message | What it means |
| --- | --- |
| `START_FAILED` | The app was started and died. The reason is in the message — usually the log tail from the sandbox. |
| `CAPACITY_EXHAUSTED` | Every instance was busy. Transient; try again. |
| `SOURCE_EXPIRED` | The project archive was deleted after inactivity. Re-upload it. |
| `RUNTIME_QUOTA_EXCEEDED` | The month's allowance is used up. |
