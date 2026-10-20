import { api, ApiError, getAccessToken } from "@/lib/api";

/**
 * Browser client for the in-site assistant. Everything here is authenticated by
 * the ambient access token (`api` attaches it), and the server scopes every
 * read to that account, so no conversation id from another user can be opened.
 */

export interface AgentStatus {
  enabled: boolean;
  models: string[];
}

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  cacheHit: boolean;
  createdAt: string;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface AgentCredits {
  planId: string;
  unlimited: boolean;
  limitCredits: number;
  usedCredits: number;
  remainingCredits: number;
  inputTokens: number;
  outputTokens: number;
  allowed: boolean;
  reason: "ok" | "free" | "exhausted";
}

export interface AgentTurn {
  conversationId: string;
  reply: string;
  model: string;
  cacheHit: boolean;
  usage: AgentUsage;
  credits: AgentCredits;
}

export const agentApi = {
  status: () => api.get<AgentStatus>("/api/v1/agent/status"),

  credits: () =>
    api.get<{ enabled: boolean; credits: AgentCredits }>("/api/v1/agent/credits"),

  conversations: () =>
    api.get<{ conversations: AgentConversation[] }>("/api/v1/agent/conversations"),

  conversation: (id: string) =>
    api.get<{ id: string; title: string; messages: AgentMessage[] }>(
      `/api/v1/agent/conversations/${id}`
    ),

  remove: (id: string) => api.del<{ success: boolean }>(`/api/v1/agent/conversations/${id}`),

  send: (message: string, conversationId: string | null) =>
    api.post<AgentTurn>("/api/v1/agent/messages", {
      message,
      conversation_id: conversationId,
    }),

  /**
   * The same turn, streamed: `onDelta` is called with each fragment of the
   * answer as it is written, and the finished turn arrives at the end.
   *
   * This is a raw fetch rather than the `api` helper because the response is
   * an event stream, not a JSON body — but the credential and the error
   * handling are the same.
   */
  async sendStream(
    message: string,
    conversationId: string | null,
    onDelta: (fragment: string) => void
  ): Promise<AgentTurn> {
    const response = await fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api/v1/agent/messages/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      },
      body: JSON.stringify({ message, conversation_id: conversationId }),
    });

    if (!response.ok) {
      // The server refused before it started streaming: the same JSON error
      // shape as every other endpoint.
      const text = await response.text();
      throw ApiError.from(response.status, parseJson(text));
    }
    if (!response.body) {
      throw new ApiError(500, "NO_STREAM", "The assistant did not answer");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let turn: AgentTurn | null = null;
    let failure: { code: string; message: string } | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = "message";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        const parsed = parseJson(data);
        if (parsed === null) continue;
        if (event === "delta") {
          const text = (parsed as { text?: string }).text ?? "";
          if (text) onDelta(text);
        } else if (event === "done") {
          turn = parsed as AgentTurn;
        } else if (event === "error") {
          const failureBody = parsed as { code?: string; message?: string };
          failure = {
            code: failureBody.code ?? "INTERNAL_ERROR",
            message: failureBody.message ?? "The assistant could not answer",
          };
        }
        split = buffer.indexOf("\n\n");
      }
    }

    if (failure) {
      throw new ApiError(500, failure.code, failure.message);
    }
    if (!turn) {
      throw new ApiError(500, "NO_STREAM", "The assistant did not answer");
    }
    return turn;
  },

  report: (summary: string, details: string, severity: "low" | "normal" | "high" = "normal") =>
    api.post<{ success: boolean }>("/api/v1/agent/report", { summary, details, severity }),
};

export function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** JSON that may not be JSON: an event stream carries a data line per event. */
function parseJson(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
