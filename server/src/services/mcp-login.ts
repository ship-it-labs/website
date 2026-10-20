import crypto from "node:crypto";
import { publicBaseUrl } from "../config/urls.js";
import { logger } from "../utils/logger.js";

/**
 * Login sessions for the MCP server.
 *
 * The MCP server is a website endpoint, so the browser on the user's machine
 * cannot call back to it the way a local CLI does. The login therefore uses a
 * platform-hosted callback: the session's id is a 256-bit secret, the redirect
 * target is built by this server (never taken from the client), and the PKCE
 * verifier stays here, so the browser only ever carries a code that this
 * server can redeem.
 *
 * Sessions live in memory. A deploy mid-login loses the session and the user
 * simply runs login again; keeping them in the database would mean a new
 * migration for a five-minute ceremony.
 */

export const MCP_OAUTH_CLIENT_ID = "mcp";

const SESSION_TTL_MS = 10 * 60_000;

export type McpLoginStatus = "pending" | "approved" | "denied" | "expired";

export interface McpLoginSession {
  id: string;
  /** CSRF value echoed through the browser round trip. */
  state: string;
  /** PKCE proof. It never leaves this process. */
  verifier: string;
  challenge: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  status: McpLoginStatus;
  accessToken?: string;
  userId?: string;
}

const sessions = new Map<string, McpLoginSession>();

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

/** The session id encoded in a callback URL, if the URL has that shape. */
export function mcpSessionIdFromUri(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const prefix = "/mcp/login/callback/";
  if (!url.pathname.startsWith(prefix)) return null;
  const id = url.pathname.slice(prefix.length);
  return /^[A-Za-z0-9_-]{20,128}$/.test(id) ? id : null;
}

/** The callback URL for a session. Built here, never taken from a request. */
export function mcpLoginRedirectUri(sessionId: string): string {
  return `${publicBaseUrl()}/mcp/login/callback/${sessionId}`;
}

/** Starts a login and returns the session plus the URL to open. */
export function createMcpLoginSession(): {
  session: McpLoginSession;
  authorizeUrl: string;
} {
  purgeExpiredMcpLoginSessions();
  const id = crypto.randomBytes(32).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString("base64url");
  const now = Date.now();
  const session: McpLoginSession = {
    id,
    state,
    verifier,
    challenge,
    redirectUri: mcpLoginRedirectUri(id),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    status: "pending",
  };
  sessions.set(id, session);

  const url = new URL("/oauth/authorize", publicBaseUrl());
  url.searchParams.set("client_id", MCP_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", session.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { session, authorizeUrl: url.toString() };
}

export function getMcpLoginSession(id: string): McpLoginSession | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (session.status === "pending" && Date.now() > session.expiresAt) {
    session.status = "expired";
  }
  return session;
}

/** True when the redirect target is the callback this server issued. */
export function isMcpLoginRedirectUri(raw: unknown, session: McpLoginSession): boolean {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.toString() === session.redirectUri;
}

/** Records the approved token. The session is consumed by the first read. */
export function approveMcpLoginSession(
  id: string,
  accessToken: string,
  userId: string
): McpLoginSession | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  session.status = "approved";
  session.accessToken = accessToken;
  session.userId = userId;
  return session;
}

export function denyMcpLoginSession(id: string): McpLoginSession | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  session.status = "denied";
  return session;
}

/** Hands the token over once and forgets it. A second read finds nothing. */
export function consumeMcpLoginToken(
  id: string
): { accessToken: string; userId: string } | null {
  const session = sessions.get(id);
  if (!session || session.status !== "approved" || !session.accessToken) return null;
  const accessToken = session.accessToken;
  const userId = session.userId ?? "";
  session.accessToken = undefined;
  session.status = "expired";
  sessions.delete(id);
  return { accessToken, userId };
}

/** Drops sessions nobody came back for. */
export function purgeExpiredMcpLoginSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(id);
      logger.debug({ sessionId: id }, "Expired MCP login session dropped");
    }
  }
}
