---
id: builds
title: Builds
sidebar_position: 2
---

A build turns your source into a **bundle**: the built app plus the pinned
toolchain it needs, zipped into one artifact.

## What happens

1. The agent submits the project id and the install, build and test commands.
2. The control plane creates a build row and dispatches a GitHub Actions run.
3. The workflow downloads the project archive, verifies its checksum, runs
   your commands, and packages the result.
4. The workflow reports the result back, with the logs.
5. The bundle is delivered: to a running instance's host when there is one,
   otherwise it stays as the workflow's artifact and is streamed to the agent
   when a runtime starts.

The whole run has a hard three-minute timeout. Nothing is ever compiled on
the runtime itself.

## Reading the logs

`get_build_logs` returns the captured output. Logs are stored per build and
capped; a very long log is truncated with a marker rather than silently cut.

Builds are listed newest first, and the dashboard shows the last three with a
"load more" button for the rest.

## Artifacts

Alongside the logs, a build records its artifacts — most importantly
`bundle.zip`, the runtime bundle. Its digest is recorded, and the agent
verifies it on arrival, so a truncated or tampered download fails loudly
instead of starting a broken app.

## When a build fails

The agent reads the log, fixes the project and submits another build. The
failed build stays in the history with its logs, so you can see what happened.
