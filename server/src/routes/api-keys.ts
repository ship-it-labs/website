import { FastifyInstance } from "fastify";
import { supabase } from "../db/index.js";
import { generateApiKey } from "../utils/api-key.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";

/**
 * Registered under /api/v1 on its own. It used to live in apiKeyRoutes, whose
 * prefix already ended in /account, so it was only reachable at
 * /api/v1/account/account and a page reload dropped the session.
 */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  // Lets the browser restore a session on reload and confirm the token is live.
  app.get("/account", async (req, reply) => {
    const { data, error } = await supabase
      .from("users")
      .select("id, email, plan_id")
      .eq("id", req.auth!.userId)
      .single();

    if (error || !data) {
      return reply.status(404).send({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    }

    return reply.send({ user: data, plan: req.auth!.plan });
  });
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.get("/api-keys", async (req, reply) => {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, key_prefix, name, is_active, created_at, last_used_at")
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false });

    if (error) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to list keys" } });
    }

    return reply.send({ api_keys: data });
  });

  app.post("/api-keys", async (req, reply) => {
    const { name } = req.body as { name?: string };
    const { key, hash, prefix } = generateApiKey();

    const { error } = await supabase.from("api_keys").insert({
      user_id: req.auth!.userId,
      key_hash: hash,
      key_prefix: prefix,
      name: name || `key_${Date.now()}`,
      is_active: true,
    });

    if (error) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to create key" } });
    }

    logger.info({ userId: req.auth!.userId }, "API key created");

    return reply.status(201).send({
      api_key: key,
      key_prefix: prefix,
      name: name || `key_${Date.now()}`,
    });
  });

  app.post("/api-keys/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };

    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: false })
      .eq("id", id)
      .eq("user_id", req.auth!.userId);

    if (error) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to revoke key" } });
    }

    logger.info({ userId: req.auth!.userId, keyId: id }, "API key revoked");

    return reply.send({ success: true });
  });

  app.post("/api-keys/:id/rotate", async (req, reply) => {
    const { id } = req.params as { id: string };

    const { data: oldKey } = await supabase
      .from("api_keys")
      .select("id")
      .eq("id", id)
      .eq("user_id", req.auth!.userId)
      .single();

    if (!oldKey) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Key not found" } });
    }

    const { key, hash, prefix } = generateApiKey();

    const { error } = await supabase
      .from("api_keys")
      .update({ key_hash: hash, key_prefix: prefix })
      .eq("id", id);

    if (error) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to rotate key" } });
    }

    logger.info({ userId: req.auth!.userId, keyId: id }, "API key rotated");

    return reply.send({ api_key: key, key_prefix: prefix });
  });
}
