import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { supabase, type Database } from "../db/index.js";
import { generateApiKey } from "../utils/api-key.js";
import { logger } from "../utils/logger.js";

/**
 * OAuth 2.0 authorization-code flow with PKCE, for the first-party OpenCode
 * plugin. There is no third-party client registration: the only client is the
 * plugin itself, and redirect targets are restricted to loopback so an
 * authorization code can only ever land on the user's own machine.
 *
 * The issued access token is a regular account API key (same generator, same
 * storage, same verification, same revocation). OAuth is the *issuance*
 * ceremony; everything downstream is unchanged, which is why the api_keys
 * table and its middleware stay live while manual key management is retired.
 */

export const OAUTH_CLIENT_ID = "opencode";
export const OAUTH_APP_NAME = "OpenCode";
const CODE_TTL_MS = 10 * 60_000;

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

/** Loopback-only redirect validation. Anything else is an exfiltration attempt. */
export function validateRedirectUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new OAuthError("INVALID_REDIRECT", "redirect_uri is required");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError("INVALID_REDIRECT", "redirect_uri is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OAuthError("INVALID_REDIRECT", "redirect_uri must be http(s)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OAuthError("INVALID_REDIRECT", "redirect_uri must not embed credentials");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
    throw new OAuthError(
      "INVALID_REDIRECT",
      "redirect_uri must point at this machine (localhost)"
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}

export function validateClientId(clientId: unknown): void {
  if (clientId !== OAUTH_CLIENT_ID) {
    throw new OAuthError("INVALID_CLIENT", "Unknown OAuth client");
  }
}

export function validateState(state: unknown): string {
  if (typeof state !== "string" || state.length === 0 || state.length > 512) {
    throw new OAuthError("INVALID_REQUEST", "state is required");
  }
  return state;
}

/** S256 only. Plaintext challenges defeat the point of PKCE. */
export function verifyPkce(verifier: unknown, challenge: string): void {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
    throw new OAuthError("INVALID_GRANT", "Bad code verifier");
  }
  const digest = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  if (digest.length !== challenge.length || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(challenge))) {
    throw new OAuthError("INVALID_GRANT", "PKCE verification failed");
  }
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export interface AuthorizeInput {
  userId: string;
  clientId: unknown;
  redirectUri: unknown;
  state: unknown;
  codeChallenge: unknown;
  codeChallengeMethod: unknown;
}

/** Validates an approval and mints a single-use code. Returns the raw code —
 * it travels out via the redirect, never in a JSON body. */
export async function createAuthCode(
  db: Database,
  input: AuthorizeInput,
  nowMs: number = Date.now()
): Promise<{ code: string }> {
  validateClientId(input.clientId);
  validateRedirectUri(input.redirectUri);
  validateState(input.state);
  if (typeof input.codeChallenge !== "string" || input.codeChallenge.length === 0) {
    throw new OAuthError("INVALID_REQUEST", "code_challenge is required");
  }
  if (input.codeChallengeMethod !== "S256") {
    throw new OAuthError("INVALID_REQUEST", "Only S256 code challenges are supported");
  }

  const code = crypto.randomBytes(32).toString("base64url");
  const { error } = await db.from("oauth_codes").insert({
    id: hashCode(code),
    user_id: input.userId,
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri as string,
    code_challenge: input.codeChallenge,
    expires_at: new Date(nowMs + CODE_TTL_MS).toISOString(),
  });
  if (error) {
    logger.error({ err: error, userId: input.userId }, "Could not store OAuth code");
    // Name the cause in the message: a missing table means the migrations
    // never ran, an RLS rejection means forced policies or a wrong key —
    // and "could not start" alone sends everyone hunting in the wrong place.
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? "";
    if (code === "42P01" || /relation .* does not exist|Could not find the table/i.test(message)) {
      throw new OAuthError(
        "SERVER_ERROR",
        "Authorization is not set up yet (database migration missing). Try again later."
      );
    }
    if (code === "42501" || /row-level security/i.test(message)) {
      throw new OAuthError(
        "SERVER_ERROR",
        "The database refused the authorization (row-level security). The operator has been notified."
      );
    }
    throw new OAuthError("SERVER_ERROR", "Could not start the authorization");
  }
  return { code };
}

export interface ExchangeInput {
  code: unknown;
  clientId: unknown;
  redirectUri: unknown;
  codeVerifier: unknown;
  nowMs?: number;
}

/** Redeems a code for an access token. Single-use: the row is deleted before
 * anything else, so a concurrent replay finds nothing. */
export async function exchangeCode(
  db: Database,
  input: ExchangeInput
): Promise<{ userId: string; accessToken: string }> {
  const nowMs = input.nowMs ?? Date.now();
  if (typeof input.code !== "string" || input.code.length === 0) {
    throw new OAuthError("INVALID_GRANT", "Authorization code is required");
  }
  validateClientId(input.clientId);

  const { data, error } = await db
    .from("oauth_codes")
    .select("user_id, redirect_uri, code_challenge, expires_at")
    .eq("id", hashCode(input.code))
    .single();

  if (error || !data) {
    throw new OAuthError("INVALID_GRANT", "Unknown or already-used authorization code");
  }
  const row = data as {
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    expires_at: string;
  };

  // Delete first: after this point a retry is a fresh authorization, never a
  // second token from one approval.
  await db.from("oauth_codes").delete().eq("id", hashCode(input.code));

  if (Number.isNaN(new Date(row.expires_at).getTime()) || new Date(row.expires_at).getTime() <= nowMs) {
    throw new OAuthError("INVALID_GRANT", "Authorization code has expired");
  }
  if (row.redirect_uri !== input.redirectUri) {
    throw new OAuthError("INVALID_GRANT", "Redirect URI mismatch");
  }
  verifyPkce(input.codeVerifier, row.code_challenge);

  const { key, hash, prefix } = generateApiKey();
  const { error: keyError } = await db.from("api_keys").insert({
    id: randomUUID(),
    user_id: row.user_id,
    key_hash: hash,
    key_prefix: prefix,
    name: "OpenCode (OAuth)",
    is_active: true,
  });
  if (keyError) {
    logger.error({ err: keyError, userId: row.user_id }, "Could not mint OAuth access token");
    throw new OAuthError("SERVER_ERROR", "Could not issue the access token");
  }
  return { userId: row.user_id, accessToken: key };
}

/** Sweeps expired codes. Best-effort hygiene; expiry is enforced on read. */
export async function purgeExpiredCodes(db: Database = supabase): Promise<void> {
  try {
    // The shim has no "less than" path worth relying on across drivers for
    // this; expired rows are tiny and self-limiting (10-minute TTL), so a
    // periodic full scan that deletes the dead ones is plenty.
    const { data } = await db.from("oauth_codes").select("id, expires_at").limit(1000);
    const now = Date.now();
    for (const row of (data ?? []) as { id: string; expires_at: string }[]) {
      if (new Date(row.expires_at).getTime() <= now) {
        await db.from("oauth_codes").delete().eq("id", row.id);
      }
    }
  } catch (err) {
    logger.warn({ err }, "OAuth code purge failed");
  }
}
