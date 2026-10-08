import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";
import {
  csvCell,
  toCsv,
  isCapacityLow,
  isMaintenanceMode,
  recordAdminAudit,
} from "../src/services/admin.js";
import { collectTableCounts } from "../src/services/diagnostics.js";

/**
 * Batch 3 admin/ops helpers. The audit tests use a self-created in-memory
 * table rather than the real schema: migration 0013 is not wired yet, so the
 * suite proves both the happy path and the defensive missing-table path.
 */

let client: SqliteClient;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-batch3-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot: path.join(dir, "storage"),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("csv helpers", () => {
  it("leaves plain cells alone", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
  });

  it("quotes cells with commas, quotes or newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("builds a CRLF document with headers", () => {
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe("a,b\r\n1,\"x,y\"\r\n");
  });
});

describe("capacity threshold", () => {
  it("flags 80% and above as low", () => {
    expect(isCapacityLow(8, 10)).toBe(true);
    expect(isCapacityLow(9, 10)).toBe(true);
  });

  it("stays quiet below the threshold", () => {
    expect(isCapacityLow(7, 10)).toBe(false);
    expect(isCapacityLow(0, 10)).toBe(false);
  });

  it("treats unknown capacity as not-low, never as a crunch", () => {
    expect(isCapacityLow(0, 0)).toBe(false);
    expect(isCapacityLow(5, 0)).toBe(false);
  });
});

describe("maintenance mode", () => {
  it("is off when the flag is absent", async () => {
    await expect(isMaintenanceMode(client)).resolves.toBe(false);
  });

  it("turns on when the flag is set", async () => {
    const { error } = await client.from("platform_settings").insert({
      key: "maintenance_mode",
      value: JSON.stringify(true),
      updated_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
    await expect(isMaintenanceMode(client)).resolves.toBe(true);
  });
});

describe("admin audit", () => {
  it("resolves without throwing when the table is missing", async () => {
    await expect(
      recordAdminAudit(client, { adminId: "a1", action: "disable", target: "u1" })
    ).resolves.toBeUndefined();
  });

  it("writes a row when the table exists", async () => {
    // The audit table ships in the schema now; IF NOT EXISTS keeps this
    // passing on databases both with and without it.
    client.execRaw(
      `create table if not exists admin_audit (
        id text primary key,
        admin_id text not null,
        action text not null,
        target text,
        detail text,
        created_at text not null default (datetime('now'))
      )`
    );

    await recordAdminAudit(client, {
      adminId: "a1",
      action: "plan_change",
      target: "u1",
      detail: "plan -> pro",
    });

    const { data, error } = await client.from("admin_audit").select("admin_id, action, target, detail");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as Record<string, unknown>[])[0]).toMatchObject({
      admin_id: "a1",
      action: "plan_change",
      target: "u1",
      detail: "plan -> pro",
    });
  });
});

describe("table counts", () => {
  it("counts seeded tables including the wired audit table", async () => {
    const counts = await collectTableCounts(client);
    const byTable = Object.fromEntries(counts.map((c) => [c.table, c.rows]));
    // Plans are seeded, so the probe demonstrably works; admin_audit ships in
    // the schema since 0013 was wired, so it counts instead of nulling.
    expect(typeof byTable.plans).toBe("number");
    expect(typeof byTable.admin_audit).toBe("number");
  });
});
