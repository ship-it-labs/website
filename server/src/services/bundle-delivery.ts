import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { orchestratorSecret, orchestratorUrl } from "../config/urls.js";
import { getBuild, recordBundleArtifact } from "./build-service.js";
import { callOrchestrator } from "./orchestrator-client.js";
import {
  finalizeBundleUpload,
  touchProjectActivity,
  type FinalizeOutcome,
} from "./upload-finalize.js";

/**
 * Live-or-artifact bundle delivery.
 *
 * CI-built bundles never touch platform storage or Node's heap. When a
 * runtime of the project is live, the byte stream is piped straight through
 * to that runtime's host (orchestrator `PUT /store/put`, pinned with
 * `X-Preferred-Agent`) and the resulting agent fetch URL is recorded as the
 * bundle artifact — the next start fetches locally. When nothing runs, the
 * stream is drained and discarded: the bundle stays only as the GitHub
 * Actions artifact (7-day retention), and its run URL is recorded so the
 * dashboard can link it. Either way the runtime start falls back to the
 * Supabase source archive when no fetchable bundle exists.
 *
 * Peak Node memory is kilobytes: hashing, counting and cap enforcement ride
 * a single streaming pass, never a Buffer.
 */

/** Largest bundle the control plane accepts. Runtimes with more footprint
 * than this do not fit the sandbox model anyway (see the 5GB per-runtime
 * watchdog on the agent); the workflow stays under it by excluding caches. */
export const MAX_BUNDLE_BYTES = 300 * 1024 * 1024;

/**
 * True when a bundle artifact row points at the CI artifact rather than any
 * fetchable object store. Starters must skip these without attempting a
 * Supabase signature (which fails noisily with a 404 that looks like a
 * storage fault but is just a marker): the source archive runs instead.
 */
export function isGithubArtifactUrl(url: string | null | undefined): boolean {
  return (
    typeof url === "string" &&
    (url.startsWith("https://github.com/") || url.startsWith("github-artifacts:"))
  );
}

interface LiveTarget {
  agentId: string;
  agentUrl: string;
}

interface OrchestratorRuntime {
  project_id?: string;
  status?: string;
  agent_id?: string;
  agent_url?: string;
}

/** The host of a live runtime for this project, if the orchestrator tracks
 * one. Null covers every failure mode (no runtimes, orchestrator down,
 * legacy agents not reporting URLs): the caller takes the artifact path. */
async function findLiveTarget(userId: string, projectId: string): Promise<LiveTarget | null> {
  try {
    const res = await callOrchestrator<{ runtimes?: OrchestratorRuntime[] }>(
      "/runtime/list",
      { user_id: userId },
      15_000
    );
    const live = (res.runtimes ?? []).find(
      (r) =>
        r.project_id === projectId &&
        (r.status === "running" || r.status === "starting") &&
        !!r.agent_url
    );
    if (!live?.agent_url) return null;
    return { agentId: live.agent_id ?? "", agentUrl: live.agent_url };
  } catch (err) {
    logger.info({ err, projectId }, "Live-runtime lookup failed; bundle stays in CI artifacts");
    return null;
  }
}

class BundleTooLarge extends Error {}

export interface BundleDeliveryInput {
  buildId: string;
  /** The multipart `file` part, consumed exactly once. */
  file: AsyncIterable<Uint8Array>;
  githubRepo?: string;
  githubRunId?: string;
}

export async function deliverBundle(input: BundleDeliveryInput): Promise<FinalizeOutcome> {
  const { buildId } = input;
  const build = await getBuild(buildId);
  if (!build) {
    return {
      status: 404,
      body: { error: { code: "BUILD_NOT_FOUND", message: "Build not found" } },
    };
  }
  const projectId = (build as { project_id?: string }).project_id ?? "";
  const userId = (build as { user_id?: string }).user_id ?? "";
  const runUrl =
    input.githubRepo && input.githubRunId
      ? `https://github.com/${input.githubRepo}/actions/runs/${input.githubRunId}`
      : null;

  const live = projectId && userId ? await findLiveTarget(userId, projectId) : null;

  if (!live) {
    // Nothing runs: drain (hashing and capping on the way past) and record
    // where the bytes actually live — the CI artifact.
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of input.file) {
        bytes += chunk.length;
        if (bytes > MAX_BUNDLE_BYTES) throw new BundleTooLarge();
        hash.update(chunk);
      }
    } catch (err) {
      if (err instanceof BundleTooLarge) {
        return {
          status: 413,
          body: { error: { code: "BUNDLE_TOO_LARGE", message: "Bundle exceeds the 300MB limit" } },
        };
      }
      throw err;
    }
    const sha256 = hash.digest("hex");
    if (bytes === 0) {
      return {
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "file is required" } },
      };
    }
    try {
      await recordBundleArtifact(buildId, {
        sha256,
        sizeBytes: bytes,
        storagePath: runUrl ?? `github-artifacts:bundle-${buildId}`,
      });
    } catch {
      return {
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "Failed to record the bundle" } },
      };
    }
    if (projectId) await touchProjectActivity(projectId);
    logger.info({ buildId, bytes, sha256, runUrl }, "Bundle kept in CI artifacts; no runtime running");
    return {
      status: 200,
      body: { ok: true, stored: false, location: "github-artifacts", run_url: runUrl, sha256, bytes },
    };
  }

  // A runtime is live: pipe the stream to its host without buffering. The
  // cap is enforced by throwing mid-stream, which aborts the forward.
  let tooLarge = false;
  const forwardStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let bytes = 0;
        for await (const chunk of input.file) {
          bytes += chunk.length;
          if (bytes > MAX_BUNDLE_BYTES) {
            tooLarge = true;
            throw new BundleTooLarge();
          }
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  let storeRes: Response;
  try {
    storeRes = await fetch(`${orchestratorUrl()}/store/put`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        "X-Service-Secret": orchestratorSecret(),
        "X-Preferred-Agent": live.agentUrl,
      },
      body: forwardStream,
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (err) {
    if (tooLarge) {
      return {
        status: 413,
        body: { error: { code: "BUNDLE_TOO_LARGE", message: "Bundle exceeds the 300MB limit" } },
      };
    }
    logger.error({ err, buildId }, "Bundle forward to live host failed");
    return {
      status: 502,
      body: { error: { code: "STORE_FAILED", message: "Could not deliver the bundle to the running runtime" } },
    };
  }

  if (!storeRes.ok) {
    const text = await storeRes.text().catch(() => "");
    logger.error({ buildId, status: storeRes.status, text: text.slice(0, 200) }, "Bundle forward rejected");
    return {
      status: 502,
      body: { error: { code: "STORE_FAILED", message: "Could not deliver the bundle to the running runtime" } },
    };
  }

  const stored = (await storeRes.json().catch(() => null)) as {
    agent_id?: string;
    agent_url?: string;
    key?: string;
    sha256?: string;
    bytes?: number;
    ticket?: string;
  } | null;
  if (!stored?.agent_url || !stored.key || !stored.ticket || !stored.sha256 || !stored.bytes) {
    logger.error({ buildId, stored }, "Bundle forward returned an unusable receipt");
    return {
      status: 502,
      body: { error: { code: "STORE_FAILED", message: "Could not deliver the bundle to the running runtime" } },
    };
  }

  return finalizeBundleUpload({
    buildId,
    store: {
      kind: "agent",
      agentId: stored.agent_id ?? live.agentId,
      agentUrl: stored.agent_url,
      key: stored.key,
      sha256: stored.sha256,
      bytes: stored.bytes,
      ticket: stored.ticket,
    },
  });
}
