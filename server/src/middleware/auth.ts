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
 *
 * Returns the key row too, because rotating or revoking the key the caller is
 * holding needs to be treated differently from touching any other key: the
 * first kills the session that made the request.
 */
async function resolveUserId(
  token: string
): Promise<{ userId: string; apiKeyId: string } | null> {
  if (isApiKey(token)) {
    const { data } = await supabase
      .from("api_keys")
      .select("id, user_id, is_active, expires_at")
      .eq("key_hash", hashApiKey(token))
      .single();

    if (!data?.is_active) return null;

    // An expired key is not an invalid key. Saying so would send someone
    // re-checking a token they know is typed correctly.
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
      return null;
    }

    return { userId: data.user_id as string, apiKeyId: data.id as string };
  }

  // Session token. The local SQLite driver resolves its own opaque tokens; in
  // production the token is a Supabase Auth JWT, validated against the Auth
  // API. Without the second path the dashboard login works locally and 401s
  // on every single request in production, which reads as "invalid
  // credentials" no matter how correctly the user logged in.
  const local = supabase as { getUserIdForToken?: (token: string) => string | null };
  const localUserId = local.getUserIdForToken?.(token) ?? null;
  if (localUserId) return { userId: localUserId, apiKeyId: "" };

  const auth = supabase.auth as unknown as {
    getUser?: (token: string) => Promise<{ data: { user: { id: string } | null } }>;
  };
  if (typeof auth.getUser !== "function") return null;

  try {
    const { data } = await auth.getUser(token);
    const id = data?.user?.id;
    return id ? { userId: id, apiKeyId: "" } : null;
  } catch {
    return null;
  }
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
  const resolved = await resolveUserId(token);

  if (!resolved) {
    const expired = await isExpiredKey(token);
    reply.status(401).send({
      error: {
        code: expired ? "KEY_EXPIRED" : "UNAUTHORIZED",
        message: expired
          ? "This API key has expired. Create a new one."
          : "Invalid credentials",
      },
    });
    return;
  }

  const userId = resolved.userId;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, plan_id, is_active")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "User not found" } });
    return;
  }

  // Disabled by an admin. A 403 rather than 401: the credentials are valid,
  // the account is not, and conflating the two sends people to reset a
  // password that was never the problem.
  if (user.is_active === false || user.is_active === 0) {
    reply.status(403).send({
      error: {
        code: "ACCOUNT_DISABLED",
        message: "This account has been disabled. Contact support.",
      },
    });
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

  req.auth = { userId: user.id, plan: plan as Plan, apiKeyId: resolved.apiKeyId };

  logger.debug({ userId: user.id }, "Request authenticated");
}

/**
 * Distinguishes an expired key from a wrong one for the error message above.
 * Runs only after authentication already failed, so a second lookup here costs
 * nothing on the path that matters.
 */
async function isExpiredKey(token: string): Promise<boolean> {
  if (!token.startsWith("ox_live_") && !token.startsWith("ox_test_")) {
    return false;
  }

  const { data } = await supabase
    .from("api_keys")
    .select("is_active, expires_at")
    .eq("key_hash", hashApiKey(token))
    .single();

  return Boolean(
    data?.is_active &&
      data?.expires_at &&
      new Date(data.expires_at as string).getTime() <= Date.now()
  );
}
