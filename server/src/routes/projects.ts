import { FastifyInstance } from "fastify";
import { authenticateApiKey, requireScope } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { finalizeProjectUpload } from "../services/upload-finalize.js";
import { paginateTable, parsePageParams } from "../utils/pagination.js";

const MAX_UPLOAD_BYTES = 400 * 1024 * 1024;

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.post("/projects/upload", { preHandler: requireScope("projects:write") }, async (req, reply) => {
    const parts = req.parts();
    let projectId: string | null = null;
    let projectName: string | null = null;
    let runCommand: string | null = null;
    let declaredLanguage: string | null = null;
    let envRaw: string | null = null;
    let manifest: { files: string[]; total_bytes: number; excluded: string[] } | null = null;
    let archive: Buffer | null = null;
    let filename: string | null = null;

    try {
      for await (const part of parts) {
        if (part.type === "file") {
          if (part.fieldname !== "file") continue;
          filename = part.filename;
          const chunks: Buffer[] = [];
          let size = 0;

          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
              throw new UploadError(
                "UPLOAD_TOO_LARGE",
                `Archive exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`
              );
            }
            chunks.push(chunk as Buffer);
          }

          archive = Buffer.concat(chunks);
        } else {
          const value = String(part.value ?? "");
          if (part.fieldname === "project_id") projectId = value;
          if (part.fieldname === "project_name") projectName = value;
          if (part.fieldname === "run_command") runCommand = value;
          if (part.fieldname === "language") declaredLanguage = value;
          if (part.fieldname === "env") envRaw = value;
          if (part.fieldname === "manifest") manifest = JSON.parse(value);
        }
      }
    } catch (err) {
      if (err instanceof UploadError) {
        return reply.status(413).send({
          error: { code: err.code, message: err.message },
        });
      }
      logger.error({ err, userId: req.auth!.userId }, "Upload parse failed");
      return reply.status(400).send({
        error: { code: "INVALID_UPLOAD", message: "Could not read the uploaded archive" },
      });
    }

    if (!projectId) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "project_id is required" },
      });
    }

    if (!archive || archive.length === 0) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "file is required" },
      });
    }

    // The metadata tail (identity, storage, language, env, database) lives in
    // the shared finalize service so the edge's internal endpoint performs
    // the identical steps for staged bytes.
    const outcome = await finalizeProjectUpload({
      userId: req.auth!.userId,
      requestedId: projectId,
      projectName,
      runCommand,
      declaredLanguage,
      envRaw,
      manifest,
      filename,
      store: { kind: "buffer", data: archive },
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get("/projects", { preHandler: requireScope("projects:read") }, async (req, reply) => {
    // Paginated, but the `projects` key stays: it is the contract every
    // client reads, and it is frozen. New clients also get total/page/limit.
    const page = parsePageParams(req.query);
    const userId = req.auth!.userId;
    try {
      const { items, total } = await paginateTable({
        table: "projects",
        columns: "id, name, upload_id, upload_sha256, upload_bytes, file_count, created_at, updated_at",
        orderBy: "created_at",
        ascending: false,
        page,
        applyFilters: (q) => q.eq("user_id", userId),
      });
      return reply.send({ projects: items, total, page: page.page, limit: page.limit });
    } catch (err) {
      logger.error({ err, userId }, "Failed to list projects");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to list projects" },
      });
    }
  });
}

class UploadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}
