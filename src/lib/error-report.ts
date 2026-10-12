const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const ENDPOINT = "/api/v1/client-errors";

export type ClientFailureKind = "api" | "render" | "window" | "rejection";

export interface ClientFailure {
  message: string;
  /** Page path for render/window failures, request path for api ones. */
  path: string;
  kind: ClientFailureKind;
  status?: number | null;
  code?: string | null;
  stack?: string | null;
}

// A broken page can fail in a loop (render crash → report → re-render → crash
// is prevented by the boundary remounting, but reload spam is real). The
// client-side cap keeps one bad tab from flooding the inbox before the
// server-side rate limit even sees it.
const MAX_PER_MINUTE = 10;
let installed = false;
const sentAt: number[] = [];

/**
 * Fire-and-forget failure report. Never throws, never awaits: reporting a
 * failure must not become a second failure. Reports about the report endpoint
 * itself are dropped — retrying those is how infinite loops happen.
 */
export function reportClientError(failure: ClientFailure): void {
  try {
    if (failure.path === ENDPOINT) return;

    const now = Date.now();
    while (sentAt.length > 0 && (sentAt[0] ?? 0) <= now - 60_000) sentAt.shift();
    if (sentAt.length >= MAX_PER_MINUTE) return;
    sentAt.push(now);

    const token = localStorage.getItem("shipit.access_token");
    void fetch(`${API_BASE}${ENDPOINT}`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message: failure.message.slice(0, 1000),
        path: failure.path.slice(0, 500),
        kind: failure.kind,
        ...(failure.status != null ? { status: failure.status } : {}),
        ...(failure.code ? { code: failure.code.slice(0, 100) } : {}),
        ...(failure.stack ? { stack: failure.stack.slice(0, 4000) } : {}),
      }),
    }).catch(() => {
      // Offline or the server itself is down: the console line the caller
      // already wrote is the record. Swallow, or this handler throws.
    });
  } catch {
    // Local storage or fetch construction failed in an exotic context.
  }
}

function messageFromEvent(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function stackFromEvent(error: unknown): string | null {
  return error instanceof Error && error.stack ? error.stack : null;
}

/**
 * Installs once at boot: script errors, unhandled promise rejections and —
 * via the error boundary and the api helper — render crashes and failed API
 * calls all end up in the admin Errors tab with the page attached.
 */
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const message = event.message || messageFromEvent(event.error, "Script error");
    console.error(`Failed on page ${window.location.pathname}:`, message);
    reportClientError({
      message,
      path: window.location.pathname,
      kind: "window",
      stack: stackFromEvent(event.error),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const message = messageFromEvent(event.reason, "Unhandled promise rejection");
    console.error(`Unhandled rejection on page ${window.location.pathname}:`, message);
    reportClientError({
      message,
      path: window.location.pathname,
      kind: "rejection",
      stack: stackFromEvent(event.reason),
    });
  });
}
