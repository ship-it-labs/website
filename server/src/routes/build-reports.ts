import { timingSafeEqual } from "node:crypto";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { updateBuildStatus, getBuild, recordBundleArtifact } from "../services/build-service.js";
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
 *
 * Keeps the tail rather than the head: build errors live at the end of the
 * log, so dropping the earliest lines is what lets a large failed log still
 * show its diagnosis. The viewer renders lines in order, so the oldest
 * lines become the truncation notice.
 */
export function capLogs(
  logs: Array<{ stream: "stdout" | "stderr" | "system"; content: string }>
): Array<{ stream: "stdout" | "stderr" | "system"; content: string }> {
  const kept: Array<{ stream: "stdout" | "stderr" | "system"; content: string }> = [];
  let bytes = 0;
  let truncated = false;

  // Walk backwards so we keep the tail and drop the head when trimming.
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    const size = Buffer.byteLength(line.content, "utf8") + 32;
    if (bytes + size > MAX_LOG_BYTES) {
      truncated = true;
      break;
    }
    kept.unshift(line);
    bytes += size;
  }

  if (truncated) {
    kept.unshift({
      stream: "system",
      content: `[log truncated — earliest lines dropped, showing tail at ${MAX_LOG_BYTES} bytes]`,
    });
  }

  return kept;
}

/** Largest bundle the control plane accepts. Runtimes with more footprint
 * than this do not fit the sandbox model anyway (see the 5GB per-runtime
 * watchdog on the agent); the workflow stays under it by excluding caches. */
const MAX_BUNDLE_BYTES = 300 * 1024 * 1024;
const BUNDLE_BUCKET = "project-uploads";

export async function buildReportRoutes(app: FastifyInstance): Promise<void> {
  // Receives a workflow-built runtime bundle: the self-contained app +
  // toolchain the sandbox executes instead of raw source. Authenticated by the
  // same shared token as the report endpoint, since the caller is the same
  // workflow. Replace semantics: re-uploads overwrite.
  app.post("/builds/:id/bundle", async (req, reply) => {
    const expected = process.env.BUILD_REPORT_TOKEN ?? "";
    if (!secretMatches(secretFromHeader(req), expected)) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid build report token" },
      });
    }

    const { id } = req.params as { id: string };
    const build = await getBuild(id);
    if (!build) {
      return reply
        .status(404)
        .send({ error: { code: "BUILD_NOT_FOUND", message: "Build not found" } });
    }

    let bundle: Buffer | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type !== "file" || part.fieldname !== "file") continue;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of part.file) {
          size += chunk.length;
          if (size > MAX_BUNDLE_BYTES) {
            return reply.status(413).send({
              error: { code: "BUNDLE_TOO_LARGE", message: "Bundle exceeds the 300MB limit" },
            });
          }
          chunks.push(chunk as Buffer);
        }
        bundle = Buffer.concat(chunks);
      }
    } catch (err) {
      logger.error({ err, buildId: id }, "Bundle upload parse failed");
      return reply.status(400).send({
        error: { code: "INVALID_UPLOAD", message: "Could not read the bundle upload" },
      });
    }

    if (!bundle || bundle.length === 0) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "file is required" },
      });
    }

    const sha256 = crypto.createHash("sha256").update(bundle).digest("hex");
    const storagePath = `bundles/${id}.zip`;

    const { error: uploadError } = await supabase.storage
      .from(BUNDLE_BUCKET)
      .upload(storagePath, bundle, {
        contentType: "application/zip",
        upsert: true,
      });

    if (uploadError) {
      logger.error({ err: uploadError, buildId: id }, "Bundle storage upload failed");
      return reply.status(502).send({
        error: { code: "STORAGE_UNAVAILABLE", message: "Failed to store the bundle" },
      });
    }

    try {
      await recordBundleArtifact(id, {
        sha256,
        sizeBytes: bundle.length,
        storagePath,
      });
    } catch {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to record the bundle" },
      });
    }

    logger.info({ buildId: id, bytes: bundle.length, sha256 }, "Recorded runtime bundle");
    return reply.send({ ok: true, sha256, bytes: bundle.length });
  });

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