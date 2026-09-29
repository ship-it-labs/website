import { FastifyRequest, FastifyReply } from "fastify";
import { supabase } from "../db/client.js";
import { hashApiKey } from "../utils/api-key.js";
import { Plan, AuthenticatedRequest } from "../types/index.js";
import { logger } from "../utils/logger.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedRequest;
  }
}

export async function authenticateApiKey(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Missing API key" } });
    return;
  }

  const key = authHeader.slice(7);
  const keyHash = hashApiKey(key);

  const { data: apiKey, error } = await supabase
    .from("api_keys")
    .select("id, user_id, is_active")
    .eq("key_hash", keyHash)
    .single();

  if (error || !apiKey) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
    return;
  }

  if (!apiKey.is_active) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "API key revoked" } });
    return;
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, plan_id")
    .eq("id", apiKey.user_id)
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

  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", apiKey.id);

  req.auth = {
    userId: user.id,
    plan: plan as Plan,
    apiKeyId: apiKey.id,
  };

  logger.debug({ userId: user.id }, "Request authenticated");
}
