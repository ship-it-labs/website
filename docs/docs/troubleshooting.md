---
id: troubleshooting
title: Troubleshooting
sidebar_position: 2
---

## "node: not found"

The agent host has no language runtimes of its own, so the app must be
started from a **bundle** — the build output plus its toolchain. This message
means the runtime fell back to the raw source archive.

What to check:

- Does the project have a **successful build**? `list_builds` shows it, and
  the build must have produced a bundle.
- Did you start with a `build_id` that has no bundle? Use `"latest"`, or the
  id of a successful build.
- Build artifacts live for seven days. A build older than that has no
  bundle left; rebuild it.

## "runtime exited immediately"

The app started and died. The message carries the sandbox's own output, which
is the real reason. Common causes:

- the run command points at a file the build does not produce (for example
  `node dist/server.js` when the build wrote `build/server.js`);
- the app needs a dependency the install step did not install;
- the app binds a port other than the one it was given — use the `PORT`
  environment variable.

## "Not signed in"

The MCP client called a tool without a credential. Call the `login` tool
first: it returns an authorization page, and a second call with the session
id hands over the access token.

## "CAPACITY_EXHAUSTED"

Every instance was busy at that moment. It is transient — try again in a
minute.

## "SOURCE_EXPIRED"

The project archive was deleted after a period of inactivity. Re-upload it.

## The build sits at "running"

The workflow reports back to the control plane when it finishes. If the row
never moves, the report never arrived: check that the workflow repository
still has the `BUILD_REPORT_TOKEN` secret and the `PLATFORM_API_URL` variable
set, and that they match the control plane's own values.

## A tool call says "not authorised"

The tool exists but your plan does not allow it. The assistant and other
paid features need a paid plan; runtime and build limits are in
[quotas](/docs/quotas).
