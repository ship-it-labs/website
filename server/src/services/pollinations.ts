import { logger } from "../utils/logger.js";

/**
 * Thin wrapper over the Pollinations OpenAI-compatible text API, shared by the
 * in-site assistant and the `pnpm verify` failure summariser.
 *
 * Two realities shape it. First, the configured primary model may not be
 * affordable on the account's current pollen balance: Pollinations answers
 * those with HTTP 200 and a short "doesn't have enough credits" sentence rather
 * than an error, so a body that reads like a billing notice is treated as a
 * failure and the next model in the chain is tried. Second, the providers that
 * support prompt caching (Gemini, Claude, Nova) want their static prefix
 * wrapped in an explicit cache marker; models that do not understand the marker
 * get the plain concatenated text instead, so nothing is ever sent a field it
 * may reject.
 */

const BASE_URL = (process.env.POLLINATIONS_BASE_URL || "https://gen.pollinations.ai").replace(
  /\/+$/,
  ""
);
const API_KEY = (process.env.POLLINATIONS_API_KEY || "").trim();
const TIMEOUT_MS = Number(process.env.POLLINATIONS_TIMEOUT_MS || 45_000);

const CACHEABLE = /gemini|claude|nova|anthropic/i;

/** Markers that mean "this body is a billing notice, not an answer". */
const LOW_BALANCE = [
  "have enough credits",
  "needs paid pollen",
  "insufficient credits",
  "no credits",
  "pollen balance",
];

export const PRIMARY_MODEL = process.env.POLLINATIONS_MODEL || "qwen/qwen3.7-flash";

export const FALLBACK_MODELS = (process.env.POLLINATIONS_FALLBACK_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

/** The primary first, then the fallbacks, without duplicates. */
export function agentModels(): string[] {
  const seen = new Set<string>();
  for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
    if (model) seen.add(model);
  }
  return [...seen];
}

/** True when a key is configured; without one every entry point degrades. */
export function agentEnabled(): boolean {
  return API_KEY.length > 0;
}

export interface SystemPart {
  /** Large, byte-stable text that providers may cache between calls. */
  cachePrefix?: string;
  /** Per-request text appended after the cache boundary. */
  content: string;
}

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Only meaningful on a system message; see SystemPart. */
  cachePrefix?: string;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface AgentReply {
  text: string;
  model: string;
  toolCalls: AgentToolCall[];
  usage: AgentUsage;
  finishReason: string | null;
}

export class AgentUnavailableError extends Error {
  readonly lowBalance: boolean;
  readonly attempts: number;

  constructor(message: string, lowBalance: boolean, attempts: number) {
    super(message);
    this.name = "AgentUnavailableError";
    this.lowBalance = lowBalance;
    this.attempts = attempts;
  }
}

type Attempt =
  | { ok: true; reply: AgentReply }
  | { ok: false; kind: "low_balance" | "http" | "network" | "empty"; status: number; message: string };

function looksLowBalance(text: string): boolean {
  const lower = text.toLowerCase();
  return LOW_BALANCE.some((marker) => lower.includes(marker));
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function errorText(body: Record<string, unknown> | null, fallback: string): string {
  const error = body?.error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}

/** Builds the wire messages, marking the cache boundary only when supported. */
function toWire(messages: AgentMessage[], cacheable: boolean): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "system" && message.cachePrefix) {
      if (cacheable) {
        return {
          role: "system",
          content: [
            { type: "text", text: message.cachePrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: message.content },
          ],
        };
      }
      return { role: "system", content: `${message.cachePrefix}\n\n${message.content}` };
    }

    const wire: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
    if (message.tool_calls) wire.tool_calls = message.tool_calls;
    if (message.name) wire.name = message.name;
    return wire;
  });
}

async function callModel(
  model: string,
  messages: AgentMessage[],
  tools: ToolDefinition[]
): Promise<Attempt> {
  const body: Record<string, unknown> = {
    model,
    messages: toWire(messages, CACHEABLE.test(model)),
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    const data = raw ? safeJson(raw) : null;

    if (!response.ok) {
      return {
        ok: false,
        kind: "http",
        status: response.status,
        message: errorText(data, raw.slice(0, 300) || `HTTP ${response.status}`),
      };
    }

    const choices = data?.choices;
    const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown>) : null;
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const text = typeof message.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as AgentToolCall[])
      : [];

    // A 200 that reads like a billing notice is not an answer. Only treat it as
    // one when no tool calls came back, so a model that merely mentions credits
    // in a real answer is not discarded.
    if (toolCalls.length === 0 && looksLowBalance(text)) {
      return { ok: false, kind: "low_balance", status: 200, message: text.trim().slice(0, 200) };
    }

    if (!text && toolCalls.length === 0) {
      return { ok: false, kind: "empty", status: 200, message: "Model returned no content" };
    }

    const usage = (data?.usage ?? {}) as Record<string, unknown>;
    const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
    const reply: AgentReply = {
      text,
      model,
      toolCalls,
      usage: {
        promptTokens: Number(usage.prompt_tokens ?? 0),
        completionTokens: Number(usage.completion_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
        cachedTokens: Number(details.cached_tokens ?? 0),
      },
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    };
    return { ok: true, reply };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "network", status: 0, message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a chat completion, trying each model in `agentModels()` until one
 * answers with real content. Throws AgentUnavailableError when every model
 * fails, carrying whether the cause was a credit shortfall so the caller can
 * tell the user something actionable.
 */
export async function chatCompletion(
  messages: AgentMessage[],
  options: { tools?: ToolDefinition[] } = {}
): Promise<AgentReply> {
  if (!agentEnabled()) {
    throw new AgentUnavailableError("No Pollinations API key is configured.", false, 0);
  }

  const tools = options.tools ?? [];
  const models = agentModels();
  const failures: string[] = [];
  let sawLowBalance = false;

  for (const model of models) {
    const attempt = await callModel(model, messages, tools);
    if (attempt.ok) {
      if (failures.length > 0) {
        logger.info({ model, failures }, "Pollinations answered after fallback");
      }
      return attempt.reply;
    }

    if (attempt.kind === "low_balance") sawLowBalance = true;
    failures.push(`${model}: ${attempt.message}`);
    logger.warn(
      { model, kind: attempt.kind, status: attempt.status, message: attempt.message },
      "Pollinations model failed; trying next"
    );
  }

  throw new AgentUnavailableError(
    failures.join(" | ") || "No model responded.",
    sawLowBalance,
    attemptsCount(models)
  );
}

function attemptsCount(models: string[]): number {
  return models.length;
}
