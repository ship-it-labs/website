import { createHash } from "node:crypto";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";

/**
 * Two-tier response cache for the assistant.
 *
 * L1 is an in-process LRU with a TTL: the hottest answers never touch the
 * database. L2 is the shared `agent_cache` table, so a second instance (or the
 * same one after a deploy) still skips the model call. Both are best-effort:
 * every database failure falls through to a live model call rather than
 * surfacing, because a broken cache must never break an answer.
 *
 * Single-flight sits on top: concurrent callers asking the same question share
 * one fill instead of all racing the model. The key is a SHA-256 over the
 * normalised inputs, so whitespace and casing differences hit the same entry.
 */

const MAX_ENTRIES = Number(process.env.AGENT_CACHE_MAX_ENTRIES || 500);
const DEFAULT_TTL_MS = Number(process.env.AGENT_CACHE_TTL_MS || 30 * 60_000);

interface Entry {
  value: string;
  model: string;
  expiresAt: number;
}

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<{ value: string; hit: boolean }>>();

/** Collapses whitespace and lowercases, so trivial differences share a key. */
export function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function hashKey(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function rememberInMemory(key: string, entry: Entry): void {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function readMemory(key: string): Entry | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  // Re-insert to mark it as most recently used.
  memory.delete(key);
  memory.set(key, entry);
  return entry;
}

async function readDatabase(key: string): Promise<Entry | null> {
  try {
    const { data, error } = await supabase
      .from("agent_cache")
      .select("response, model, expires_at")
      .eq("cache_key", key)
      .maybeSingle();

    if (error || !data) return null;
    const expiresAt = Date.parse(String(data.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { value: String(data.response), model: String(data.model), expiresAt };
  } catch (err) {
    logger.warn({ err }, "agent_cache read failed");
    return null;
  }
}

async function writeDatabase(
  key: string,
  entry: Entry,
  scope: string
): Promise<void> {
  try {
    const { error } = await supabase.from("agent_cache").upsert(
      {
        cache_key: key,
        scope,
        model: entry.model,
        response: entry.value,
        created_at: new Date().toISOString(),
        expires_at: new Date(entry.expiresAt).toISOString(),
      },
      { onConflict: "cache_key" }
    );
    if (error) logger.warn({ err: error }, "agent_cache write failed");
  } catch (err) {
    logger.warn({ err }, "agent_cache write failed");
  }
}

/** Best-effort sweep of expired rows; never awaited on the request path. */
function pruneDatabaseExpired(): void {
  void (async () => {
    try {
      await supabase
        .from("agent_cache")
        .delete()
        .lt("expires_at", new Date().toISOString());
    } catch {
      // Losing a prune only costs disk, never correctness.
    }
  })();
}

/**
 * Returns the cached answer, promoting a database hit into L1. `null` means a
 * miss and the caller must fill.
 */
export async function getCached(key: string): Promise<{ value: string; model: string } | null> {
  const local = readMemory(key);
  if (local) return { value: local.value, model: local.model };

  const fromDb = await readDatabase(key);
  if (!fromDb) return null;
  rememberInMemory(key, fromDb);
  return { value: fromDb.value, model: fromDb.model };
}

export async function setCached(
  key: string,
  model: string,
  response: string,
  options: { ttlMs?: number; scope?: string } = {}
): Promise<void> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const entry: Entry = { value: response, model, expiresAt: Date.now() + ttlMs };
  rememberInMemory(key, entry);
  await writeDatabase(key, entry, options.scope ?? "global");
}

/**
 * Cache-first fill with single-flight. Concurrent callers for the same key
 * share one `fill`. The returned `hit` is true when the value came from either
 * cache tier rather than from the model.
 */
export function getOrFill(
  key: string,
  model: string,
  fill: () => Promise<string>,
  options: { ttlMs?: number; scope?: string } = {}
): Promise<{ value: string; hit: boolean }> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<{ value: string; hit: boolean }> => {
    const cached = await getCached(key);
    if (cached) return { value: cached.value, hit: true };

    const fresh = await fill();
    await setCached(key, model, fresh, options);
    return { value: fresh, hit: false };
  })();

  inflight.set(key, task);
  const done = task.finally(() => {
    inflight.delete(key);
  });

  if (Math.random() < 0.02) pruneDatabaseExpired();
  return done;
}

/** Test hook: drops the in-process tier. */
export function clearMemoryCache(): void {
  memory.clear();
  inflight.clear();
}
