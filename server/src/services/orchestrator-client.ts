import { OrchestratorError } from "../routes/runtimes.js";
import { logger } from "../utils/logger.js";
import { orchestratorSecret, orchestratorUrl } from "../config/urls.js";

interface OrchestratorResponse<T> {
  status: number;
  body: T;
}

export async function callOrchestrator<T>(
  path: string,
  payload: unknown,
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${orchestratorUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Secret": orchestratorSecret(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    const body = text ? safeParse(text) : null;

    if (!response.ok) {
      const parsed = body as { error?: { code?: string; message?: string } } | null;
      throw new OrchestratorError(
        parsed?.error?.code ?? "ORCHESTRATOR_ERROR",
        parsed?.error?.message ?? `Orchestrator returned ${response.status}`
      );
    }

    return body as T;
  } catch (err) {
    if (err instanceof OrchestratorError) {
      throw err;
    }
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Orchestrator request to ${path} timed out`
        : `Could not reach the runtime orchestrator at ${orchestratorUrl()}`;
    logger.error({ err, path }, message);
    throw new OrchestratorError("ORCHESTRATOR_UNREACHABLE", message);
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type { OrchestratorResponse };
