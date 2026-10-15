/**
 * Server-agent object-store URL helpers, shared by the upload finalize path
 * (which mints these URLs) and the build/runtime paths (which must recognize
 * them and skip Supabase signing). Kept here rather than in either service so
 * neither imports the other.
 */

/** Fetch URL for an agent-stored object: key + HMAC ticket in query, no
 * secret anywhere. Long-lived by design (tickets don't expire); runtime
 * starters GET it days after upload and verify the sha on arrival. */
export function agentStoreUrl(agentUrl: string, key: string, ticket: string): string {
  const base = agentUrl.replace(/\/+$/, "");
  return `${base}/internal/store/get/${encodeURIComponent(key)}?ticket=${encodeURIComponent(ticket)}`;
}

/** True when a stored upload_url already points at an agent store rather than
 * Supabase. Such URLs must be used as-is: there is nothing to re-sign, and a
 * Supabase sign call on an agent key fails noisily before falling back. */
export function isAgentStoreUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.includes("/internal/store/get/");
}
