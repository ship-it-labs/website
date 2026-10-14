import crypto from "node:crypto";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";
import { resolveLanguage } from "./languages.js";
import { resolveProjectId } from "./project-identity.js";
import { recordBundleArtifact } from "./build-service.js";
import {
  parseEnvVars,
  encryptEnvVars,
  projectEnvKey,
  EnvConfigError,
  EnvCryptoError,
} from "../utils/env-crypto.js";
import { copyStagedObject, deleteStagedObjects } from "./object-store.js";

/**
 * The metadata tail of the two large-body uploads, shared by the public
 * multipart routes and the edge's internal finalize endpoints.
 *
 * Bytes arrive one of two ways: as a Buffer the public route assembled (local
 * development, or a caller reaching Node directly), or as a staging object
 * the Go edge already streamed to storage. Either way this function performs
 * the identical identity, language, env, database and signing steps and
 * returns the identical outcome, so the wire contract never depends on which
 * path the bytes took.
 *
 * Outcomes are `{ status, body }` rather than thrown replies so both a
 * Fastify route and the internal `{status, body}` envelope can serve them.
 */

export const PROJECT_BUCKET = "project-uploads";
export const BUNDLE_BUCKET = "project-uploads";

export type UploadStore =
  | { kind: "buffer"; data: Buffer }
  | { kind: "staging"; path: string; sha256: string; bytes: number };

export interface ProjectFinalizeInput {
  userId: string;
  requestedId: string;
  projectName: string | null;
  runCommand: string | null;
  declaredLanguage: string | null;
  envRaw: string | null;
  manifest: { files: string[]; total_bytes: number; excluded: string[] } | null;
  filename: string | null;
  store: UploadStore;
}

export interface BundleFinalizeInput {
  buildId: string;
  store: UploadStore;
}

export interface FinalizeOutcome {
  status: number;
  body: unknown;
}

async function placeObject(
  bucket: string,
  storagePath: string,
  store: UploadStore,
  // Projects mint a fresh upload id per upload so they must never overwrite;
  // bundles reuse one key per build id so re-uploads replace.
  upsert: boolean,
  logCtx: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; outcome: FinalizeOutcome }> {
  if (store.kind === "buffer") {
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, store.data, {
        contentType: "application/zip",
        upsert,
      });
    if (uploadError) {
      logger.error({ err: uploadError, ...logCtx }, "Storage upload failed");
      return {
        ok: false,
        outcome: {
          status: 502,
          body: { error: { code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload" } },
        },
      };
    }
    return { ok: true };
  }

  try {
    await copyStagedObject(bucket, store.path, storagePath);
  } catch (err) {
    logger.error({ err, ...logCtx, staging: store.path }, "Staging copy failed");
    return {
      ok: false,
      outcome: {
        status: 502,
        body: { error: { code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload" } },
      },
    };
  }
  // Best effort: the object is safely at its final key, so a failed cleanup
  // must not fail the upload. The staging sweeper reaps leftovers.
  try {
    await deleteStagedObjects(bucket, [store.path]);
  } catch (err) {
    logger.warn({ err, ...logCtx, staging: store.path }, "Staging cleanup failed; sweeper will reap it");
  }
  return { ok: true };
}

export async function finalizeProjectUpload(input: ProjectFinalizeInput): Promise<FinalizeOutcome> {
  const { userId, requestedId } = input;
  const { sha256, bytes } =
    input.store.kind === "buffer"
      ? {
          sha256: crypto.createHash("sha256").update(input.store.data).digest("hex"),
          bytes: input.store.data.length,
        }
      : { sha256: input.store.sha256, bytes: input.store.bytes };

  // The requested id is the primary key, so a slug already owned by another
  // account must never be written: that would move their project to us.
  // Resolve to an account-scoped id in that one case; everything else keeps
  // the requested id so re-uploads update in place. See project-identity.ts.
  const { data: claim } = await supabase
    .from("projects")
    .select("user_id")
    .eq("id", requestedId)
    .maybeSingle();
  const resolvedId = resolveProjectId({
    requestedId,
    userId,
    ownerId: (claim as { user_id?: string } | null)?.user_id ?? null,
  });

  const uploadId = `up_${crypto.randomUUID().slice(0, 12)}`;
  const storagePath = `${userId}/${resolvedId}/${uploadId}.zip`;
  const logCtx = { userId, projectId: requestedId, resolvedId, uploadId };

  const placed = await placeObject(PROJECT_BUCKET, storagePath, input.store, false, logCtx);
  if (!placed.ok) return placed.outcome;

  const { data: signed, error: signError } = await supabase.storage
    .from(PROJECT_BUCKET)
    .createSignedUrl(storagePath, 60 * 30);

  if (signError || !signed?.signedUrl) {
    logger.error({ err: signError, ...logCtx }, "Failed to sign upload URL");
    return {
      status: 502,
      body: { error: { code: "STORAGE_UNAVAILABLE", message: "Failed to sign the project archive" } },
    };
  }

  const now = new Date().toISOString();

  // The AI declares the language; the archive contents arbitrate. A wrong
  // declaration would otherwise send the project to a toolchain that cannot
  // build it, and the failure would surface minutes later in CI.
  const resolved = resolveLanguage(
    input.declaredLanguage || undefined,
    input.manifest?.files ?? []
  );
  if (resolved.note) {
    logger.info({ ...logCtx, note: resolved.note }, "Upload language resolved by detection");
  }

  // A re-upload without env keeps the previous env: wiping secrets because
  // a later upload omitted the field would be a silent, baffling breakage.
  // An explicit env (even {}) replaces it.
  let envCiphertext: string | null | undefined;
  if (input.envRaw === null) {
    const { data: prior } = await supabase
      .from("projects")
      .select("env_ciphertext")
      .eq("id", resolvedId)
      .eq("user_id", userId)
      .single();
    envCiphertext = (prior as { env_ciphertext?: string | null } | null)?.env_ciphertext ?? null;
  } else if (input.envRaw.trim() === "") {
    envCiphertext = null;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.envRaw);
    } catch {
      return {
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "env must be a JSON object" } },
      };
    }
    try {
      const vars = parseEnvVars(parsed);
      envCiphertext = encryptEnvVars(vars, projectEnvKey());
    } catch (err) {
      if (err instanceof EnvConfigError) {
        logger.error({ ...logCtx }, "Project env submitted without PROJECT_ENV_KEY");
        return {
          status: 500,
          body: {
            error: {
              code: "ENV_NOT_CONFIGURED",
              message: "Project environments are not enabled on this deployment",
            },
          },
        };
      }
      return {
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: err instanceof EnvCryptoError ? err.message : "Invalid env",
          },
        },
      };
    }
  }

  const { error: projectError } = await supabase.from("projects").upsert(
    {
      id: resolvedId,
      user_id: userId,
      name: input.projectName || resolvedId,
      run_command: input.runCommand,
      language: resolved.language,
      env_ciphertext: envCiphertext,
      upload_id: uploadId,
      upload_path: storagePath,
      upload_url: signed.signedUrl,
      upload_sha256: sha256,
      upload_bytes: bytes,
      file_count: input.manifest?.files?.length ?? 0,
      updated_at: now,
    },
    { onConflict: "id" }
  );

  if (projectError) {
    logger.error({ err: projectError, ...logCtx }, "Project record upsert failed");
    return {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Failed to record the project upload" } },
    };
  }

  logger.info(
    { ...logCtx, bytes, language: resolved.language },
    "Project uploaded"
  );

  return {
    status: 201,
    body: {
      project_id: resolvedId,
      upload_id: uploadId,
      sha256,
      filename: input.filename,
      language: resolved.language,
      language_note: resolved.note,
      file_count: input.manifest?.files?.length ?? 0,
      total_bytes: bytes,
      excluded: input.manifest?.excluded ?? [],
    },
  };
}

export async function finalizeBundleUpload(input: BundleFinalizeInput): Promise<FinalizeOutcome> {
  const { buildId } = input;
  const { sha256, bytes } =
    input.store.kind === "buffer"
      ? {
          sha256: crypto.createHash("sha256").update(input.store.data).digest("hex"),
          bytes: input.store.data.length,
        }
      : { sha256: input.store.sha256, bytes: input.store.bytes };

  // Replace semantics: re-uploads overwrite the same key.
  const storagePath = `bundles/${buildId}.zip`;
  const placed = await placeObject(BUNDLE_BUCKET, storagePath, input.store, true, { buildId });
  if (!placed.ok) return placed.outcome;

  try {
    await recordBundleArtifact(buildId, {
      sha256,
      sizeBytes: bytes,
      storagePath,
    });
  } catch {
    return {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Failed to record the bundle" } },
    };
  }

  logger.info({ buildId, bytes, sha256 }, "Recorded runtime bundle");
  return { status: 200, body: { ok: true, sha256, bytes } };
}
