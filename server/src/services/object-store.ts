import fs from "node:fs";
import path from "node:path";
import { usingSqlite } from "../db/index.js";

/**
 * Object-storage operations the typed `Database` union does not expose.
 *
 * The Supabase client has `copy` but node:sqlite's local driver does not, so
 * calling `.copy()` on the union would not typecheck — and widening the local
 * driver just to satisfy one caller would drag storage semantics into the dev
 * backend. These helpers branch explicitly instead: REST for Supabase (the
 * same endpoints storage-js itself uses), plain fs for local development.
 *
 * Used by the edge-ingest finalize path, where the bytes already sit in a
 * staging object and only need a server-side move to their final key.
 */

function restBase(): string {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return `${url}/storage/v1`;
}

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return key;
}

function restHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceKey()}`,
    apikey: serviceKey(),
  };
}

/** Moves a staged object to its final key without downloading it. */
export async function copyStagedObject(
  bucket: string,
  fromKey: string,
  toKey: string
): Promise<void> {
  if (usingSqlite) {
    const root = process.env.LOCAL_STORAGE_ROOT || "./.data/storage";
    const src = path.join(root, bucket, fromKey);
    const dst = path.join(root, bucket, toKey);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  const res = await fetch(`${restBase()}/object/copy`, {
    method: "POST",
    headers: restHeaders(),
    body: JSON.stringify({ bucketId: bucket, sourceKey: fromKey, destinationKey: toKey }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`storage copy failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Streams an upload straight into object storage without buffering it in
 * Node's heap. Upserts: bundles reuse one key per build id so a re-delivery
 * replaces the object instead of piling up copies. */
export async function uploadObjectStream(
  bucket: string,
  key: string,
  body: ReadableStream<Uint8Array>,
  contentType: string
): Promise<void> {
  if (usingSqlite) {
    const root = process.env.LOCAL_STORAGE_ROOT || "./.data/storage";
    const dst = path.join(root, bucket, key);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const out = fs.createWriteStream(dst);
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
    );
    return;
  }
  const res = await fetch(
    `${restBase()}/object/${encodeURIComponent(bucket)}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey()}`,
        apikey: serviceKey(),
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body,
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`storage upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Best-effort removal of staging objects (abandoned uploads, post-copy cleanup). */
export async function deleteStagedObjects(bucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (usingSqlite) {
    const root = process.env.LOCAL_STORAGE_ROOT || "./.data/storage";
    for (const key of keys) {
      const target = path.join(root, bucket, key);
      if (fs.existsSync(target)) fs.rmSync(target);
    }
    return;
  }
  const res = await fetch(`${restBase()}/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    headers: restHeaders(),
    body: JSON.stringify({ prefixes: keys }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`storage delete failed (${res.status}): ${text.slice(0, 200)}`);
  }
}
