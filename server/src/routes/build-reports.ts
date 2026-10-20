import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { updateBuildStatus, getBuild, githubToken } from "../services/build-service.js";
import { deliverBundle } from "../services/bundle-delivery.js";
import type { FinalizeOutcome } from "../services/upload-finalize.js";
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

export async function buildReportRoutes(app: FastifyInstance): Promise<void> {
  // Receives a workflow-built runtime bundle: the self-contained app +
  // toolchain the sandbox executes instead of raw source. Authenticated by the
  // same shared token as the report endpoint, since the caller is the same
  // workflow. The stream is never buffered: a live runtime's host receives it
  // directly, otherwise it is drained and the CI artifact stays the only
  // copy (see bundle-delivery.ts). The file part is consumed INSIDE the parts
  // loop (delivery starts the moment it arrives): stashing the stream and
  // consuming it after the loop hangs forever, because busboy only finishes
  // the multipart body while the file flows. Text fields must precede the
  // file part — the stream is consumed in arrival order.
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

    let delivery: Promise<FinalizeOutcome> | null = null;
    let githubRepo: string | undefined;
    let githubRunId: string | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file" && part.fieldname === "file" && !delivery) {
          delivery = deliverBundle({ buildId: id, file: part.file, githubRepo, githubRunId });
        } else if (part.type === "field") {
          if (part.fieldname === "github_repo" && !githubRepo) githubRepo = String(part.value).slice(0, 200);
          if (part.fieldname === "github_run_id" && !githubRunId) githubRunId = String(part.value).slice(0, 40);
        } else if (part.type === "file") {
          // A smuggled second archive under another field name: discard.
          for await (const _chunk of part.file) { /* drain */ }
        }
      }
    } catch (err) {
      logger.error({ err, buildId: id }, "Bundle upload parse failed");
      if (!delivery) {
        return reply.status(400).send({
          error: { code: "INVALID_UPLOAD", message: "Could not read the bundle upload" },
        });
      }
      // The file was already streaming into delivery when the body broke;
      // fall through and report delivery's outcome instead of sending twice.
    }

    if (!delivery) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "file is required" },
      });
    }

    // The live-or-artifact tail lives in the shared delivery service so the
    // behavior is identical however the bytes arrive. The sent-guard is the
    // backstop against double replies on aborted connections: a second send
    // crashes the process (ERR_HTTP_HEADERS_SENT) and takes every in-flight
    // request down with it.
    try {
      const outcome = await delivery;
      return reply.status(outcome.status).send(outcome.body);
    } catch (err) {
      logger.warn({ err, buildId: id }, "Bundle delivery failed after parse");
      if (!reply.sent) {
        return reply.status(502).send({
          error: { code: "STORE_FAILED", message: "Bundle delivery failed" },
        });
      }
      return;
    }
  });

  // Streams a CI-built runtime bundle straight from the GitHub Actions artifact
  // to whoever holds the build id — the sandbox agent at start time. Nothing is
  // stored: the bytes flow from GitHub through this process to the caller, so a
  // project whose host ships no toolchain can still run a self-contained bundle.
  app.get("/builds/:id/bundle", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { data: row, error } = await supabase
      .from("artifacts")
      .select("url")
      .eq("build_id", id)
      .eq("name", "bundle.zip")
      .single();
    if (error || !row?.url) {
      return reply.status(404).send({
        error: { code: "BUNDLE_NOT_FOUND", message: "Bundle artifact not found" },
      });
    }

    const match = row.url.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/
    );
    if (!match) {
      return reply.status(400).send({
        error: { code: "INVALID_BUNDLE_URL", message: "Bundle artifact is not a GitHub run URL" },
      });
    }
    const [, repo, runId] = match;

    let artifacts: {
      archive_download_url: string;
      name: string;
      expired?: boolean;
    }[];
    try {
      const gh = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`,
        {
          headers: {
            Authorization: `Bearer ${githubToken()}`,
            Accept: "application/vnd.github+json",
          },
        }
      );
      if (!gh.ok) {
        logger.error({ buildId: id, status: gh.status }, "GitHub artifact list failed");
        return reply.status(502).send({
          error: { code: "GITHUB_ARTIFACT_FAILED", message: "Could not list GitHub artifacts" },
        });
      }
      const body = (await gh.json()) as {
        artifacts?: { name: string; archive_download_url: string; expired?: boolean }[];
      };
      const all = body.artifacts ?? [];
      // The exact name is the normal case. A run can hold more than one
      // bundle-shaped artifact (a rebuild leaves the old one behind), so the
      // fallback is "any bundle artifact", not "the first one we saw".
      const exact = all.filter((a) => a.name === `bundle-${id}.zip`);
      artifacts = exact.length > 0 ? exact : all.filter((a) => a.name.startsWith("bundle-"));
      if (exact.length === 0 && artifacts.length > 0) {
        logger.warn(
          { buildId: id, found: artifacts.map((a) => a.name) },
          "Bundle artifact name did not match the build id; using the run's bundle artifact"
        );
      }
    } catch (err) {
      logger.error({ err, buildId: id }, "GitHub artifact list failed");
      return reply.status(502).send({
        error: { code: "GITHUB_ARTIFACT_FAILED", message: "Could not list GitHub artifacts" },
      });
    }

    const artifact = artifacts[0];
    if (!artifact) {
      return reply.status(404).send({
        error: { code: "BUNDLE_NOT_FOUND", message: "Bundle artifact not found in GitHub Actions" },
      });
    }

    // GitHub keeps expired artifacts in the listing but their download URL
    // answers 404. Saying so plainly beats a bare "not found": the fix is to
    // rebuild, and the agent has to be able to read that.
    if (artifact.expired) {
      logger.warn({ buildId: id, artifact: artifact.name }, "Bundle artifact has expired");
      return reply.status(410).send({
        error: {
          code: "BUNDLE_EXPIRED",
          message:
            "This build's bundle has expired (GitHub keeps artifacts for seven days). Rebuild the project to run it.",
        },
      });
    }

    // Stream straight through: the sandbox agent fetches this URL and verifies
    // the sha256 on arrival, so nothing is buffered here.
    const zip = await fetch(artifact.archive_download_url, {
      headers: { Authorization: `Bearer ${githubToken()}` },
    });
    if (!zip.ok) {
      logger.error({ buildId: id, status: zip.status }, "GitHub artifact download failed");
      return reply.status(502).send({
        error: { code: "GITHUB_ARTIFACT_FAILED", message: "Could not download bundle artifact" },
      });
    }

    reply.header("content-type", "application/zip");
    return reply.send(zip.body as unknown as NodeJS.ReadableStream);
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