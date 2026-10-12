import { randomUUID } from "node:crypto";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";

export type ErrorSource = "api" | "client" | "process";

export interface ErrorEventInput {
  source: ErrorSource;
  /** HTTP verb for api rows; failure kind ("render", "window", "rejection") for client rows. */
  method?: string | null;
  /** Path only, never the query string: tokens have no business in the log. */
  path?: string | null;
  statusCode?: number | null;
  errorCode?: string | null;
  message: string;
  userId?: string | null;
  requestId?: string | null;
}

export interface ErrorEventRow {
  id: string;
  source: ErrorSource;
  method: string | null;
  path: string | null;
  status_code: number | null;
  error_code: string | null;
  message: string;
  user_id: string | null;
  request_id: string | null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Pure row builder, kept separate so tests pin the caps without touching the
 * database. Everything is length-capped: a single chatty client must not be
 * able to bloat the table one megabyte at a time.
 */
export function toErrorEventRow(input: ErrorEventInput): ErrorEventRow {
  const status =
    typeof input.statusCode === "number" && Number.isFinite(input.statusCode)
      ? Math.trunc(input.statusCode)
      : null;
  return {
    id: randomUUID(),
    source: input.source,
    method: input.method ? clip(input.method, 16) : null,
    path: input.path ? clip(input.path, 500) : null,
    status_code: status,
    error_code: input.errorCode ? clip(input.errorCode, 100) : null,
    message: clip(input.message.trim() || "Unknown error", 1000),
    user_id: input.userId || null,
    request_id: input.requestId ? clip(input.requestId, 64) : null,
  };
}

/** Only failures go in the log: 5xx, never 4xx (those are user errors, not ours). */
export function shouldLogStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 500 && status <= 599;
}

/**
 * Pulls the {code, message} out of an onSend payload for the log row. Payloads
 * arrive as string, Buffer, or stream; only small JSON bodies are inspected —
 * anything else (file downloads, streams, huge pages) logs without detail
 * rather than being buffered into memory.
 */
export function errorCodeFromPayload(payload: unknown): {
  code: string | null;
  message: string | null;
} {
  try {
    const text =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : null;
    if (!text || text.length > 4096) return { code: null, message: null };
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown };
    };
    const err = parsed?.error;
    if (!err || typeof err !== "object") return { code: null, message: null };
    return {
      code: typeof err.code === "string" ? err.code : null,
      message: typeof err.message === "string" ? err.message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

/**
 * Best-effort insert that never throws and never delays the caller: logging a
 * failure must not become a second failure. A missing table (migration not yet
 * applied) degrades to a warn, same as the audit writes.
 */
export function recordErrorEvent(input: ErrorEventInput): void {
  void (async () => {
    try {
      // Spread inline: the Database union only accepts object literals here,
      // not pre-typed variables (see the audit writes for the same shape).
      const { error } = await supabase.from("error_events").insert({ ...toErrorEventRow(input) });
      if (error) {
        logger.warn({ err: error }, "Error-event insert failed");
        return;
      }
      // Bounded table without a janitor job: roughly every fiftieth write
      // prunes rows older than 30 days. Probabilistic so a burst of failures
      // does one delete, not one per row.
      if (Math.random() < 0.02) {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { error: pruneError } = await supabase
          .from("error_events")
          .delete()
          .lt("created_at", cutoff);
        if (pruneError) logger.warn({ err: pruneError }, "Error-event prune failed");
      }
    } catch (err) {
      logger.warn({ err }, "Error-event insert threw");
    }
  })();
}
