import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../middleware/auth.js";
import { supabase } from "../db/index.js";
import { getQuotaStatus } from "../services/quota-service.js";
import { callOrchestrator } from "../services/orchestrator-client.js";
import { latestBundleArtifact } from "../services/build-service.js";
import { decryptEnvVars, projectEnvKey } from "../utils/env-crypto.js";
import { logger } from "../utils/logger.js";

const startSchema = z.object({
  project_id: z.string().min(1),
});

// How long the agent may hold the archive link. The download begins
    // immediately on start, so this only needs to survive a slow queue.
const SOURCE_URL_TTL_SECONDS = 15 * 60;
/**
 * The 404 shape every unknown runtime id uses. A single code lets callers
 * branch on "missing" without enumerating per-resource variants.
 */
export function notFound(message: string): { error: { code: string; message: string } } {
  return { error: { code: "NOT_FOUND", message } };
}

/**
 * Adds the project name to each runtime row. The orchestrator only knows ids,
 * while the name lives in this process's own store, so the join happens here.
 * Unknown projects keep the id and get no name rather than dropping the row.
 */
export function attachProjectNames<T extends { project_id?: string }>(
  runtimes: T[],
  projects: { id: string; name: string }[]
): (T & { project_name: string | null })[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return runtimes.map((r) => ({
    ...r,
    project_name: (r.project_id && names.get(r.project_id)) ?? null,
  }));
}

async function projectNamesFor(userId: string): Promise<{ id: string; name: string }[]> {
  try {
    const { data } = await supabase
      .from("projects")
      .select("id, name")
      .eq("user_id", userId);
    return (data ?? []) as { id: string; name: string }[];
  } catch {
    // Names are decoration: a lookup failure still lists the runtimes.
    return [];
  }
}

// Passed as the 4th arg to callOrchestrator for start/stop/restart: one
// automatic retry when the orchestrator never answered, before the 502.
const WITH_SINGLE_502_RETRY = { retryUnavailableOnce: true } as const;

export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.post("/runtimes", async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid runtime request" },
      });
    }

    const userId = req.auth!.userId;
    const projectId = parsed.data.project_id;

    // The project lives in this process's own store, so the start command and
    // the archive location are resolved here. Previously the orchestrator looked
    // the command up in a different database entirely and always came back
    // empty, which left the container with nothing to run.
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, run_command, language, env_ciphertext, upload_path, upload_sha256")
      .eq("id", projectId)
      .eq("user_id", userId)
      .single();

    if (projectError || !project) {
      return reply.status(404).send({
        error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
      });
    }

    // A signed link the agent can actually reach: it pulls from inside the
    // private network, where the public hostname would not resolve.
    const { data: signed, error: signError } = await supabase.storage
      .from("project-uploads")
      .createSignedUrl(project.upload_path!, SOURCE_URL_TTL_SECONDS, {
        audience: "internal",
      });

    if (signError || !signed?.signedUrl) {
      logger.error({ err: signError, projectId }, "Could not sign the project archive");
      return reply.status(500).send({
        error: {
          code: "SOURCE_UNAVAILABLE",
          message: "The project archive could not be prepared for this runtime.",
        },
      });
    }

    try {
      const row = project as {
        run_command?: string | null;
        language?: string | null;
        env_ciphertext?: string | null;
      };

      // The sandbox needs plaintext env, so decryption happens here — the last
      // trusted hop — and the values travel only inside the signed start call.
      // A project that predates environments simply starts with none.
      let env: Record<string, string> = {};
      if (row.env_ciphertext) {
        try {
          env = decryptEnvVars(row.env_ciphertext, projectEnvKey());
        } catch (err) {
          logger.error({ err, projectId }, "Project env could not be decrypted");
          return reply.status(500).send({
            error: {
              code: "ENV_UNREADABLE",
              message: "The project's stored environment could not be read. Re-upload it with env to continue.",
            },
          });
        }
      }

      // A successful build's bundle runs instead of raw source: it carries the
      // toolchain and dependencies the sandbox host does not have. Missing
      // means no bundle was ever uploaded, and the archive flow applies.
      let bundleUrl = "";
      let bundleSha256 = "";
      try {
        const bundle = await latestBundleArtifact(userId, projectId);
        if (bundle) {
          const { data: signedBundle, error: bundleSignError } = await supabase.storage
            .from("project-uploads")
            .createSignedUrl(bundle.storage_path, SOURCE_URL_TTL_SECONDS);
          if (!bundleSignError && signedBundle?.signedUrl) {
            bundleUrl = signedBundle.signedUrl;
            bundleSha256 = bundle.sha256;
          } else {
            logger.warn({ err: bundleSignError, projectId }, "Could not sign bundle URL; using source archive");
          }
        }
      } catch (err) {
        // Best-effort: a bundle lookup failure must not block starting from
        // source, which is the long-standing behavior.
        logger.warn({ err, projectId }, "Bundle lookup failed; using source archive");
      }

      const result = await callOrchestrator<{ runtime: unknown }>("/runtime/start", {
        user_id: userId,
        project_id: projectId,
        run_command: project.run_command ?? "",
        language: row.language ?? "node",
        env,
        bundle_url: bundleUrl,
        bundle_sha256: bundleSha256,
        source_url: signed.signedUrl,
        source_sha256: project.upload_sha256 ?? "",
        plan: {
          runtime_hours_per_month: req.auth!.plan.runtime_hours_per_month,
          max_runtime_hours: req.auth!.plan.max_runtime_hours,
          max_concurrent_runtimes: req.auth!.plan.max_concurrent_runtimes,
          max_ram_mb: req.auth!.plan.max_ram_mb,
          cpu: Number(req.auth!.plan.cpu),
          plan_id: req.auth!.plan.id,
        },
      }, 30_000, WITH_SINGLE_502_RETRY);

      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof OrchestratorError) {
        // Surface the orchestrator's own reason instead of masking everything
        // as unreachable: quota, capacity and agent failures each need a
        // different response from the caller.
        const status =
          err.code === "RUNTIME_QUOTA_EXCEEDED"
            ? 403
            : err.code === "RUNTIME_NOT_FOUND"
              ? 404
              : // Capacity is temporary rather than a fault, so it stays a 429
                // and the message is written for the person reading it.
                err.code === "CAPACITY_EXHAUSTED"
                ? 429
                : err.code === "CONCURRENCY_LIMIT_REACHED"
                  ? 409
                  : 502;

        return reply.status(status).send({
          error: { code: err.code, message: err.message },
        });
      }
      logger.error({ err, userId: req.auth!.userId }, "Orchestrator start failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }
  });

  app.get("/runtimes", async (req, reply) => {
    try {
      const result = await callOrchestrator<{ runtimes: { project_id?: string }[] }>("/runtime/list", {
        user_id: req.auth!.userId,
      });
      // Resolve project names for the rows; the list still succeeds if the
      // lookup fails, just without names.
      const projects = await projectNamesFor(req.auth!.userId);
      return reply.send({ runtimes: attachProjectNames(result.runtimes ?? [], projects) });
    } catch (err) {
      logger.error({ err }, "Orchestrator list failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }
  });

  // Stops every runtime the caller owns. Listed first via the caller's own
  // user_id, so one account can never stop another's runtimes. Per-runtime
  // failures are reported, not thrown: a partial stop is still useful.
  app.post("/runtimes/stop-all", async (req, reply) => {
    const userId = req.auth!.userId;
    let ids: string[];
    try {
      const listed = await callOrchestrator<{ runtimes: { runtime_id?: string; id?: string }[] }>(
        "/runtime/list",
        { user_id: userId }
      );
      ids = (listed.runtimes ?? [])
        .map((r) => r.runtime_id ?? r.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch (err) {
      logger.error({ err }, "Orchestrator list failed for stop-all");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }

    const stopped: string[] = [];
    const failed: { id: string; error: string }[] = [];
    // Bound the concurrency so 10 runtimes don't await 30s each in sequence,
    // while still avoiding a thundering herd against the orchestrator.
    const CONCURRENCY = 4;
    const queue = [...ids];
    while (queue.length > 0) {
      const batch = queue.splice(0, CONCURRENCY);
      await Promise.all(
        batch.map(async (id) => {
          try {
            await callOrchestrator("/runtime/stop", { runtime_id: id, user_id: userId });
            stopped.push(id);
          } catch (err) {
            failed.push({
              id,
              error: err instanceof OrchestratorError ? err.message : "Stop failed",
            });
          }
        })
      );
    }
    return reply.send({ stopped, failed });
  });

  app.get("/runtimes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await callOrchestrator<unknown>("/runtime/status", {
        runtime_id: id,
        user_id: req.auth!.userId,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof OrchestratorError && err.code === "RUNTIME_NOT_FOUND") {
        return reply.status(404).send(notFound("Runtime not found"));
      }
      logger.error({ err, runtimeId: id }, "Orchestrator status failed");
      return reply.status(502).send({
        error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
      });
    }
  });

  const simpleActions = ["stop", "restart", "logs", "info", "health", "pause", "resume"] as const;

  for (const action of simpleActions) {
    app.post(`/runtimes/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      // start/stop/restart get one automatic retry on an unreachable
      // orchestrator; the rest (logs/info/health/pause/resume) surface it.
      const retry = action === "stop" || action === "restart" ? WITH_SINGLE_502_RETRY : undefined;
      try {
        const result = await callOrchestrator<unknown>(`/runtime/${action}`, {
          runtime_id: id,
          user_id: req.auth!.userId,
        }, 30_000, retry);
        return reply.send(result);
      } catch (err) {
        if (err instanceof OrchestratorError && err.code === "RUNTIME_NOT_FOUND") {
          return reply.status(404).send(notFound("Runtime not found"));
        }
        if (err instanceof OrchestratorError && isCallerError(err.code)) {
          return reply.status(409).send({
            error: { code: err.code, message: err.message },
          });
        }
        logger.error({ err, runtimeId: id, action }, `Orchestrator ${action} failed`);
        return reply.status(502).send({
          error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
        });
      }
    });
  }

  const proxiedActions = [
    "exec",
    "fs",
    "network",
    "cpu",
    "memory",
    "disk",
    "uptime",
  ] as const;

  for (const action of proxiedActions) {
    app.post(`/runtimes/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await callOrchestrator<unknown>(`/runtime/${action}`, {
          runtime_id: id,
          user_id: req.auth!.userId,
          ...(req.body as Record<string, unknown> | undefined),
        });
        return reply.send(result);
      } catch (err) {
        // Unknown ids are always a 404 with the shared shape, even on these
        // secondary actions, so callers branch on one missing code.
        if (err instanceof OrchestratorError && err.code === "RUNTIME_NOT_FOUND") {
          return reply.status(404).send(notFound("Runtime not found"));
        }
        // A rejected request is not an unreachable orchestrator. Collapsing every
        // failure into 502 reported a bad argument as a dead service, which sent
        // people looking in the wrong place.
        if (err instanceof OrchestratorError && isCallerError(err.code)) {
          return reply.status(400).send({
            error: { code: err.code, message: err.message },
          });
        }

        logger.error({ err, runtimeId: id, action }, `Orchestrator ${action} failed`);
        return reply.status(502).send({
          error: { code: "ORCHESTRATOR_UNREACHABLE", message: "Runtime orchestrator unreachable" },
        });
      }
    });
  }

  app.get("/usage", async (req, reply) => {
    const plan = req.auth!.plan;

    // The orchestrator is asked first because it owns the runtime lifecycle and
    // is the only service that saw the session begin and end. Reading the local
    // usage table first was how usage stayed at zero: nothing ever wrote a row
    // there, because the billing happens in the orchestrator's own store.
    try {
      const snapshot = await callOrchestrator<{
        monthly_runtime_limit_seconds: number;
        runtime_used_seconds: number;
        runtime_remaining_seconds: number;
        max_session_seconds: number;
        runtime_live_seconds: number;
      }>("/usage/snapshot", {
        user_id: req.auth!.userId,
        plan_hours_per_month: plan.runtime_hours_per_month,
        plan_max_runtime_hours: plan.max_runtime_hours,
      });

      return reply.send({
        monthly_runtime_limit_seconds: snapshot.monthly_runtime_limit_seconds,
        runtime_used_seconds: snapshot.runtime_used_seconds,
        runtime_remaining_seconds: snapshot.runtime_remaining_seconds,
        max_session_seconds: snapshot.max_session_seconds,
        // Split out so a total that keeps moving can be explained: this is the
        // part being spent right now rather than time already billed.
        runtime_live_seconds: snapshot.runtime_live_seconds ?? 0,
        plan,
      });
    } catch (err) {
      // Falling back keeps the dashboard usable if the orchestrator is down;
      // it just shows the locally accounted number rather than failing outright.
      logger.warn({ err }, "Orchestrator usage unavailable, falling back to local totals");
    }

    const quota = await getQuotaStatus(req.auth!.userId, plan);
    return reply.send({
      monthly_runtime_limit_seconds: quota.monthlyLimitSeconds,
      runtime_used_seconds: quota.usedSeconds,
      runtime_remaining_seconds: quota.remainingSeconds,
      max_session_seconds: quota.maxSessionSeconds,
      plan,
    });
  });
}

/**
 * Codes that mean the caller sent something the orchestrator refused, rather
 * than the orchestrator being unable to answer. These deserve a 400 rather than
 * a 502, because retrying them unchanged will fail identically.
 */
function isCallerError(code: string): boolean {
  return (
    code === "INVALID_REQUEST" ||
    code === "VALIDATION_ERROR" ||
    code === "INVALID_OPERATION" ||
    code === "PATH_TRAVERSAL" ||
    code === "RUNTIME_NOT_FOUND" ||
    // Pausing a stopped runtime, or resuming one that is already running, is a
    // conflict. Reporting it as an unreachable orchestrator sends people
    // looking for a dead service instead of at their own button.
    code === "PAUSE_FAILED" ||
    code === "RESUME_FAILED"
  );
}

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}
