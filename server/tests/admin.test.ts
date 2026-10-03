import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";
import { BOOTSTRAP_ADMIN_EMAIL, isAdminUser } from "../src/services/admin.js";

/**
 * Admin rights come from one of three independent facts — the flag, the
 * bootstrap address, or signup order — so that no single missing migration or
 * renamed account can leave the platform unadministrable. Each path is
 * exercised against a throwaway database rather than the real one.
 */

let client: SqliteClient;
let dir: string;

beforeEach(() => {
  // :memory: rather than a temp file: Windows holds the WAL handle open and
  // deleting the directory in afterEach fails with EPERM while it does.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-admin-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot: path.join(dir, "storage"),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function addUser(id: string, email: string, createdAt: string, isAdmin = false) {
  const { error } = await client.from("users").insert({
    id,
    email,
    plan_id: "free",
    is_admin: isAdmin,
    is_active: true,
    created_at: createdAt,
  });
  expect(error).toBeNull();
}

describe("admin identity", () => {
  it("treats the first signup as admin", async () => {
    await addUser("u-first", "first@example.test", "2026-01-01T00:00:00.000Z");

    const admin = await isAdminUser(
      { id: "u-first", email: "first@example.test" },
      client
    );

    expect(admin).toBe(true);
  });

  it("does not treat a later signup as admin", async () => {
    await addUser("u-first", "first@example.test", "2026-01-01T00:00:00.000Z");
    await addUser("u-later", "later@example.test", "2026-02-01T00:00:00.000Z");

    const admin = await isAdminUser(
      { id: "u-later", email: "later@example.test" },
      client
    );

    expect(admin).toBe(false);
  });

  it("treats the bootstrap address as admin whenever it arrives", async () => {
    await addUser("u-first", "first@example.test", "2026-01-01T00:00:00.000Z");
    await addUser("u-owner", BOOTSTRAP_ADMIN_EMAIL, "2026-06-01T00:00:00.000Z");

    const admin = await isAdminUser(
      { id: "u-owner", email: BOOTSTRAP_ADMIN_EMAIL },
      client
    );

    expect(admin).toBe(true);
  });

  it("matches the bootstrap address case-insensitively", async () => {
    await addUser("u-owner", BOOTSTRAP_ADMIN_EMAIL.toUpperCase(), "2026-06-01T00:00:00.000Z");

    const admin = await isAdminUser(
      { id: "u-owner", email: BOOTSTRAP_ADMIN_EMAIL.toUpperCase() },
      client
    );

    expect(admin).toBe(true);
  });

  it("honours the admin flag regardless of order or address", async () => {
    await addUser("u-first", "first@example.test", "2026-01-01T00:00:00.000Z");
    await addUser("u-flagged", "flagged@example.test", "2026-03-01T00:00:00.000Z", true);

    const admin = await isAdminUser(
      { id: "u-flagged", email: "flagged@example.test", is_admin: true },
      client
    );

    expect(admin).toBe(true);
  });

  it("treats a lookalike address as an ordinary user", async () => {
    await addUser("u-first", "first@example.test", "2026-01-01T00:00:00.000Z");

    const admin = await isAdminUser(
      { id: "u-fake", email: `x${BOOTSTRAP_ADMIN_EMAIL}` },
      client
    );

    expect(admin).toBe(false);
  });
});
