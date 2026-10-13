import { api } from "@/lib/api";

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

  report: (summary: string, details: string, severity: "low" | "normal" | "high" = "normal") =>
    api.post<{ success: boolean }>("/api/v1/agent/report", { summary, details, severity }),
};

export function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}
