---
id: projects
title: Projects
sidebar_position: 1
---

A project is a folder of source the platform can build and run.

## Uploading

Your agent uploads a zip of the project. Two things are excluded from every
upload, because they are large and never needed:

- `node_modules`, `vendor`, `.venv`, `target` and their siblings;
- build output (`dist`, `build`, `out`, `.next`).

Dependencies are not missing, though — the build installs them, and the
resulting **bundle** carries them to the runtime.

Re-uploading the same project id updates it in place. A slug that belongs to
another account resolves to a distinct, stable id for your account, so two
people can both have a project called `mini-app` without stepping on each
other.

## What a project records

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. The agent reuses it for every later call. |
| `name` | Display name. |
| `language` | Detected from the sources, or declared. |
| `run_command` | The command that starts the app inside the sandbox. |
| `env` | Encrypted environment variables. Never logged. |

## The run command

The sandbox has no toolchain of its own, so the run command has to work with
the bundle's interpreter. Typical values:

| Language | Run command |
| --- | --- |
| node | `node dist/server.js` |
| python | `python app.py` |
| go | `./app` (a static binary) |
| rust | `./target/release/app` |

If the app starts on its own, leave it empty and the bundle's entry manifest
decides.

## Environment variables

Variables are encrypted at rest with a per-project key and are decrypted only
for the signed start call. They are never written to a build log, never sent
to a runner you did not start, and never returned by an API call.
