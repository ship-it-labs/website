import crypto from "node:crypto";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";
import { copyStagedObject, deleteStagedObjects } from "./object-store.js";
import { resolveLanguage } from "./languages.js";
import { resolveProjectId } from "./project-identity.js";
import { recordBundleArtifact, getBuild } from "./build-service.js";
import {
  parseEnvVars,
  encryptEnvVars,
  projectEnvKey,
  EnvConfigError,
  EnvCryptoError,
} from "../utils/env-crypto.js";
import { agentStoreUrl } from "../utils/agent-store.js";

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
  // Bytes the Go edge already streamed to a Supabase staging object. Node
  // moves them server-side to the final key (no download), then reaps the
  // staging copy. Used by project uploads through the edge.
  | { kind: "staging"; path: string; sha256: string; bytes: number }
  // Bytes already persisted on a server-agent's disk by a live delivery.
  // Nothing to move or sign: the fetch URL below is what runtime starters
  // GET (ticket in query, sha verified on arrival). Used only by bundle
  // deliveries forwarded to the host of a running runtime.
  | {
      kind: "agent";
      agentId: string;
      agentUrl: string;
      key: string;
      sha256: string;
      bytes: number;
      ticket: string;
    };

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
  store: Extract<UploadStore, { kind: "agent" }>;
}

export interface FinalizeOutcome {
  status: number;
  body: unknown;
}

/** True when a write failed only because migration columns don't exist yet
 * (PGRST204 on PostgREST, no-such-column on sqlite). Callers degrade instead
 * of failing the upload over bookkeeping. */
function isMissingColumnError(error: unknown): boolean {
  const msg = String((error as { message?: string } | null)?.message ?? error ?? "");
  return /PGRST204|schema cache|no such column/i.test(msg);
}

/** Tolerant read of one project's home-agent columns. Null when unset,
 * missing (pre-0027), or unreadable — all meaning "no affinity recorded".
 * Scoped to the caller's account when a userId is given. */
export async function projectStoreAgentColumns(
  projectId: string,
  userId?: string
): Promise<{ agent_id: string | null; agent_url: string | null } | null> {
  try {
    let query = supabase
      .from("projects")
      .select("agent_id, agent_url")
      .eq("id", projectId);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query.limit(1);
    if (error) {
      if (isMissingColumnError(error)) return null;
      throw error;
    }
    const row = (((data ?? []) as unknown[]) as {
      agent_id?: string | null;
      agent_url?: string | null;
    }[])[0];
    if (!row) return null;
    return { agent_id: row.agent_id ?? null, agent_url: row.agent_url ?? null };
  } catch (err) {
    logger.debug({ err, projectId }, "Home-agent read skipped");
    return null;
  }
}

async function placeObject(
  bucket: string,
  storagePath: string,
  // Buffer: the direct-to-Node path (local development and callers reaching
  // Node without the edge). Staging: the edge already streamed the bytes to
  // Supabase; only a server-side move to the final key is left.
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

  if (store.kind === "staging") {
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
    // Best effort: the object is safely at its final key, so a failed
    // cleanup must not fail the upload. The staging sweeper reaps leftovers.
    try {
      await deleteStagedObjects(bucket, [store.path]);
    } catch (err) {
      logger.warn({ err, ...logCtx, staging: store.path }, "Staging cleanup failed; sweeper will reap it");
    }
    return { ok: true };
  }

  return {
    ok: false,
    outcome: {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Project uploads arrive buffered or staged, never agent-stored" } },
    },
  };
}

/** Best-effort activity touch: a failed touch must never fail the upload or
 * start it records. Missing-column tolerant (pre-0028 databases). */
export async function touchProjectActivity(projectId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from("projects")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", projectId);
    if (error && !isMissingColumnError(error)) throw error;
  } catch (err) {
    logger.debug({ err, projectId }, "Activity touch skipped");
  }
}

export async function finalizeProjectUpload(input: ProjectFinalizeInput): Promise<FinalizeOutcome> {
  const { userId, requestedId } = input;
  const { sha256, bytes } =
    input.store.kind === "buffer"
      ? {
          sha256: crypto.createHash("sha256").update(input.store.data).digest("hex"),
          bytes: input.store.data.length,
        }
      : input.store.kind === "staging"
        ? { sha256: input.store.sha256, bytes: input.store.bytes }
        : { sha256: "", bytes: 0 };
  if (!sha256 || bytes <= 0) {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Project uploads arrive buffered or staged, never agent-stored" } },
    };
  }

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
  // Fresh key per upload: re-uploads never overwrite, so a failed finalize
  // can never leave a half-written object behind under a live key.
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
  const signedUrl = signed.signedUrl;

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

  // last_activity_at drives the storage-retention sweeper (free 24h, pro 3d,
  // ultra 7d of inactivity). An upsert carrying unknown columns fails the
  // whole write (PGRST204 / no-such-column when a migration hasn't run), so
  // on exactly that error the write retries without the activity column: the
  // upload itself must never 500 over bookkeeping.
  const projectRow = {
    id: resolvedId,
    user_id: userId,
    name: input.projectName || resolvedId,
    run_command: input.runCommand,
    language: resolved.language,
    env_ciphertext: envCiphertext,
    upload_id: uploadId,
    upload_path: storagePath,
    upload_url: signedUrl,
    upload_sha256: sha256,
    upload_bytes: bytes,
    file_count: input.manifest?.files?.length ?? 0,
    last_activity_at: now,
    updated_at: now,
  };
  let projectError: unknown;
  {
    const attempt = await supabase.from("projects").upsert(projectRow, { onConflict: "id" });
    projectError = attempt.error;
    if (projectError && isMissingColumnError(projectError)) {
      logger.warn({ ...logCtx }, "Activity column missing; recording upload without it");
      const { last_activity_at: _dropped, ...legacyRow } = projectRow;
      projectError = (await supabase.from("projects").upsert(legacyRow, { onConflict: "id" })).error;
    }
  }

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
  if (input.store.kind !== "agent" || !input.store.sha256 || input.store.bytes <= 0) {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Bundles arrive via live delivery to the running runtime's host" } },
    };
  }
  const sha256 = input.store.sha256;
  const bytes = input.store.bytes;

  // The storing host's fetch URL goes into the artifacts `url` column
  // directly, and starters GET it like any other URL (ticket in query, sha
  // verified on arrival).
  const storagePath = agentStoreUrl(input.store.agentUrl, input.store.key, input.store.ticket);

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

  // The freshest bundle wins the home: starts pin to the host holding it so
  // the fetch is local. Best-effort and missing-column tolerant; a legacy
  // project keeps working without affinity (least-loaded routing + source).
  try {
    const build = await getBuild(buildId);
    const projectId = (build as { project_id?: string } | null)?.project_id;
    if (projectId) {
      const { error } = await supabase
        .from("projects")
        .update({
          agent_id: input.store.agentId || null,
          agent_url: input.store.agentUrl,
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", projectId);
      if (error && !isMissingColumnError(error)) throw error;
      if (error) await touchProjectActivity(projectId);
    }
  } catch (err) {
    logger.warn({ err, buildId }, "Bundle home alignment skipped");
  }

  logger.info({ buildId, bytes, sha256 }, "Recorded runtime bundle");
  return { status: 200, body: { ok: true, sha256, bytes } };
}
