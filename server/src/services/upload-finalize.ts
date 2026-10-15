import crypto from "node:crypto";
import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";
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
  // Bytes already persisted on a server-agent's disk by the edge. Nothing to
  // move or sign: the fetch URL below is what runtime starters GET (ticket in
  // query, sha verified on arrival), on this host or a sibling.
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
  store: UploadStore;
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
  // Buffer only: the direct-to-Node path (local development and callers
  // reaching Node without the edge). Agent bytes are already stored; edge
  // callers never reach here.
  data: Buffer,
  // Projects mint a fresh upload id per upload so they must never overwrite;
  // bundles reuse one key per build id so re-uploads replace.
  upsert: boolean,
  logCtx: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; outcome: FinalizeOutcome }> {
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, data, {
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

export async function finalizeProjectUpload(input: ProjectFinalizeInput): Promise<FinalizeOutcome> {
  const { userId, requestedId } = input;
  const isAgent = input.store.kind === "agent";
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
  // Agent-stored bytes already live at their final key; upload_path records it
  // for reference and cleanup, and no Supabase placement happens.
  const storagePath = isAgent
    ? (input.store as { key: string }).key
    : `${userId}/${resolvedId}/${uploadId}.zip`;
  const logCtx = { userId, projectId: requestedId, resolvedId, uploadId };

  let signedUrl: string;
  if (isAgent) {
    const agent = input.store as { agentUrl: string; key: string; ticket: string };
    signedUrl = agentStoreUrl(agent.agentUrl, agent.key, agent.ticket);
  } else {
    const placed = await placeObject(
      PROJECT_BUCKET,
      storagePath,
      (input.store as { kind: "buffer"; data: Buffer }).data,
      false,
      logCtx
    );
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
    signedUrl = signed.signedUrl;
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

  // Agent home is recorded so re-uploads land on the same host and runtime
  // starts pin back to it. An upsert carrying unknown columns fails the whole
  // write (PGRST204 / no-such-column when migration 0027 hasn't run), so on
  // exactly that error the write retries without the agent columns: the
  // upload itself must never 500 over bookkeeping.
  const agentCols =
    input.store.kind === "agent"
      ? { agent_id: input.store.agentId || null, agent_url: input.store.agentUrl || null }
      : {};
  let projectError: unknown;
  {
    const attempt = await supabase.from("projects").upsert(
      {
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
        updated_at: now,
        ...agentCols,
      },
      { onConflict: "id" }
    );
    projectError = attempt.error;
    if (projectError && isMissingColumnError(projectError) && Object.keys(agentCols).length > 0) {
      logger.warn({ ...logCtx }, "Agent columns missing; recording upload without affinity");
      const retry = await supabase.from("projects").upsert(
        {
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
          updated_at: now,
        },
        { onConflict: "id" }
      );
      projectError = retry.error;
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
  const { sha256, bytes } =
    input.store.kind === "buffer"
      ? {
          sha256: crypto.createHash("sha256").update(input.store.data).digest("hex"),
          bytes: input.store.data.length,
        }
      : { sha256: input.store.sha256, bytes: input.store.bytes };

  // Replace semantics: re-uploads overwrite the same key. Agent-stored bytes
  // already live at their key; recordBundleArtifact stores the string it is
  // given into the artifacts `url` column, so the agent fetch URL goes there
  // directly and starters GET it like any other URL.
  const isAgent = input.store.kind === "agent";
  const storagePath = isAgent
    ? agentStoreUrl(
        (input.store as { agentUrl: string }).agentUrl,
        (input.store as { key: string }).key,
        (input.store as { ticket: string }).ticket
      )
    : `bundles/${buildId}.zip`;
  if (!isAgent) {
    const placed = await placeObject(
      BUNDLE_BUCKET,
      storagePath,
      (input.store as { kind: "buffer"; data: Buffer }).data,
      true,
      { buildId }
    );
    if (!placed.ok) return placed.outcome;
  }

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

  // Align the project with the bundle's home host when it has none yet, so
  // the next runtime start pins to where both artifacts live. Best-effort and
  // missing-column tolerant; a legacy project keeps working without affinity.
  // Read-then-write (not an `is null` filter) because the local sqlite
  // stand-in has no `.is()`; an indexed point read is cheap either way.
  if (isAgent) {
    try {
      const agent = input.store as { agentId: string; agentUrl: string };
      const build = await getBuild(buildId);
      const projectId = (build as { project_id?: string } | null)?.project_id;
      if (projectId && agent.agentUrl) {
        const current = await projectStoreAgentColumns(projectId);
        if (current && !current.agent_id && !current.agent_url) {
          const { error } = await supabase
            .from("projects")
            .update({ agent_id: agent.agentId || null, agent_url: agent.agentUrl })
            .eq("id", projectId);
          if (error && !isMissingColumnError(error)) throw error;
        }
      }
    } catch (err) {
      logger.warn({ err, buildId }, "Bundle home alignment skipped");
    }
  }

  logger.info({ buildId, bytes, sha256 }, "Recorded runtime bundle");
  return { status: 200, body: { ok: true, sha256, bytes } };
}
