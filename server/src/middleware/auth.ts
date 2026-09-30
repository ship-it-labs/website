import { FastifyRequest, FastifyReply } from "fastify";
import { supabase } from "../db/index.js";
import { hashApiKey } from "../utils/api-key.js";
import type { Plan, AuthenticatedRequest } from "../types/index.js";
import { logger } from "../utils/logger.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedRequest;
  }
}

function isApiKey(token: string): boolean {
  return token.startsWith("ox_live_") || token.startsWith("ox_test_");
}

/**
 * Resolves the user id for a bearer token. Two credential types are accepted:
 * a long-lived account API key, which the OpenCode plugin uses, and a session
 * token issued by login, which the dashboard uses. Both end up on the same user
 * row so the AI and the human see the same account and quota.
 */
async function resolveUserId(token: string): Promise<string | null> {
  if (isApiKey(token)) {
    const { data } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("key_hash", hashApiKey(token))
      .single();

    return data?.is_active ? data.user_id : null;
  }

  // Session token. Only the local SQLite driver issues these.
  const local = supabase as { getUserIdForToken?: (token: string) => string | null };
  return local.getUserIdForToken?.(token) ?? null;
}

export async function authenticateApiKey(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Missing credentials" } });
    return;
  }

  const token = authHeader.slice(7);
  const userId = await resolveUserId(token);

  if (!userId) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } });
    return;
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, plan_id")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "User not found" } });
    return;
  }

  const { data: plan, error: planError } = await supabase
    .from("plans")
    .select("*")
    .eq("id", user.plan_id)
    .single();

  if (planError || !plan) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Plan not found" } });
    return;
  }

  if (isApiKey(token)) {
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("key_hash", hashApiKey(token));
  }

  req.auth = { userId: user.id, plan: plan as Plan, apiKeyId: "" };

  logger.debug({ userId: user.id }, "Request authenticated");
}
