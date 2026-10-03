/**
 * SQLite schema for local development. Mirrors the Postgres migration in
 * supabase/migrations, minus the parts that only exist inside Supabase
 * (row level security, the auth schema and the storage bucket).
 */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

/**
 * Columns added after a database was first created. `create table if not exists`
 * is a no-op on an existing table, so a volume created by an older build would
 * otherwise be missing these and every insert naming them would fail. SQLite has
 * no `add column if not exists`, so each one is checked first.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "plans", column: "max_concurrent_runtimes", definition: "integer not null default 1" },
  { table: "projects", column: "run_command", definition: "text" },
  // Keys can carry a deadline after which the middleware refuses them.
  // Nullable because keys created before expiry existed never expire.
  { table: "api_keys", column: "expires_at", definition: "text" },
  // Admin identity and account standing. A missing flag means an older database,
  // where admin is decided by signup order and email instead.
  { table: "users", column: "is_admin", definition: "integer not null default 0" },
  { table: "users", column: "is_active", definition: "integer not null default 1" },
  // Sale pricing: a tagline plus the pre-discount price shown crossed out.
  { table: "plans", column: "note", definition: "text" },
  { table: "plans", column: "previous_price_cents", definition: "integer" },
];

/** Columns removed from the schema, dropped from existing databases. */
const REMOVED_COLUMNS: { table: string; column: string }[] = [
  // Pricing and the Whop plan that sells each tier now come from the
  // environment, so the column is dead weight in every select.
  { table: "plans", column: "whop_product_id" },
];

/** Brings an existing development database up to the current schema. */
export function applyMigrations(db: SqliteDatabase): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue;
    if (columns.some((c) => c.name === column)) continue;

    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  // Keys created by the old create-key route carry no id, so rotating or
  // revoking them matches zero rows and reports success while changing
  // nothing. Hand each one a stable id the first time the server boots.
  backfillKeyIds(db);

  // Columns the platform no longer uses. Left in place they still come back from
  // `select *` and reach the API, which then disagrees with its own types.
  for (const { table, column } of REMOVED_COLUMNS) {
    const columns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue;
    if (!columns.some((c) => c.name === column)) continue;

    db.exec(`alter table ${table} drop column ${column}`);
  }
}

function backfillKeyIds(db: SqliteDatabase): void {
  const columns = db.prepare("pragma table_info(api_keys)").all() as { name: string }[];
  if (columns.length === 0) return;

  const orphaned = db
    .prepare("select rowid as rowid, key_prefix as prefix from api_keys where id is null")
    .all() as { rowid: number; prefix: string }[];

  for (const row of orphaned) {
    // randomUUID is avoided here: schema.ts stays free of node:crypto so the
    // same file can run in drivers and tests that stub the database interface.
    const id = `key_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
    db.prepare("update api_keys set id = ? where rowid = ?").run(id, row.rowid);
  }
}

export const SCHEMA_SQL = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  plan_id text not null default 'free',
  is_admin integer not null default 0,
  is_active integer not null default 1,
  created_at text not null default (datetime('now'))
);

create table if not exists plans (
  id text primary key,
  name text not null,
  runtime_hours_per_month integer not null default 24,
  max_runtime_hours integer not null default 3,
  max_concurrent_runtimes integer not null default 1,
  max_ram_mb integer not null default 512,
  cpu real not null default 0.1,
  build_timeout_seconds integer not null default 180,
  price_cents integer not null default 0,
  note text,
  previous_price_cents integer
);

create table if not exists api_keys (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  key_hash text not null unique,
  key_prefix text not null,
  name text not null default 'default',
  is_active integer not null default 1,
  created_at text not null default (datetime('now')),
  last_used_at text,
  expires_at text
);
create index if not exists idx_api_keys_user on api_keys(user_id);
create index if not exists idx_api_keys_hash on api_keys(key_hash);

create table if not exists subscriptions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  plan_id text not null,
  whop_membership_id text not null unique,
  whop_plan_id text,
  status text not null,
  current_period_end text,
  cancel_at_period_end integer not null default 0,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create unique index if not exists idx_subscriptions_user_unique on subscriptions(user_id);

create table if not exists entitlements (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  plan_id text not null,
  source text not null,
  granted_at text not null default (datetime('now')),
  revoked_at text
);

create table if not exists projects (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  repo_url text,
  run_command text,
  upload_id text,
  upload_path text,
  upload_url text,
  upload_sha256 text,
  upload_bytes integer not null default 0,
  file_count integer not null default 0,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create index if not exists idx_projects_user on projects(user_id);

create table if not exists builds (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','running','success','failure','timeout')),
  install_commands text not null default '[]',
  build_commands text not null default '[]',
  test_commands text not null default '[]',
  workflow_run_id text,
  exit_code integer,
  timeout_seconds integer not null default 180,
  started_at text,
  completed_at text,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_builds_user on builds(user_id, created_at desc);
create index if not exists idx_builds_status on builds(status);

create table if not exists build_logs (
  id integer primary key autoincrement,
  build_id text not null references builds(id) on delete cascade,
  stream text not null,
  content text not null,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_build_logs_build on build_logs(build_id, created_at);

create table if not exists artifacts (
  id text primary key,
  build_id text not null references builds(id) on delete cascade,
  name text not null,
  sha256 text not null,
  size integer not null,
  url text not null,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_artifacts_build on artifacts(build_id);

create table if not exists runtimes (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  status text not null default 'starting'
    check (status in ('starting','running','stopping','stopped','expired','crashed')),
  agent_id text,
  container_id text,
  app_url text,
  lease_expires_at text not null,
  max_session_seconds integer not null default 10800,
  started_at text,
  stopped_at text,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_runtimes_user on runtimes(user_id, created_at desc);
create index if not exists idx_runtimes_lease on runtimes(status, lease_expires_at);

create table if not exists runtime_sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  started_at text not null,
  stopped_at text,
  duration_seconds integer not null default 0
);

create table if not exists usage_months (
  user_id text not null references users(id) on delete cascade,
  period_start text not null,
  period_end text not null,
  runtime_used_seconds integer not null default 0,
  build_count integer not null default 0,
  primary key (user_id, period_start)
);

create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  event_type text not null,
  idempotency_key text not null unique,
  payload text not null default '{}',
  processed integer not null default 0,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_webhook_events_key on webhook_events(idempotency_key);

-- Platform kill switches and overrides, edited from the admin panel. A missing
-- row means the default: signups open, executor automatic.
create table if not exists platform_settings (
  key text primary key,
  value text not null default '{}',
  updated_at text not null default (datetime('now'))
);

create table if not exists server_agents (
  id text primary key,
  manager_id text,
  url text not null,
  status text not null default 'offline',
  last_heartbeat text,
  current_runtimes integer not null default 0,
  max_runtimes integer not null default 10,
  created_at text not null default (datetime('now'))
);
`;

export const SEED_PLANS_SQL = `
-- Insert-only: an existing tier is never touched here. Tier changes ship
-- through explicit migrations, and anything an admin edits in the panel
-- survives every reboot. INSERT OR REPLACE used to wipe those edits.
insert or ignore into plans
  (id, name, runtime_hours_per_month, max_runtime_hours, max_concurrent_runtimes, max_ram_mb, cpu, build_timeout_seconds, price_cents, note, previous_price_cents)
values
  ('free', 'Free', 24, 3, 1, 512, 0.1, 180, 0, null, null),
  ('pro', 'Pro', 250, 6, 2, 512, 0.1, 300, 499, null, null),
  ('plus', 'Plus', 500, 24, 2, 512, 0.1, 600, 999, null, null),
  ('ultra', 'Ultra', 1000, 24, 3, 512, 0.1, 600, 1299, null, null);

-- One-time repair: the old seed wrote Pro sessions as 8 hours while the
-- orchestrator capped everyone at 3. Rows still carrying the stale 8 move to
-- the intended 6; a row an admin already changed is left alone.
update plans set max_runtime_hours = 6 where id = 'pro' and max_runtime_hours = 8;
`;
