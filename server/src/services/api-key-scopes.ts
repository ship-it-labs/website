/**
 * What an API key is allowed to do.
 *
 * A key is a credential someone pasted into a tool, so it should be able to
 * do less than the account it belongs to. The scopes are deliberately small
 * and readable, because the person choosing them is looking at a list of
 * checkboxes, not a permission matrix.
 *
 * A key with no scopes recorded has all of them. That is what makes the
 * existing OAuth-issued keys (the MCP login) keep
 * working untouched: they were minted before this table existed.
 */

export const API_KEY_SCOPE_GROUPS: Array<{
  group: string;
  scopes: Array<{ id: string; label: string; description: string }>;
}> = [
  {
    group: "Projects",
    scopes: [
      { id: "projects:read", label: "Read", description: "List projects and their details." },
      { id: "projects:write", label: "Write", description: "Upload a project or replace its source." },
    ],
  },
  {
    group: "Builds",
    scopes: [
      { id: "builds:read", label: "Read", description: "List builds and read their logs and artifacts." },
      { id: "builds:write", label: "Write", description: "Submit a build, rebuild or delete one." },
    ],
  },
  {
    group: "Runtimes",
    scopes: [
      { id: "runtimes:read", label: "Read", description: "List runtimes and read their output." },
      { id: "runtimes:write", label: "Write", description: "Start, stop and restart runtimes." },
      { id: "runtimes:exec", label: "Execute", description: "Run commands inside a runtime." },
    ],
  },
  {
    group: "Account",
    scopes: [{ id: "usage:read", label: "Read usage", description: "Read usage and quota." }],
  },
];

export const ALL_SCOPES = [
  "projects:read",
  "projects:write",
  "builds:read",
  "builds:write",
  "runtimes:read",
  "runtimes:write",
  "runtimes:exec",
  "usage:read",
] as const;

export type ApiKeyScope = (typeof ALL_SCOPES)[number];

/** Stored form: a comma separated list, or nothing at all for "everything". */
export function serializeScopes(scopes: string[] | null): string | null {
  if (!scopes) return null;
  const clean = scopes.filter((scope) => (ALL_SCOPES as readonly string[]).includes(scope));
  if (clean.length === 0) return null;
  if (clean.length === ALL_SCOPES.length) return null;
  return clean.join(",");
}

/** null means every scope: an unscoped key is a full-power key. */
export function parseScopes(raw: string | null | undefined): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const list = raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => (ALL_SCOPES as readonly string[]).includes(scope));
  if (list.length === 0) return null;
  return list;
}

/** True when a key holding `granted` may use `scope`. */
export function hasScope(granted: string[] | null, scope: string): boolean {
  if (granted === null) return true;
  return granted.includes(scope);
}
