import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";
import {
  resolveEffectiveEnv,
  isManagedKey,
  overridesMap,
  loadEnvOverrides,
} from "../src/services/runtime-env.js";

/**
 * DB-managed configuration: which column wins, which keys are manageable,
 * and the boot pull that copies the active column into process.env.
 */

describe("effective environment", () => {
  it("follows the runtime mode when automatic", () => {
    expect(resolveEffectiveEnv("production", "auto")).toBe("production");
    expect(resolveEffectiveEnv("development", "auto")).toBe("development");
    expect(resolveEffectiveEnv("development", undefined)).toBe("development");
  });

  it("honours an explicit pin", () => {
    expect(resolveEffectiveEnv("production", "development")).toBe("development");
    expect(resolveEffectiveEnv("development", "production")).toBe("production");
  });

  it("treats garbage as automatic", () => {
    expect(resolveEffectiveEnv("production", "staging")).toBe("production");
    expect(resolveEffectiveEnv("development", 42)).toBe("development");
  });
});

describe("managed keys", () => {
  it("admits curated keys and refuses boot identity", () => {
    expect(isManagedKey("WHOP_LIVE_API_KEY")).toBe(true);
    expect(isManagedKey("GITHUB_TOKEN")).toBe(true);
    expect(isManagedKey("DATABASE_URL")).toBe(false);
    expect(isManagedKey("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
    expect(isManagedKey("NODE_ENV")).toBe(false);
    expect(isManagedKey("EVIL_KEY")).toBe(false);
  });
});

describe("override rows", () => {
  const rows = [
    { key: "GITHUB_TOKEN", environment: "development", value: "dev-token" },
    { key: "GITHUB_TOKEN", environment: "production", value: "prod-token" },
    { key: "DATABASE_URL", environment: "production", value: "must-never-apply" },
  ];

  it("picks the active column only", () => {
    expect(overridesMap(rows, "development")).toEqual({ GITHUB_TOKEN: "dev-token" });
    expect(overridesMap(rows, "production")).toEqual({ GITHUB_TOKEN: "prod-token" });
  });
});

describe("boot pull", () => {
  let client: SqliteClient;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-runtime-env-"));
    client = new SqliteClient({
      file: ":memory:",
      storageRoot: path.join(dir, "storage"),
      publicBaseUrl: "http://127.0.0.1:3000",
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies the active column into the target", async () => {
    await client.from("env_overrides").insert([
      { key: "GITHUB_TOKEN", environment: "development", value: "dev-token" },
      { key: "GITHUB_TOKEN", environment: "production", value: "prod-token" },
    ]);

    const target: Record<string, string | undefined> = {};
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const applied = await loadEnvOverrides(client, target);
      expect(applied).toEqual(["GITHUB_TOKEN"]);
      expect(target.GITHUB_TOKEN).toBe("dev-token");
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it("leaves the target alone when the table is empty", async () => {
    const target: Record<string, string | undefined> = { GITHUB_TOKEN: "shell" };
    const applied = await loadEnvOverrides(client, target);
    expect(applied).toEqual([]);
    expect(target.GITHUB_TOKEN).toBe("shell");
  });
});
