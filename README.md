# Website

User-facing dashboard and the account half of the control plane.

Two parts live in this repository:

- `src/` — React 18 + Vite + Tailwind frontend with shadcn-style primitives
- `server/` — Node.js control plane API that also serves the built frontend on `/`

## What the server is authoritative for

- Account API keys, including hashing, rotation and revocation
- Plans and entitlements
- Project uploads and build dispatch
- Billing state, driven by Whop webhooks
- Monthly usage reporting for the dashboard

Runtime quota enforcement and lease issuance live in the Go orchestrator in
`ship-it-labs/server-agent`, not here. This server forwards authenticated
requests to it and passes the plan limits through.

## Running locally

```bash
cp server/.env.example server/.env
npm install

# Terminal 1: API on :3000
npm run dev:server

# Terminal 2: Vite on :5173, proxying /api and /ws to :3000
npm run dev:web
```

For a production-shaped run, build the frontend and let the API serve it:

```bash
npm run build
npm start
```

The API then serves the frontend from `/` and falls back to `index.html` for
client-side routes, so `/dashboard/keys` works on a hard refresh.

## API surface

All routes are versioned under `/api/v1` and return a consistent error shape:

```json
{ "error": { "code": "RUNTIME_QUOTA_EXCEEDED", "message": "Monthly runtime quota exceeded." } }
```

| Group | Routes |
| --- | --- |
| Auth | `/auth/signup`, `/auth/login`, `/auth/logout`, `/auth/reset-password` |
| Account | `/account/api-keys`, `/account/api-keys/:id/rotate`, `/account/api-keys/:id/revoke` |
| Projects | `/projects/upload`, `/projects` |
| Builds | `/builds`, `/builds/:id`, `/builds/:id/logs`, `/builds/:id/artifacts` |
| Runtimes | `/runtimes`, `/runtimes/:id`, `/runtimes/:id/stop`, `/runtimes/:id/restart`, `/runtimes/:id/exec`, `/runtimes/:id/fs`, `/runtimes/:id/network` |
| Usage | `/usage` |
| Billing | `/plans`, `/billing/checkout`, `/billing/subscription`, `/billing/cancel` |
| Webhooks | `/webhooks/whop` |
| Realtime | `/ws?token=<api key>` |

## Authentication

The dashboard authenticates through Supabase Auth with a bearer session token.
The OpenCode plugin authenticates with a long-lived `ox_live_...` account key.
Both resolve to the same `users` row, so the AI and the human see the same
account, plan and usage.

API keys are stored as an HMAC-SHA256 hash salted with `API_KEY_HASH_SECRET`.
The full key is returned exactly once, at creation. Production refuses to start
hash behaviour against a fallback secret.

## Payments

Whop handles checkout, subscriptions and webhooks. `NODE_ENV` selects the
credential set:

- `development` → `WHOP_SANDBOX_*`
- `production` → `WHOP_LIVE_*`

The two sets are separate variables, so a production deploy cannot accidentally
charge a sandbox card, and a development machine cannot silently take live
payments. Missing credentials for the active environment fail loudly instead of
falling back.

## Database

`server/supabase/migrations/0001_initial_schema.sql` creates the schema, indexes,
row level security policies and the `project-uploads` storage bucket. Apply it
with `supabase db push`.
