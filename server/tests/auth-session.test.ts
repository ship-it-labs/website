import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";

let client: SqliteClient;
let storageRoot: string;

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-auth-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot,
    publicBaseUrl: "http://127.0.0.1:3000",
  });
});

afterEach(() => {
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe("local auth sessions", () => {
  // The routes read the session out of `data`, which is where Supabase puts it.
  // Returning it alongside `data` instead produced a login response with no
  // token, so the dashboard sent unauthenticated requests and every refresh
  // bounced back to the login screen.
  it("returns the session inside data on signup", async () => {
    const result = await client.auth.signUp({ email: "a@example.test", password: "hunter2hunter2" });

    expect(result.error).toBeNull();
    expect(result.data?.user?.id).toBeTruthy();
    expect(result.data?.session?.access_token).toBeTruthy();
  });

  it("returns the session inside data on sign in", async () => {
    await client.auth.signUp({ email: "b@example.test", password: "hunter2hunter2" });

    const result = await client.auth.signInWithPassword({
      email: "b@example.test",
      password: "hunter2hunter2",
    });

    expect(result.error).toBeNull();
    expect(result.data?.session?.access_token).toBeTruthy();
  });

  it("issues a token that resolves back to the same user", async () => {
    const signup = await client.auth.signUp({ email: "c@example.test", password: "hunter2hunter2" });
    const token = signup.data?.session?.access_token as string;
    const userId = signup.data?.user?.id as string;

    expect(client.getUserIdForToken(token)).toBe(userId);
  });

  it("rejects the wrong password without issuing a token", async () => {
    await client.auth.signUp({ email: "d@example.test", password: "hunter2hunter2" });

    const result = await client.auth.signInWithPassword({
      email: "d@example.test",
      password: "wrongpassword",
    });

    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
  });

  it("does not resolve an unknown token", () => {
    expect(client.getUserIdForToken("not-a-real-token")).toBeNull();
  });
});
