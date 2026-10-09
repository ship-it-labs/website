import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";
import { ensureDefaultPlan, defaultPlan } from "../src/services/plan-service.js";
import { isDuplicateKeyError } from "../src/utils/db-errors.js";
/**
 * A dangling tier reference (account names a plan with no row, e.g. an
 * unseeded plans table) must repair itself for known tiers and stay a loud
 * denial for anything else. Runs against a throwaway database.
 */

let client: SqliteClient;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-plans-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot: path.join(dir, "storage"),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function planIds(): Promise<string[]> {
  const { data } = await client.from("plans").select("id");
  return ((data ?? []) as { id: string }[]).map((r) => r.id).sort();
}

describe("ensureDefaultPlan", () => {
  it("inserts a missing known tier and returns it", async () => {
    const plan = await ensureDefaultPlan("free", client);
    expect(plan?.id).toBe("free");
    expect(plan?.price_cents).toBe(0);
    expect(await planIds()).toContain("free");
  });

  it("leaves existing rows (and admin edits) untouched", async () => {
    // The client seeds default tiers on boot; customize the row the way an
    // admin edit would, then prove the healer does not revert it.
    const { error } = await client
      .from("plans")
      .update({ name: "Pro (custom)", price_cents: 1 })
      .eq("id", "pro");
    expect(error).toBeNull();
    const plan = await ensureDefaultPlan("pro", client);
    expect(plan?.name).toBe("Pro (custom)");
    expect(plan?.price_cents).toBe(1);
  });

  it("returns null for unknown tiers without writing", async () => {
    expect(await ensureDefaultPlan("plus", client)).toBeNull();
    expect(await ensureDefaultPlan("", client)).toBeNull();
    expect(await planIds()).not.toContain("plus");
  });

  it("is safe under duplicate races", async () => {
    await ensureDefaultPlan("ultra", client);
    const again = await ensureDefaultPlan("ultra", client);
    expect(again?.id).toBe("ultra");
    expect((await planIds()).filter((id) => id === "ultra")).toHaveLength(1);
  });
});

describe("defaultPlan", () => {
  // In-memory fallback for when the row is missing AND unwritable (e.g. RLS
  // still forced because a migration never ran). Quotas enforced from here
  // match the seeds exactly, so auth unblocks without guessing.
  it("returns built-in tiers without touching the database", async () => {
    expect(defaultPlan("free")?.price_cents).toBe(0);
    expect(defaultPlan("pro")?.max_concurrent_runtimes).toBe(3);
    expect(defaultPlan("ultra")?.max_runtime_hours).toBe(24);
  });

  it("returns null for unknown tiers", () => {
    expect(defaultPlan("plus")).toBeNull();
    expect(defaultPlan("")).toBeNull();
    expect(defaultPlan("enterprise")).toBeNull();
  });
});

describe("isDuplicateKeyError", () => {
  it("recognizes both drivers", () => {
    expect(isDuplicateKeyError({ code: "23505", message: "x" })).toBe(true);
    expect(isDuplicateKeyError({ message: "UNIQUE constraint failed: plans.id" })).toBe(true);
    expect(isDuplicateKeyError({ message: "duplicate key value violates unique constraint" })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError({ message: "connection refused" })).toBe(false);
  });
});
