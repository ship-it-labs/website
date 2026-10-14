import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticateApiKey } from "../middleware/auth.js";
import { secretMatches } from "./build-reports.js";
import { getBuild } from "../services/build-service.js";
import {
  finalizeBundleUpload,
  finalizeProjectUpload,
} from "../services/upload-finalize.js";
import { logger } from "../utils/logger.js";

/**
 * Container-internal finalize endpoints for the Go edge.
 *
 * The edge streams large bodies straight to object storage and then calls
 * here with small JSON: where the bytes landed, their hash and size, and the
 * caller's credential. These routes perform the identical finalize steps as
 * the public multipart routes (via the shared upload-finalize service) and
 * return a `{ status, body }` envelope the edge relays verbatim, so the wire
 * contract is byte-identical whichever path the bytes took.
 *
 * Two layers of auth, in order: the ingest secret proves the call came
 * through the edge (container-internal), and the caller's own credential is
 * then verified exactly as if it had arrived directly — the edge never
 * vouches for the user, it only moves bytes.
 */

function requireIngestSecret(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const expected = process.env.INTERNAL_INGEST_SECRET ?? "";
  const header = req.headers["x-ingest-secret"];
  const provided = typeof header === "string" ? header : "";
  if (!secretMatches(provided, expected)) {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid ingest secret" },
    });
    return;
  }
  done();
}

/** The edge carries the caller's bearer token inside the JSON body; move it
 * onto the headers so the standard API-key guard can verify it unmodified. */
function copyAuthFromBody(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  const auth = (req.body as { authorization?: unknown } | undefined)?.authorization;
  if (typeof auth === "string" && auth) {
    req.headers.authorization = auth;
  }
  done();
}

type LooseBody = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

export async function internalIngestRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/ingest/project", {
    preHandler: [requireIngestSecret, copyAuthFromBody, authenticateApiKey],
  }, async (req, reply) => {
    const b = (req.body ?? {}) as LooseBody;
    const requestedId = str(b.project_id);
    const stagingPath = str(b.staging_path);
    const sha256 = str(b.sha256);
    const bytes = num(b.bytes);

    if (!requestedId || !stagingPath || !sha256 || !Number.isInteger(bytes) || bytes <= 0) {
      return reply.send({
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "project_id, staging_path, sha256 and a positive bytes are required",
          },
        },
      });
    }

    let manifest: { files: string[]; total_bytes: number; excluded: string[] } | null = null;
    const manifestRaw = str(b.manifest);
    if (manifestRaw) {
      try {
        manifest = JSON.parse(manifestRaw) as typeof manifest;
      } catch {
        return reply.send({
          status: 400,
          body: { error: { code: "VALIDATION_ERROR", message: "manifest must be valid JSON" } },
        });
      }
    }

    const outcome = await finalizeProjectUpload({
      userId: req.auth!.userId,
      requestedId,
      projectName: str(b.project_name) || null,
      runCommand: str(b.run_command) || null,
      declaredLanguage: str(b.language) || null,
      envRaw: typeof b.env === "string" ? b.env : null,
      manifest,
      filename: str(b.filename) || null,
      store: { kind: "staging", path: stagingPath, sha256, bytes },
    });
    return reply.send({ status: outcome.status, body: outcome.body });
  });

  // Bundles authenticate with the shared CI token, not a user key, so there
  // is no authenticateApiKey here — the token check below mirrors the public
  // bundle route exactly.
  app.post("/internal/ingest/bundle", {
    preHandler: [requireIngestSecret],
  }, async (req, reply) => {
    const b = (req.body ?? {}) as LooseBody;
    const expected = process.env.BUILD_REPORT_TOKEN ?? "";
    if (!secretMatches(str(b.build_token), expected)) {
      return reply.send({
        status: 401,
        body: { error: { code: "UNAUTHORIZED", message: "Invalid build report token" } },
      });
    }

    const buildId = str(b.build_id);
    const stagingPath = str(b.staging_path);
    const sha256 = str(b.sha256);
    const bytes = num(b.bytes);

    if (!buildId || !stagingPath || !sha256 || !Number.isInteger(bytes) || bytes <= 0) {
      return reply.send({
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "build_id, staging_path, sha256 and a positive bytes are required",
          },
        },
      });
    }

    const build = await getBuild(buildId);
    if (!build) {
      logger.warn({ buildId }, "Edge staged a bundle for an unknown build");
      return reply.send({
        status: 404,
        body: { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
      });
    }

    const outcome = await finalizeBundleUpload({
      buildId,
      store: { kind: "staging", path: stagingPath, sha256, bytes },
    });
    return reply.send({ status: outcome.status, body: outcome.body });
  });
}
