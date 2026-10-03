const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  static from(status: number, body: unknown): ApiError {
    if (body && typeof body === "object" && "error" in body) {
      const parsed = body as { error?: { code?: string; message?: string } };
      if (parsed.error && typeof parsed.error === "object") {
        return new ApiError(
          status,
          parsed.error.code ?? "UNKNOWN",
          parsed.error.message ?? `Request failed with status ${status}`
        );
      }
    }
    return new ApiError(status, "UNKNOWN", `Request failed with status ${status}`);
  }
}

/**
 * Authentication is handled by the control plane rather than in the browser.
 * That keeps the client free of a Supabase dependency: in development the server
 * uses its local SQLite store, in production it uses Supabase Auth. Either way
 * the browser only ever talks to one origin.
 */
const TOKEN_KEY = "shipit.access_token";

let accessToken: string | null = localStorage.getItem(TOKEN_KEY);

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function authHeaders(): Promise<Record<string, string>> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body = text ? safeParse(text) : null;

  if (!response.ok) {
    throw ApiError.from(response.status, body);
  }

  return body as T;
}

export const api = {
  get: <T,>(path: string) => apiRequest<T>(path),
  post: <T,>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body }),
  patch: <T,>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", body }),
};

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
