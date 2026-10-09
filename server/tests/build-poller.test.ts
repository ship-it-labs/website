import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";
import { pollRuntimeBuilds } from "../src/services/runtime-build.js";

/**
 * A GitHub-executor build whose Report step never lands must not say
 * "running" forever. The poller marks builds past their own timeout_seconds
 * as timed out, with a log line that says where the result went missing.
 * Runs against a throwaway database rather than the real one.
 */

let client: SqliteClient;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-poller-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot: path.join(dir, "storage"),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seedBuild(id: string, startedAt: string | null, timeoutSeconds: number) {
  await client.from("users").insert({
    id: "u1",
    email: "dev@example.test",
    plan_id: "free",
  });
  await client.from("projects").insert({
    id: "p1",
    user_id: "u1",
    name: "demo",
  });
  const { error } = await client.from("builds").insert({
    id,
    user_id: "u1",
    project_id: "p1",
    status: "running",
    install_commands: [],
    build_commands: [],
    test_commands: [],
    timeout_seconds: timeoutSeconds,
    started_at: startedAt,
  });
  expect(error).toBeNull();
}

async function buildStatus(id: string): Promise<string | null> {
  const { data } = await client.from("builds").select("status").eq("id", id).single();
  return (data as { status: string } | null)?.status ?? null;
}

async function buildLog(id: string): Promise<string> {
  const { data } = await client.from("build_logs").select("content").eq("build_id", id);
  return ((data ?? []) as { content: string }[]).map((r) => r.content).join("\n");
}

describe("overdue build sweeper", () => {
  it("marks a build past its timeout as timed out", async () => {
    const started = new Date(Date.now() - 10 * 60_000).toISOString();
    await seedBuild("b-old", started, 180);

    await pollRuntimeBuilds(client as never);

    expect(await buildStatus("b-old")).toBe("timeout");
    expect(await buildLog("b-old")).toContain("Report step");
  });

  it("leaves a fresh build alone", async () => {
    const started = new Date().toISOString();
    await seedBuild("b-fresh", started, 3600);

    await pollRuntimeBuilds(client as never);

    // Untouched by the sweeper: still running (the orchestrator poll for
    // runtime-executor builds may fail without an orchestrator, but the row
    // must not flip to timeout or failure).
    expect(await buildStatus("b-fresh")).toBe("running");
  });
});
