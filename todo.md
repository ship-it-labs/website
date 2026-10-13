# Ship-It — Master TODO & Work Log

_Last updated: 2026-10-13. Owner: ymonz. This file is the single source of truth for
what's done, what's in flight, and what's broken. Update the "Last updated" line and the
relevant section whenever you finish something._

---

## 0. NEW PRIORITY BUGS (added this session — fix first)

### BUG-A — `502 NO_CAPACITY: agent unreachable` when starting a runtime
- **Symptom:** Starting a runtime returns **502 `NO_CAPACITY: agent unreachable`**.
- **Server log / cause:** the control plane is dialing a **local** agent:
  ```
  agent unreachable: Post "http://127.0.0.1:10000/internal/runtime/start":
  dial tcp 127.0.0.1:10000: connect: connection refused
  ```
- **Context:** the server-agent is actually deployed at
  `https://server-agent1-ship-it.onrender.com`. The orchestrator/control plane is
  falling back to `127.0.0.1:10000` instead of the Render URL.
- **Where to look:**
  - `server/src/services/orchestrator-client.ts` — base URL selection / fallback to localhost.
  - `server/src/services/diagnostics.ts` — "agent unreachable" message + which URL it used.
  - Env: `AGENT_URL` / `SERVER_AGENT_URL` / agent registry (`server_agents` table,
    `server/src/routes/admin.ts` agent section) — the **runtime env overrides** system
    (`env_overrides`, `services/runtime-env.ts`, `loadEnvOverrides`) may hold a stale
    `AGENT_URL=http://127.0.0.1:10000` for **production** and override the correct value.
  - `server/src/config/urls.ts` — `internalBaseUrl()` / agent URL derivation.
- **Hypotheses to check, in order:**
  1. `env_overrides` row for `AGENT_URL` in `environment='production'` set to
     `http://127.0.0.1:10000` → correct it in the admin panel or SQL, then update.
  2. Render env var `AGENT_URL` (or `SERVER_AGENT_URL`) missing/typo → set to
     `https://server-agent1-ship-it.onrender.com`.
  3. Agent registered in `server_agents` with `url='http://127.0.0.1:10000'` → update row.
  4. Hard-coded localhost fallback in `orchestrator-client.ts` → remove; fail loudly instead.
- **Acceptance:** starting a runtime from the dashboard reaches the Render agent and boots;
  no `127.0.0.1:10000` appears in logs.

### BUG-B — Build finished in GitHub Actions but UI/tools still say "running"
- **Symptom:** GitHub Actions workflow has **completed (success/failure)**, but the
  Ship-It dashboard and the plugin/tools still show the build as **`running`**
  (and it never flips to success/failure/timeout).
- **Likely cause:** the **build report webhook back from GitHub Actions** is not reaching
  the control plane, or is being rejected, so the poller never marks the build terminal.
- **Where to look:**
  - `server/src/routes/build-reports.ts` — the endpoint GitHub Actions calls back
    (`/api/v1/build-reports`) + shared-secret check.
  - `server/src/services/build-service.ts` — `createBuild`, status transitions,
    `workflow_run_id` storage.
  - `server/src/services/build-poller.ts` (a.k.a. poller) — fallback that polls GitHub
    for `workflow_run` status; is it enabled/running in prod? Is the GitHub token/PAT valid?
  - `server/src/services/build-executor.ts` — which executor ("github" vs "runtime") ran.
  - `server/src/services/build-service.ts` callback base URL — must be the **public**
    Render URL, not `localhost`. Check `server/src/config/urls.ts` `publicBaseUrl()` and the
    generated workflow `install/build/test` commands that `curl` the report back.
  - Workflow file generated for the repo: confirm the `SHIPIT_BUILD_REPORT_URL` points at
    production and the shared secret matches.
- **Historically related:** GitHub PAT and `GITHUB_*` env vars are on the rotation list
  (see §6). An expired PAT silently breaks polling.
- **Acceptance:** when a workflow finishes, the build row flips to terminal within ~15s
  in the dashboard and via the plugin, with logs/artifacts attached.

---

## 1. Done (recent, pushed)

- **Site-wide failure logging + admin viewer + billing auto-confirm** — commit `522a633`.
  - Backend: `migrations/0022_error_events.sql`, `PROD_SETUP.sql`, sqlite schema,
    `services/error-log.ts`, `routes/client-errors.ts`, `middleware/auth.ts`
    (`optionalAuthUserId`), `index.ts` `onSend` 5xx hook + crash handlers,
    `routes/admin.ts` `GET /admin/errors` + `DB_TABLES` entry, `tests/error-events.test.ts`.
  - Frontend: `src/lib/error-report.ts`, `src/lib/api.ts` reporting, `RouteErrorBoundary`
    reporting, `src/main.tsx` global handlers, `src/pages/admin.tsx` `ErrorsSection`,
    `src/pages/billing.tsx` post-checkout auto-poll.
- **Whop client fix** — commit `db5f4a1`.
- **Whop webhook literal-bytes signature fix** — commit `d634e09`.
- **ESLint implemented** — `website/eslint.config.js` (flat config, typescript-eslint,
  react-hooks, react-refresh, globals). Installed devDeps in the pnpm workspace root.
  Fixed the 4 `no-useless-assignment` errors. Currently **0 errors, 23 warnings**.
- **`pnpm verify` command** — `website/scripts/verify.mjs`: runs ESLint → tsc (web) →
  tsc (server) → vitest, and on failure asks Pollinations to summarise the errors.
  Wired into `website/package.json` (`verify`, `verify:offline`, `lint` now includes
  `scripts/`). **Full run passed:** all 4 gates green (~80s).
- **Pollinations key wired** into untracked `website/.env` and `website/server/.env`;
  placeholders added to both `.env.example` files.

---

## 2. IN PROGRESS — In-site AI assistant ("the agent")

**Goal:** a signed-in assistant embedded in the site that (a) can see the user's own
account, (b) knows the Ship-It docs, (c) can file a problem report to the admin, (d) uses
`qwen/qwen3.7-flash` under a <32k context, (e) persists conversation history, and (f) has
very aggressive input+output caching.

**Written this session (uncommitted as of this file):**
- `server/supabase/migrations/0023_agent_assistant.sql` — `agent_conversations`,
  `agent_messages`, `agent_cache` + NO FORCE RLS block.
- `server/supabase/PROD_SETUP.sql` — appended the 0023 body **and** a 0022
  NO-FORCE-RLS follow-up for `error_events`.
- `server/src/db/sqlite/schema.ts` — sqlite mirror of the 3 agent tables.
- `server/src/services/pollinations.ts` — OpenAI-compatible client: model fallback chain,
  HTTP-200 low-balance detection, prompt-cache markers for Gemini/Claude/Nova, usage incl.
  `cached_tokens`, `AgentUnavailableError`.
- `server/src/services/agent-cache.ts` — L1 LRU+TTL memory cache, L2 `agent_cache` table,
  single-flight fills, SHA-256 normalised keys, best-effort failure handling.
- `server/src/services/agent-docs.ts` — static knowledge base + `searchDocs` +
  `DOCS_VERSION` (cache-invalidation token).
- `server/src/services/agent-context.ts` — `buildAccountSnapshot`, `snapshotText`,
  `estimateTokens`, `trimToBudget` (pins system message, keeps newest turns).
- `server/src/services/agent-service.ts` — instructions, tools
  (`get_account_summary`, `list_projects`, `list_builds`, `search_docs`, `report_problem`),
  tool loop, cache key (docs version + snapshot + normalised question + history),
  side-effect bypass for report/bug/refund intent, conversation CRUD, `reportProblem`.
- `server/src/routes/agent.ts` — `GET /agent/status`, `GET/POST/DELETE
  /agent/conversations`, `POST /agent/messages`, `POST /agent/report`; auth + per-user
  rate limits; maps `AgentUnavailableError` → `503 AGENT_UNAVAILABLE`.
- `server/src/index.ts` — registered `agentRoutes` under `/api/v1`.
- `server/tests/agent-cache.test.ts` — cache key/LRU/TTL/single-flight/failure tests.
- `server/tests/pollinations.test.ts` — fallback past a low-balance 200, cache-marker
  boundary, tool-call parsing, typed low-balance failure (7 tests).
- `server/tests/agent-context.test.ts` — `estimateTokens`, `snapshotText`, `trimToBudget`,
  `searchDocs` (8 tests).
- `src/lib/agent.ts` — browser client (status/conversations/conversation/send/report).
- `src/components/site/AssistantWidget.tsx` — floating panel: chat, thread history, direct
  report form, cached badge, model label; mounted in `App.tsx` `Root` inside `AuthProvider`
  and outside `RouteRoot`; renders only when signed in.
- **`pnpm verify` passes: ESLint + tsc (web) + tsc (server) + vitest, all 4 gates green.**

**Still to do for the agent:**
- [ ] Add an "Ask AI" entry point in site nav (optional; the floating button is the entry).
- [ ] Optionally surface agent reports in a dedicated admin view (currently they land in the
      existing `feedback` inbox prefixed `[Assistant report · <severity>]`).
- [ ] Confirm the chosen primary model. `qwen/qwen3.7-flash` currently returns HTTP 200 with
      "doesn't have enough credits / needs paid Pollen" on this account; working models are
      `openai/gpt-5.4-nano` and `openai/gpt-oss-20b` (set as fallbacks). Either top up pollen
      or keep the fallback order.
- [ ] Run migration `0023` in prod (see §3) before the assistant works against Supabase.

**Design notes (keep these invariants):**
- Static docs prefix is byte-stable and carries the `cache_control` marker; the dynamic
  account snapshot goes **after** the cache boundary.
- Side-effect turns (report/complaint/refund) **never** read or write the output cache.
- All reads/scopes are by `user_id`; the model can never see another account.
- Context is trimmed to `AGENT_CONTEXT_TOKENS` (default 30000).

---

## 3. Database / migrations

- [ ] **Run migrations in Supabase (prod), in order, via SQL Editor:**
  - `0022_error_events` (already provided) — fixes `PGRST205: relation public.error_events
    does not exist` seen in prod logs.
  - `0023_agent_assistant` — new agent tables.
  - Or just run the updated **`PROD_SETUP.sql`** end-to-end (it now includes 0022 + 0023 and
    the NO-FORCE-RLS lift for all three agent tables + `error_events`).
- [ ] **RLS / 42501 (user is fixing):** prod logs show
  `new row violates row-level security policy for table "builds"` on `POST /api/v1/builds`.
  `0018_no_force_rls.sql` already lists `public.builds`, but the live DB is forcing RLS
  again. Fix = run `ALTER TABLE public.builds NO FORCE ROW LEVEL SECURITY;` (and the same
  for any other table the service-role writes). The service-role key bypasses RLS **unless
  FORCE is set**.
- [ ] After migrations, confirm Supabase's schema cache reloads (PGRST caches schema; a
      `NOTIFY pgrst, 'reload schema'` or a project restart clears it).
- Migrations currently through `0023`. `PROD_SETUP.sql` mirrors them.

---

## 4. Deploys / infra

- [ ] **Render redeploy** of the control plane (`website/server`) after commits `db5f4a1`,
      `d634e09`, `522a633`, and the new agent commit.
- [ ] server-agent live at `https://server-agent1-ship-it.onrender.com` — verify it is
      reachable from the control plane and that the control plane is configured to use it
      (see BUG-A).
- [ ] Confirm `server-agent` and `server-manager` env: agent URL, shared secrets, ports
      (manager `3001`, agent `3002`, orchestrator `3003`).
- [ ] Postgres is on port `5433` locally; prod is Supabase.

---

## 5. Billing / Whop

- [ ] **Reconcile the Ultra plan** for the affected account (and the webhook that
      auto-disabled): confirm `PROD_WEBHOOK_SECRET` equals the exact Whop `ws_…` secret,
      **HMACed over its literal bytes** (do not base64-decode; don't strip the prefix, only
      trim whitespace), then re-enable the webhook and replay the failed
      `membership.activated`, or attach the subscription directly (`mem_…`) via the admin
      panel.
- [ ] Whop dashboard: create `FREE50` (50% forever, cap 50) and enable the promo input;
      archive the Plus product; cancel stale membership `mem_WkJQG6Y1J1h9UX`.
- [ ] Verify checkout returns **200** (was 401 due to env captured at import time;
      `loadEnvOverrides()` now refreshes `process.env` each minute and after admin saves).
- [ ] Verify the billing page auto-confirms the new plan after checkout (shipped in
      `522a633`).

---

## 6. Security / secrets (STILL REQUIRED)

- [ ] Rotate: **GitHub PAT**, **Whop keys/secrets**, **Supabase service key**, and any
      place the password `Husseinmonzer123` is reused.
- [ ] Never commit root `C:\Users\ymonz\Ship-It Workspace\.env` (holds live `WHOP_*`).
- [ ] Pollinations key lives only in untracked `website/.env` + `website/server/.env`.

---

## 7. Plugin

- [ ] Publish `opencode-shipit-runtime` **1.2.3** (local 1.2.3; npm has 1.2.0):
      `npm login` then `npm publish --access public` in `opencode-plugin/`.
- [ ] Plugin should reflect BUG-B fix (terminal build status) once BUG-B is resolved.

---

## 8. Verify command / tooling

- [x] `pnpm verify` (alias `pnpm verify:offline` for no AI) — ESLint + tsc web + tsc server
      + vitest, with Pollinations failure triage. Passing.
- [ ] Consider adding `verify` to CI / a pre-push hook.
- [ ] Extend the Pollinations triage to also summarise `vitest` failures inline (it already
      collects stderr; confirm formatting).

---

## 9. Reference — environment & facts

**Toolchain:** pnpm workspace `12.5.1`, node `v25.9.0`, npm `11.12.1`.
Workspace packages: `"."`, `server`. allowBuilds: `esbuild`, `@heroui/shared-utils`.

**Ports (local):** website `3000`, manager `3001`, agent `3002`, orchestrator `3003`,
Postgres `5433`.

**Pollinations:**
- Base URL `https://gen.pollinations.ai`; OpenAI-compatible `POST /v1/chat/completions`;
  models `GET /v1/models` (`GET /text/models`, 210 text models);
  OpenAPI `https://gen.pollinations.ai/openapi.json`.
- Key `sk_8fdgG9NuVkHQAXPE0YrLAMA2ZpQmknYC`: type `secret`, name `fortunate-octopus`,
  userId `eZsk318m049NRzhPs5CzJ7hQ9N5W1t1V`, permissions `models:null account:null`,
  `pollenBudget:null`, `rateLimitEnabled:false`. `/account/balance` + `/account/usage`
  need `account:usage` (not granted).
- Model providers: prompt caching via `cache_control: {type:"ephemeral"}` on
  Gemini/Claude/Nova; `promptCachedTokens` is the cheap tier.
- Legacy `text.pollinations.ai` is deprecated for authenticated users.

**Database convention:** the `SupabaseClient | SqliteClient` union rejects pre-typed insert
objects — insert **inline object literals** (spread `{ ...row }`).

**Error-log policy:** only 5xx recorded (never 4xx); `error_events` prunes >30 days
probabilistically (~2%); `/client-errors` 30/min per IP; attribution fail-open anonymous via
`optionalAuthUserId`.

**Tiers:** Free `10h/3h/1/$0`; Pro `250h/6h/3/$9`; Ultra `1000h/24h/5/$19`; Plus retired
(→ Ultra).

**Repo/scripts (website):** `dev`, `build`, `typecheck`, `test`, `lint`, `lint:fix`,
`verify`, `verify:offline`.

---

## 10. Suggested order of attack

1. **BUG-A** (runtime 502 — blocking all deployments).
2. **BUG-B** (build stuck "running" — blocking trust in builds/tools).
3. **RLS 42501 + migrations 0022/0023** (prod writes failing; agent tables missing).
4. **Render redeploy** of the agent commit.
5. Finish agent frontend + the two missing test files; `pnpm verify`; commit.
6. Whop reconcile / webhook replay / dashboard config.
7. Plugin 1.2.3 publish.
8. Rotate secrets.
