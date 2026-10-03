import { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
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

/**
 * Expiry arrives as either a number of days or an absolute date, because the
 * form offers presets ("30 days") and dates ("2027-03-01") interchangeably.
 * Anything in the past is rejected: a key that is already dead on arrival only
 * confuses, and silently clamping it to "never" would lie about what was asked.
 */
const expirySchema = z
  .union([
    z.object({ expires_in_days: z.number().int().min(1).max(3650) }),
    z.object({ expires_at: z.string().datetime() }),
  ])
  .optional();

const createSchema = z.object({
  name: z.string().trim().min(1).max(64).default(""),
  expires: expirySchema,
});

export function expiryToTimestamp(
  expires: z.infer<typeof expirySchema>
): string | null {
  if (!expires) return null;

  if ("expires_in_days" in expires) {
    return new Date(
      Date.now() + expires.expires_in_days * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  const at = new Date(expires.expires_at).getTime();
  if (Number.isNaN(at) || at <= Date.now()) return null;
  return new Date(at).toISOString();
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticateApiKey);

  app.get("/api-keys", async (req, reply) => {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, key_prefix, name, is_active, created_at, last_used_at, expires_at")
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false });

    if (error) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to list keys" } });
    }

    return reply.send({ api_keys: data });
  });

  app.post("/api-keys", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid key details" },
      });
    }

    const { key, hash, prefix } = generateApiKey();
    const name = parsed.data.name || `key_${Date.now()}`;
    const expiresAt = expiryToTimestamp(parsed.data.expires);

    // A past date is a caller error, not a silent "never": creating a dead key
    // and reporting success would be worse than refusing.
    if (parsed.data.expires && "expires_at" in parsed.data.expires && !expiresAt) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "The expiration date must be in the future" },
      });
    }

    const { error } = await supabase.from("api_keys").insert({
      id: randomUUID(),
      user_id: req.auth!.userId,
      key_hash: hash,
      key_prefix: prefix,
      name,
      is_active: true,
      expires_at: expiresAt,
    });

    if (error) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to create key" } });
    }

    logger.info({ userId: req.auth!.userId }, "API key created");

    return reply.status(201).send({
      api_key: key,
      key_prefix: prefix,
      name,
      expires_at: expiresAt,
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

    // Revoking the key in use ends the caller's session with this request.
    // Saying so lets the UI sign out cleanly instead of failing its next load
    // with a bare 401 that looks like the revoke itself broke.
    return reply.send({ success: true, revoked_own_key: req.auth!.apiKeyId === id });
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

    // Rotating the key in use invalidates the caller's own bearer token.
    // Handing the replacement back as the session token keeps the page working
    // instead of dropping it into a signed-out error state.
    return reply.send({
      api_key: key,
      key_prefix: prefix,
      rotated_own_key: req.auth!.apiKeyId === id,
    });
  });
}
