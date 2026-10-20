/**
 * The assistant's offline knowledge about Ship-It itself: how the platform
 * works, what each plan allows, and what the common errors mean. It is written
 * as static text on purpose — it is the byte-stable prefix the prompt cache
 * keys on, so it must not change between calls. Bump DOCS_VERSION whenever a
 * section is edited so cached answers from the old text stop being served.
 */

export const DOCS_VERSION = "2026-10-12.1";

export interface DocSection {
  id: string;
  title: string;
  body: string;
}

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "overview",
    title: "What Ship-It is",
    body: `Ship-It turns a repository or an uploaded folder into a running app. You upload a project (or point at a git repo), Ship-It builds it in CI, and you get build logs, artifacts and a runnable URL. It is aimed at small Node/Python/Go projects and static sites.

The dashboard has five areas: Projects (upload and configure), Builds (history, logs, artifacts), Runtimes (live sessions with a public URL), Billing (plan and invoices), and Settings (profile, API keys, sessions).`,
  },
  {
    id: "projects",
    title: "Creating a project and uploading code",
    body: `Create a project from the dashboard, then upload a zip of the source (or connect a git repo). Uploads skip node_modules, build output and VCS folders automatically. After upload you can set the run command and, for private configuration, encrypted environment variables.

A project records the language, file count and size. Re-uploading replaces the source. You can rebuild at any time from the project page.`,
  },
  {
    id: "builds",
    title: "Builds and logs",
    body: `A build runs install, then build, then test commands on a runner with a hard timeout (180s on Free, longer on paid plans). Each build is one of: pending, running, success, failure or timeout.

Logs stream live and are kept with the build. Artifacts produced by the build are listed with a SHA-256 and size and can be downloaded. A failed build never bills runtime quota.

If a build says "create build failed" or returns 500, it is usually a server-side problem rather than your code: check the build log, then retry.`,
  },
  {
    id: "runtimes",
    title: "Runtimes and sessions",
    body: `Starting a runtime boots your app in a sandbox and gives you a public URL. Runtimes have a lease and a maximum session length that depends on your plan; when the lease expires the sandbox is destroyed. Only one runtime per project at a time.

If a runtime will not start, check that the project's run command is correct and that required environment variables are set. Runtime time is what counts against your monthly quota, measured in hours.`,
  },
  {
    id: "plans",
    title: "Plans, pricing and quotas",
    body: `Free: 10 runtime hours/month, up to 3-hour sessions, 1 concurrent runtime, 180s build timeout, $0.
Pro: 250 runtime hours/month, up to 6-hour sessions, 3 concurrent runtimes, 300s build timeout, $9/month.
Ultra: 1000 runtime hours/month, up to 24-hour sessions, 5 concurrent runtimes, 600s build timeout, $19/month.

Quota is measured in runtime hours used in the current billing period. The Billing page shows the current plan, usage and how much is left. Upgrades apply immediately; after checkout the plan refreshes within a few seconds.`,
  },
  {
    id: "billing",
    title: "Billing, checkout and cancellations",
    body: `Billing is handled by Whop. Upgrading opens a secure checkout; on success your plan updates automatically and the Billing page confirms it. If it still shows the old plan right after paying, wait a few seconds and use "Check again" — the webhook may still be arriving.

Cancelling keeps your plan until the end of the current period, then reverts to Free. To change plans, pick the new plan and confirm; Paddle-style proration is not used — Whop applies the change at the next cycle.`,
  },
  {
    id: "api-keys",
    title: "API keys and the MCP server",
    body: `Create account API keys in the dashboard's API keys tab. A key starts with ox_live_ (production) or ox_test_ (development) and is shown once — store it safely. Every key can be given a name, an expiry, a set of permissions and a budget of runtime minutes, and can be rotated or revoked; revoking kills any session using that key.

The MCP server is how AI clients connect. Point a client at /mcp, then ask the agent to log in: it calls the login tool, which opens a page in your browser where you sign in and approve, and the agent receives an access token it keeps to itself. The server's tools cover projects, builds, runtimes, usage and this documentation, and every one of them runs with the caller's own permissions.`,
  },
  {
    id: "errors",
    title: "Common errors and what they mean",
    body: `42501 / "row-level security" on a write: a server-side permissions problem, not your fault — report it.
PGRST205 / "could not find the table": the database is missing a migration; report it.
RATE_LIMITED / 429: too many requests from your address; wait for the retry window.
401 SESSION_REVOKED or KEY_EXPIRED: your session or key was revoked or expired; sign in again.
BUILD_TIMEOUT: the build exceeded the plan's timeout; reduce install/build work or upgrade.
"does not have enough credits": an internal model-credit issue; report it.`,
  },
  {
    id: "support",
    title: "Reporting a problem",
    body: `If something looks broken, the fastest route is to describe it to this assistant and ask it to report the problem — it files a ticket directly for the Ship-It team, attached to your account. Include what you were doing, what you expected, and any error text or request id you saw. For anything billing-related, also mention the amount and the date.`,
  },
];

/** The full knowledge base, concatenated for the cached system prefix. */
export function docsDigest(): string {
  return DOC_SECTIONS.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
}

/** Common words that would otherwise match everything and drown the signal. */
const STOPWORDS = new Set([
  "the", "and", "for", "what", "how", "does", "did", "with", "that", "this",
  "you", "your", "are", "was", "were", "not", "but", "can", "could", "all",
  "out", "why", "when", "which", "into", "from", "have", "has", "had", "about",
  "its", "it", "is", "do", "of", "to", "in", "on", "my", "me", "we", "our",
  "get", "got", "use", "using", "there", "here", "then", "than", "them", "they",
  "much", "many", "any", "one", "two", "who", "where", "will", "would", "should",
]);

/**
 * Keyword search over the sections, cheapest-first: a term in the title beats a
 * term in the body. Stopwords are dropped so a phrasing like "how much do the
 * plans cost" scores on "plans" and "cost", not on "the". Returns the best
 * `limit` sections, or the overview when nothing matches so a tool call never
 * comes back empty.
 */
export function searchDocs(query: string, limit = 3): DocSection[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((term) => term.length > 2 && !STOPWORDS.has(term))
    ),
  ];

  if (terms.length === 0) return DOC_SECTIONS.slice(0, 1);

  const scored = DOC_SECTIONS.map((section) => {
    const title = section.title.toLowerCase();
    const body = section.body.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      if (body.includes(term)) score += 1;
    }
    return { section, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return DOC_SECTIONS.slice(0, 1);
  return scored.slice(0, limit).map((entry) => entry.section);
}
