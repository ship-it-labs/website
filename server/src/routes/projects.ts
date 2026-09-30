import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { authenticateApiKey } from "../middleware/auth.js";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";

const MAX_UPLOAD_BYTES = 400 * 1024 * 1024;
const BUCKET = "project-uploads";

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.post("/projects/upload", async (req, reply) => {
    const parts = req.parts();
    let projectId: string | null = null;
    let projectName: string | null = null;
    let runCommand: string | null = null;
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

    const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
    const userId = req.auth!.userId;

    const uploadId = `up_${crypto.randomUUID().slice(0, 12)}`;
    const storagePath = `${userId}/${projectId}/${uploadId}.zip`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, archive, {
        contentType: "application/zip",
        upsert: false,
      });

    if (uploadError) {
      logger.error({ err: uploadError, userId, projectId }, "Storage upload failed");
      return reply.status(502).send({
        error: { code: "STORAGE_UNAVAILABLE", message: "Failed to store the project archive" },
      });
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 60 * 30);

    if (signError || !signed?.signedUrl) {
      logger.error({ err: signError, userId, projectId }, "Failed to sign upload URL");
      return reply.status(502).send({
        error: { code: "STORAGE_UNAVAILABLE", message: "Failed to sign the project archive" },
      });
    }

    const now = new Date().toISOString();

    const { error: projectError } = await supabase.from("projects").upsert(
      {
        id: projectId,
        user_id: userId,
        name: projectName || projectId,
        run_command: runCommand,
        upload_id: uploadId,
        upload_path: storagePath,
        upload_url: signed.signedUrl,
        upload_sha256: sha256,
        upload_bytes: archive.length,
        file_count: manifest?.files?.length ?? 0,
        updated_at: now,
      },
      { onConflict: "id" }
    );

    if (projectError) {
      logger.error({ err: projectError, userId, projectId }, "Project record upsert failed");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to record the project upload" },
      });
    }

    logger.info(
      { userId, projectId, uploadId, bytes: archive.length },
      "Project uploaded"
    );

    return reply.status(201).send({
      project_id: projectId,
      upload_id: uploadId,
      sha256,
      filename,
      file_count: manifest?.files?.length ?? 0,
      total_bytes: archive.length,
      excluded: manifest?.excluded ?? [],
    });
  });

  app.get("/projects", async (req, reply) => {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, upload_id, upload_sha256, upload_bytes, file_count, created_at, updated_at")
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false });

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Failed to list projects" },
      });
    }

    return reply.send({ projects: data ?? [] });
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
