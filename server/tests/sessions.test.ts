import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";
import {
  hashSessionToken,
  recordSession,
  hasSessionRow,
  revokeSessionRow,
  revokeAllSessions,
} from "../src/services/sessions.js";

/**
 * Remembered sessions back the settings device list and the middleware's
 * revocation check. The critical property: a revoked or unknown token fails
 * CLOSED (sign in again), while a database error fails OPEN (a missing table
 * must not lock out the platform). An earlier version returned true on every
 * error including "no rows", which made revocation a no-op — these tests pin
 * the distinction.
 */

let client: SqliteClient;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sessions-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot: path.join(dir, "storage"),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function addUser(id: string) {
  const { error } = await client.from("users").insert({
    id,
    email: `${id}@example.test`,
    plan_id: "free",
  });
  expect(error).toBeNull();
}

describe("session token hashing", () => {
  it("is deterministic and hex", () => {
    const hash = hashSessionToken("abc");
    expect(hash).toBe(hashSessionToken("abc"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never contains the token", () => {
    expect(hashSessionToken("my-secret-token")).not.toContain("my-secret-token");
  });
});

describe("session lifecycle", () => {
  it("records and finds a session", async () => {
    await addUser("u1");
    await recordSession({ userId: "u1", token: "tok-1" }, client);

    expect(await hasSessionRow("u1", "tok-1", client)).toBe(true);
  });

  it("reports whether the recording landed", async () => {
    await addUser("u1");
    await expect(
      recordSession({ userId: "u1", token: "tok-1" }, client)
    ).resolves.toBe(true);
  });

  it("reports failure instead of a fake success", async () => {
    // No user row: the insert fails its foreign key, exactly the production
    // shape where a login used to succeed into a session that 401d on next
    // use. The caller must see false and fail loudly.
    await expect(
      recordSession({ userId: "ghost", token: "tok-1" }, client)
    ).resolves.toBe(false);
    expect(await hasSessionRow("ghost", "tok-1", client)).toBe(false);
  });

  it("rejects an unknown token", async () => {
    await addUser("u1");

    expect(await hasSessionRow("u1", "never-recorded", client)).toBe(false);
  });

  it("rejects another user's token", async () => {
    await addUser("u1");
    await addUser("u2");
    await recordSession({ userId: "u1", token: "tok-1" }, client);

    expect(await hasSessionRow("u2", "tok-1", client)).toBe(false);
  });

  it("revocation actually ends the session", async () => {
    await addUser("u1");
    await recordSession({ userId: "u1", token: "tok-1" }, client);

    const { data } = await client
      .from("user_sessions")
      .select("id")
      .eq("user_id", "u1")
      .single();
    const row = data as { id: string };

    expect(await revokeSessionRow("u1", row.id, client)).toBe(true);
    expect(await hasSessionRow("u1", "tok-1", client)).toBe(false);
  });

  it("revoking someone else's row fails", async () => {
    await addUser("u1");
    await addUser("u2");
    await recordSession({ userId: "u1", token: "tok-1" }, client);

    const { data } = await client
      .from("user_sessions")
      .select("id")
      .eq("user_id", "u1")
      .single();
    const row = data as { id: string };

    expect(await revokeSessionRow("u2", row.id, client)).toBe(false);
    expect(await hasSessionRow("u1", "tok-1", client)).toBe(true);
  });

  it("revoke-all keeps the current session only", async () => {
    await addUser("u1");
    await recordSession({ userId: "u1", token: "tok-keep" }, client);
    await recordSession({ userId: "u1", token: "tok-drop" }, client);

    await revokeAllSessions("u1", "tok-keep", client);

    expect(await hasSessionRow("u1", "tok-keep", client)).toBe(true);
    expect(await hasSessionRow("u1", "tok-drop", client)).toBe(false);
  });
});
