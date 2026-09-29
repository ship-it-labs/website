const VITE_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const VITE_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY);

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

let accessTokenProvider: () => Promise<string | null> = async () => null;

export function setAccessTokenProvider(provider: () => Promise<string | null>) {
  accessTokenProvider = provider;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessTokenProvider();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
  };

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
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
