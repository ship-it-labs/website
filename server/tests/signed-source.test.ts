import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteClient } from "../src/db/sqlite/client.js";

/**
 * A signed link is only useful if the server that receives it can verify it.
 * These tests check the two halves against each other rather than against a
 * fixed string, because they drifted apart silently once before: the link was
 * signed over the object path while the route verified the full path including
 * the bucket, so every download was rejected with a bad signature.
 */

const BUCKET = "project-uploads";
const OBJECT_PATH = "user-1/demo/up_abc123.zip";

let storageRoot: string;
let client: SqliteClient;

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-signed-"));
  fs.mkdirSync(path.join(storageRoot, BUCKET, "user-1", "demo"), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, BUCKET, OBJECT_PATH), "archive-bytes");

  process.env.API_KEY_HASH_SECRET = "test-hash-secret";

  client = new SqliteClient({
    file: ":memory:",
    storageRoot,
    publicBaseUrl: "https://ship-it.example",
    internalBaseUrl: "http://website:3000",
  });
});

afterEach(() => {
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

/** Mirrors the verification the local-storage route performs. */
function verify(url: URL): boolean {
  const relative = decodeURIComponent(url.pathname.replace("/local-storage/", ""));
  const expires = Number(url.searchParams.get("expires"));

  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;

  const expected = crypto
    .createHmac("sha256", process.env.API_KEY_HASH_SECRET!)
    .update(`${relative}:${expires}`)
    .digest("hex")
    .slice(0, 32);

  return url.searchParams.get("token") === expected;
}

async function sign(audience?: "public" | "internal"): Promise<URL> {
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(OBJECT_PATH, 900, audience ? { audience } : undefined);

  expect(error).toBeNull();
  return new URL(data!.signedUrl);
}

describe("signed project links", () => {
  it("produces a link the server accepts", async () => {
    expect(verify(await sign())).toBe(true);
  });

  it("produces a link the server accepts for the internal audience", async () => {
    expect(verify(await sign("internal"))).toBe(true);
  });

  it("addresses the internal audience at the private address", async () => {
    expect((await sign("internal")).host).toBe("website:3000");
  });

  it("addresses the public audience at the public address", async () => {
    expect((await sign("public")).host).toBe("ship-it.example");
  });

  it("includes the bucket in the signed path", async () => {
    const url = await sign();
    expect(url.pathname).toBe(`/local-storage/${BUCKET}/${OBJECT_PATH}`);
  });

  it("refuses to sign an object that was never uploaded", async () => {
    const { data, error } = await client.storage
      .from(BUCKET)
      .createSignedUrl("user-1/missing/up_none.zip", 900);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("rejects a link whose path was altered", async () => {
    const url = await sign();
    url.pathname = `/local-storage/${BUCKET}/user-1/other/up_abc123.zip`;

    expect(verify(url)).toBe(false);
  });

  it("rejects a link signed with a different secret", async () => {
    const url = await sign();
    const relative = decodeURIComponent(url.pathname.replace("/local-storage/", ""));
    const expires = url.searchParams.get("expires")!;

    const forged = crypto
      .createHmac("sha256", "a-different-secret")
      .update(`${relative}:${expires}`)
      .digest("hex")
      .slice(0, 32);

    url.searchParams.set("token", forged);
    expect(verify(url)).toBe(false);
  });

  it("rejects an expired link", async () => {
    const { data } = await client.storage.from(BUCKET).createSignedUrl(OBJECT_PATH, -60);
    const url = new URL(data!.signedUrl);

    expect(verify(url)).toBe(false);
  });
});
