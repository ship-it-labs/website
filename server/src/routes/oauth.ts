import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { supabase } from "../db/index.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { checkRateLimit } from "../services/rate-limit.js";
import {
  OAuthError,
  OAUTH_APP_NAME,
  validateRedirectUri,
  createAuthCode,
  exchangeCode,
} from "../services/oauth.js";
import { logger } from "../utils/logger.js";

/**
 * OAuth 2.0 authorization-code + PKCE endpoints for the first-party OpenCode
 * plugin. The plugin opens the authorize page in the user's browser, the user
 * approves, the browser returns a one-time code to the plugin's loopback
 * server, and the plugin exchanges it for an access token (a regular account
 * API key under the hood).
 */

function oauthError(reply: FastifyReply, err: unknown) {
  if (err instanceof OAuthError) {
    const status =
      err.code === "INVALID_CLIENT" || err.code === "INVALID_REDIRECT" || err.code === "INVALID_REQUEST"
        ? 400
        : err.code === "INVALID_GRANT"
          ? 400
          : 500;
    return reply.status(status).send({
      error: { code: err.code, message: err.message },
    });
  }
  throw err;
}

function redirectWith(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

const decisionSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  response_type: z.string(),
  state: z.string().min(1).max(512),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string(),
  action: z.enum(["approve", "deny"]),
});

const tokenSchema = z.object({
  grant_type: z.string(),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_verifier: z.string().min(1),
  client_id: z.string().min(1),
});

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // Authenticated: only a signed-in user can approve access to their account.
  // Works with session tokens and API keys alike.
  app.post("/oauth/decision", { preHandler: authenticateApiKey }, async (req, reply) => {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid request" },
      });
    }
    const body = parsed.data;

    if (body.response_type !== "code") {
      return reply.status(400).send({
        error: { code: "UNSUPPORTED_RESPONSE_TYPE", message: "Only the authorization code flow is supported" },
      });
    }

    // The redirect target is untrusted input: validate before ever sending
    // the user (or an error) back to it. Validation failures answer in JSON,
    // never via redirect, so a crafted URI cannot launder our messages.
    let redirect: string;
    try {
      redirect = validateRedirectUri(body.redirect_uri);
    } catch (err) {
      return oauthError(reply, err);
    }

    if (body.action === "deny") {
      return reply.send({
        redirect_to: redirectWith(redirect, { error: "access_denied", state: body.state }),
      });
    }

    try {
      const { code } = await createAuthCode(supabase, {
        userId: req.auth!.userId,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        state: body.state,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      });
      logger.info({ userId: req.auth!.userId, app: OAUTH_APP_NAME }, "OAuth authorization approved");
      return reply.send({
        redirect_to: redirectWith(redirect, { code, state: body.state }),
      });
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  // Public: the code (plus PKCE proof) is the entire credential here, so this
  // endpoint is rate-limited like other credential-bearing routes.
  app.post("/oauth/token", async (req, reply) => {
    const parsed = tokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid request" },
      });
    }
    const body = parsed.data;

    if (body.grant_type !== "authorization_code") {
      return reply.status(400).send({
        error: { code: "UNSUPPORTED_GRANT_TYPE", message: "Only authorization_code is supported" },
      });
    }

    const limit = checkRateLimit(`oauth:token:${req.ip}`, 20, 60_000);
    if (!limit.allowed) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many attempts. Wait a moment and try again.",
          retry_after_seconds: limit.retryAfterSeconds,
        },
      });
    }

    try {
      const { accessToken } = await exchangeCode(supabase, {
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });
      return reply.send({ access_token: accessToken, token_type: "Bearer" });
    } catch (err) {
      return oauthError(reply, err);
    }
  });
}
