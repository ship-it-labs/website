import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { updateBuildStatus, getBuild } from "../services/build-service.js";
import { logger } from "../utils/logger.js";

/**
 * Builds that run in GitHub Actions report back through here.
 *
 * A workflow dispatch returns 204 with an empty body, so the control plane
 * never learns which run belongs to a build and cannot poll for logs itself.
 * Without this endpoint those builds sit at "running" forever and their output
 * is only readable on github.com.
 */

/** Chosen so a full build log arrives in one request without a streaming body. */
const MAX_LOG_LINES = 2000;
const MAX_LOG_BYTES = 256 * 1024;

const reportSchema = z.object({
  status: z.enum(["success", "failure", "timeout"]),
  exit_code: z.number().int().optional(),
  workflow_run_id: z.string().min(1).optional(),
  logs: z
    .array(
      z.object({
        stream: z.enum(["stdout", "stderr", "system"]),
        content: z.string(),
      })
    )
    .max(MAX_LOG_LINES)
    .default([]),
});

/**
 * Constant-time comparison of the shared secret the workflow authenticates with.
 * Returns false rather than throwing so the caller gets one uniform 401.
 */
export function secretMatches(provided: string, expected: string): boolean {
  if (!expected) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, and the length of a wrong
  // secret is not worth protecting.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

function secretFromHeader(req: FastifyRequest): string {
  const header = req.headers["x-build-report-token"];
  if (typeof header === "string") return header;
  if (Array.isArray(header)) return header[0] ?? "";
  return "";
}

/**
 * Caps the log by bytes as well as lines. A single very long line, or a few
 * hundred long ones, would otherwise make the insert fail on payload size and
 * lose the status update along with the output.
 */
export function capLogs(
  logs: Array<{ stream: "stdout" | "stderr" | "system"; content: string }>
): Array<{ stream: "stdout" | "stderr" | "system"; content: string }> {
  const kept: Array<{ stream: "stdout" | "stderr" | "system"; content: string }> = [];
  let bytes = 0;
  let truncated = false;

  for (const line of logs) {
    const size = Buffer.byteLength(line.content, "utf8") + 32;
    if (bytes + size > MAX_LOG_BYTES) {
      truncated = true;
      break;
    }
    kept.push(line);
    bytes += size;
  }

  if (truncated) {
    kept.push({
      stream: "system",
      content: `[log truncated at ${MAX_LOG_BYTES} bytes]`,
    });
  }

  return kept;
}

export async function buildReportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/builds/:id/report", async (req, reply) => {
    const expected = process.env.BUILD_REPORT_TOKEN ?? "";
    if (!secretMatches(secretFromHeader(req), expected)) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid build report token" },
      });
    }

    const { id } = req.params as { id: string };
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REPORT", message: parsed.error.issues[0]?.message ?? "Invalid report" },
      });
    }

    const build = await getBuild(id);
    if (!build) {
      return reply
        .status(404)
        .send({ error: { code: "BUILD_NOT_FOUND", message: "Build not found" } });
    }

    const { status, exit_code, workflow_run_id, logs } = parsed.data;

    // Replace rather than append: a retried report would otherwise duplicate
    // every line, and a report arriving after the runtime executor already
    // finished must not resurrect logs that no longer match the build.
    await supabase.from("build_logs").delete().eq("build_id", id);

    const capped = capLogs(logs);
    if (capped.length > 0) {
      const createdAt = new Date().toISOString();
      const rows = capped.map((line, index) => ({
        build_id: id,
        stream: line.stream,
        content: line.content,
        // Ordering is what the log view sorts on, so lines need distinct
        // increasing stamps or they come back in an arbitrary sequence.
        created_at: new Date(Date.parse(createdAt) + index).toISOString(),
      }));

      const { error } = await supabase.from("build_logs").insert(rows);
      if (error) {
        logger.error({ error, buildId: id }, "Failed to store reported build logs");
      }
    }

    await updateBuildStatus(id, status, exit_code);

    if (workflow_run_id) {
      const { error } = await supabase
        .from("builds")
        .update({ workflow_run_id })
        .eq("id", id);
      if (error) {
        logger.error({ error, buildId: id }, "Failed to record workflow run id");
      }
    }

    logger.info({ buildId: id, status, lines: capped.length }, "Recorded build report");

    return reply.send({ ok: true });
  });
}