/**
 * The control plane talks to Supabase with the service-role key, which
 * bypasses row level security: the server is the trusted backend, not an
 * end-user client. An anon key in SUPABASE_SERVICE_ROLE_KEY boots fine and
 * then fails every write with 42501 while reads can still pass — the exact
 * shape that once broke every login with SESSION_REVOKED and no trace of why.
 * Decoding the role claim at boot turns that silent misconfiguration into a
 * loud startup failure. Signature is not verified: this checks identity of
 * configuration, not authenticity of the token.
 */
export function serviceRoleOf(key: string): string | null {
  const parts = key.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(payload);
    const role = (parsed as { role?: unknown } | null)?.role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

export function assertServiceRoleKey(key: string): void {
  if (serviceRoleOf(key) !== "service_role") {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY does not carry the service_role claim. " +
        "Using the anon key here boots but fails every database write with row " +
        "level security errors. Copy the service_role key from Supabase project " +
        "settings into this variable."
    );
  }
}
