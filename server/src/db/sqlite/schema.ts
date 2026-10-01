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
];

/** Brings an existing development database up to the current schema. */
export function applyMigrations(db: SqliteDatabase): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue;
    if (columns.some((c) => c.name === column)) continue;

    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

export const SCHEMA_SQL = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  plan_id text not null default 'free',
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
  whop_product_id text
);

create table if not exists api_keys (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  key_hash text not null unique,
  key_prefix text not null,
  name text not null default 'default',
  is_active integer not null default 1,
  created_at text not null default (datetime('now')),
  last_used_at text
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
insert or replace into plans
  (id, name, runtime_hours_per_month, max_runtime_hours, max_concurrent_runtimes, max_ram_mb, cpu, build_timeout_seconds, price_cents)
values
  ('free', 'Free', 24, 3, 1, 512, 0.1, 180, 0),
  ('pro', 'Pro', 250, 8, 2, 512, 0.1, 300, 499),
  ('plus', 'Plus', 500, 24, 2, 512, 0.1, 600, 999),
  ('ultra', 'Ultra', 1000, 24, 3, 512, 0.1, 600, 1299);
`;
