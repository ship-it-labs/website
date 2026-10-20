---
id: quotas
title: Quotas, plans and retention
sidebar_position: 4
---

## Plans

| Plan | Runtime hours / month | Max session | Concurrent runtimes | Price |
| --- | --- | --- | --- | --- |
| Free | 10h | 3h | 1 | $0 |
| Pro | 250h | 6h | 3 | $9 |
| Ultra | 1000h | 24h | 5 | $19 |

## What is enforced where

Quota is enforced on the server, never in the client. The maximum session
length is the smallest of the plan limit, the three-hour hard cap, and the
time left in the month: a user with thirty minutes remaining can start a
thirty minute runtime, and the agent enforces the lease independently of
whatever the client believes.

Concurrent runtimes are capped per plan as well. A start beyond the cap is
refused with `CONCURRENCY_LIMIT_REACHED` rather than queued silently.

## How long your code is kept

A project archive is deleted after a period of inactivity — a day on Free,
three days on Pro, seven days on Ultra. "Inactive" means no upload, no build
and no runtime start, so a project you are actively using is never swept out
from under you.

Deletion removes the archive, not your history: builds, their logs and their
artifacts stay. A wiped project says so when you try to start it
(`SOURCE_EXPIRED`) and asks for a re-upload.

## AI credits

The in-site assistant is a paid feature. Each paid plan gets a monthly
allowance of AI credits, with per-message input and output caps so one
conversation cannot burn a month's budget. The dashboard shows what you have
used.
