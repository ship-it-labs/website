-- PRODUCTION BOOTSTRAP: paste this whole file into Supabase Dashboard > SQL Editor and run once.
-- Idempotent: every statement tolerates re-runs. Order matters.

-- ============================================================================
-- migrations/0001_initial_schema.sql
-- ============================================================================
-- OpenCode Runtime Platform - initial schema

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  plan_id text not null default 'free',
  created_at timestamptz not null default now()
);

create table if not exists public.plans (
  id text primary key,
  name text not null,
  runtime_hours_per_month integer not null default 24,
  max_runtime_hours integer not null default 3,
  max_concurrent_runtimes integer not null default 1,
  max_ram_mb integer not null default 512,
  cpu numeric(4,2) not null default 0.1,
  build_timeout_seconds integer not null default 180,
  price_cents integer not null default 0
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  key_hash text not null unique,
  key_prefix text not null,
  name text not null default 'default',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_api_keys_user on public.api_keys(user_id);
create index if not exists idx_api_keys_hash on public.api_keys(key_hash);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  plan_id text not null,
  whop_membership_id text not null unique,
  whop_plan_id text,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active subscription per account; the webhook handler upserts on user_id.
create unique index if not exists idx_subscriptions_user_unique
  on public.subscriptions(user_id);

create index if not exists idx_subscriptions_user on public.subscriptions(user_id);
create index if not exists idx_subscriptions_membership
  on public.subscriptions(whop_membership_id);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  plan_id text not null,
  source text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_entitlements_user on public.entitlements(user_id);

create table if not exists public.projects (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  repo_url text,
  run_command text,
  upload_id text,
  upload_path text,
  upload_url text,
  upload_sha256 text,
  upload_bytes bigint not null default 0,
  file_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user on public.projects(user_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-uploads', 'project-uploads', false, 419430400)
on conflict (id) do nothing;

drop policy if exists "users manage own project uploads" on storage.objects;

create policy "users manage own project uploads"
on storage.objects for all
using (bucket_id = 'project-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

create table if not exists public.builds (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','running','success','failure','timeout')),
  install_commands jsonb not null default '[]'::jsonb,
  build_commands jsonb not null default '[]'::jsonb,
  test_commands jsonb not null default '[]'::jsonb,
  workflow_run_id text,
  exit_code integer,
  timeout_seconds integer not null default 180,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_builds_user on public.builds(user_id, created_at desc);
create index if not exists idx_builds_project on public.builds(project_id);
create index if not exists idx_builds_status on public.builds(status);

create table if not exists public.build_logs (
  id bigserial primary key,
  build_id text not null references public.builds(id) on delete cascade,
  stream text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_build_logs_build on public.build_logs(build_id, created_at);

create table if not exists public.artifacts (
  id text primary key,
  build_id text not null references public.builds(id) on delete cascade,
  name text not null,
  sha256 text not null,
  size bigint not null,
  url text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_artifacts_build on public.artifacts(build_id);

create table if not exists public.runtimes (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  status text not null default 'starting'
    check (status in ('starting','running','stopping','stopped','expired','crashed')),
  agent_id text,
  container_id text,
  app_url text,
  lease_expires_at timestamptz not null,
  max_session_seconds integer not null default 10800,
  started_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_runtimes_user on public.runtimes(user_id, created_at desc);
create index if not exists idx_runtimes_lease on public.runtimes(status, lease_expires_at);

create table if not exists public.runtime_sessions (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  started_at timestamptz not null,
  stopped_at timestamptz,
  duration_seconds integer not null default 0
);

create index if not exists idx_runtime_sessions_user on public.runtime_sessions(user_id);

create table if not exists public.usage_months (
  user_id uuid not null references public.users(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  runtime_used_seconds bigint not null default 0,
  build_count integer not null default 0,
  primary key (user_id, period_start)
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  idempotency_key text not null unique,
  payload jsonb not null,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhook_events_key on public.webhook_events(idempotency_key);

create table if not exists public.server_agents (
  id text primary key,
  manager_id text,
  url text not null,
  status text not null default 'offline',
  last_heartbeat timestamptz,
  current_runtimes integer not null default 0,
  max_runtimes integer not null default 10,
  created_at timestamptz not null default now()
);

create or replace function public.increment_runtime_usage(
  p_user_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_seconds bigint
) returns void
language plpgsql as $$
begin
  insert into public.usage_months (user_id, period_start, period_end, runtime_used_seconds)
  values (p_user_id, p_period_start, p_period_end, p_seconds)
  on conflict (user_id, period_start)
  do update set runtime_used_seconds = usage_months.runtime_used_seconds + excluded.runtime_used_seconds;
end;
$$;

create or replace function public.increment_build_count(
  p_user_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) returns void
language plpgsql as $$
begin
  insert into public.usage_months (user_id, period_start, period_end, build_count)
  values (p_user_id, p_period_start, p_period_end, 1)
  on conflict (user_id, period_start)
  do update set build_count = usage_months.build_count + 1;
end;
$$;

alter table public.users enable row level security;
alter table public.api_keys enable row level security;
alter table public.projects enable row level security;
alter table public.builds enable row level security;
alter table public.runtimes enable row level security;

-- Dropped first so the whole file is re-runnable: CREATE POLICY has no
-- IF NOT EXISTS, and a fresh prod database gets this file exactly once, but a
-- retried or half-applied run must not die on its own policies.
drop policy if exists "users own row" on public.users;
drop policy if exists "keys own rows" on public.api_keys;
drop policy if exists "projects own rows" on public.projects;
drop policy if exists "builds own rows" on public.builds;
drop policy if exists "runtimes own rows" on public.runtimes;

create policy "users own row" on public.users for all using (auth.uid() = id);
create policy "keys own rows" on public.api_keys for all using (
  user_id in (select id from public.users where id = auth.uid())
);
create policy "projects own rows" on public.projects for all using (user_id = auth.uid());
create policy "builds own rows" on public.builds for select using (user_id = auth.uid());
create policy "runtimes own rows" on public.runtimes for select using (user_id = auth.uid());

insert into public.plans (id, name, runtime_hours_per_month, max_runtime_hours, max_ram_mb, cpu, build_timeout_seconds, price_cents)
values
  ('free', 'Free', 24, 3, 512, 0.1, 180, 0),
  ('pro', 'Pro', 100, 8, 2048, 0.5, 300, 2900),
  ('plus', 'Plus', 500, 24, 8192, 2.0, 600, 9900)
on conflict (id) do nothing;
;
-- ============================================================================
-- migrations/0002_run_command.sql
-- ============================================================================
-- Adds the command that starts a built project.
--
-- The agent decides this when it uploads the project, because knowing how to
-- start the app is part of describing it. The server-agent uses it as the
-- container entrypoint instead of guessing, so a project with an unconventional
-- start still runs.

alter table public.projects
  add column if not exists run_command text;

-- Builds no longer require a compile step. A project that only needs its
-- dependencies installed, or nothing at all, can be run straight from source.
alter table public.builds
  alter column build_commands set default '[]'::jsonb;
;
-- ============================================================================
-- migrations/0003_plan_tiers.sql
-- ============================================================================
-- Pricing tiers and where they are sold.
--
-- Two changes, both because a plan is now described by how many instances may
-- run at once rather than by machine size, and because the Whop plan that sells
-- a tier is deployment configuration rather than a row in this table.

-- Concurrent instances allowed per account. Every tier gets the same memory and
-- CPU, so this is what a paid plan actually buys.
alter table public.plans
  add column if not exists max_concurrent_runtimes integer not null default 1;

-- The Whop plan ids moved to the environment (WHOP_PRO_PLAN_ID and so on) so
-- that rotating one is a config change rather than a data migration.
alter table public.plans
  drop column if exists whop_product_id;

insert into public.plans (
  id, name, runtime_hours_per_month, max_runtime_hours,
  max_concurrent_runtimes, max_ram_mb, cpu,
  build_timeout_seconds, price_cents
)
values
  ('free',  'Free',  24,   3,  1, 512, 0.1, 180,    0),
  ('pro',   'Pro',   250,  8,  2, 512, 0.1, 300,  499),
  ('plus',  'Plus',  500, 24,  2, 512, 0.1, 600,  999),
  ('ultra', 'Ultra', 1000, 24, 3, 512, 0.1, 600, 1299)
on conflict (id) do update set
  name                    = excluded.name,
  runtime_hours_per_month = excluded.runtime_hours_per_month,
  max_runtime_hours       = excluded.max_runtime_hours,
  max_concurrent_runtimes = excluded.max_concurrent_runtimes,
  max_ram_mb              = excluded.max_ram_mb,
  cpu                     = excluded.cpu,
  build_timeout_seconds   = excluded.build_timeout_seconds,
  price_cents             = excluded.price_cents;
;
-- ============================================================================
-- migrations/0004_pro_session_hours.sql
-- ============================================================================
-- Pro sessions are six hours. The price page always advertised eight, but the
-- orchestrator's three hour ceiling meant every plan got three hours at most,
-- so this also repairs the oldest broken promise in the pricing.
update public.plans
set max_runtime_hours = 6
where id = 'pro';
;
-- ============================================================================
-- migrations/0005_api_key_expiry.sql
-- ============================================================================
-- Keys can expire. Existing keys keep no deadline and never expire.
alter table public.api_keys
  add column if not exists expires_at timestamptz;
;
-- ============================================================================
-- migrations/0006_admin.sql
-- ============================================================================
-- Admin identity and account standing. Existing rows default to non-admin and
-- active; the first signup and the bootstrap address are resolved at request
-- time, so no backfill can lock anyone out or promote the wrong row.
alter table public.users
  add column if not exists is_admin boolean not null default false;

alter table public.users
  add column if not exists is_active boolean not null default true;

-- Platform kill switches and overrides, edited from the admin panel. A missing
-- row means the default: signups open, executor automatic.
create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
;
-- ============================================================================
-- migrations/0007_plan_sale.sql
-- ============================================================================
-- Sale pricing: a tagline plus the pre-discount price shown crossed out.
-- Both nullable; a plan without them renders exactly as before.
alter table public.plans
  add column if not exists note text;

alter table public.plans
  add column if not exists previous_price_cents integer;
;
-- ============================================================================
-- migrations/0008_kill_plus_reprice.sql
-- ============================================================================
-- Kill Plus, reprice Pro and Ultra, trim Free.
--
-- Plus is merged into Ultra: any account or subscription still naming it moves
-- to Ultra, then the row goes. Deleting the row while it is referenced would
-- 401 every request for those accounts, because authentication rejects a user
-- whose plan row is missing. Only the changed columns are written, so anything
-- an admin edited on these tiers (taglines, sale prices, timeouts) survives.

update public.plans
set runtime_hours_per_month = 10
where id = 'free';

update public.plans
set price_cents = 900,
    max_concurrent_runtimes = 3
where id = 'pro';

update public.plans
set price_cents = 1900,
    max_concurrent_runtimes = 5
where id = 'ultra';

update public.users
set plan_id = 'ultra'
where plan_id = 'plus';

update public.subscriptions
set plan_id = 'ultra'
where plan_id = 'plus';

delete from public.plans
where id = 'plus';
;
-- ============================================================================
-- migrations/0009_account_settings.sql
-- ============================================================================
-- Remembered login sessions for the settings page's device list and
-- "sign out everywhere". Revoking deletes the row and kills the driver-level
-- session alongside it.
create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_user_sessions_user on public.user_sessions(user_id);

-- Notification and display preferences. Stored before anything consumes them
-- so the settings page writes somewhere real from day one.
create table if not exists public.user_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  email_notifications boolean not null default true,
  theme text not null default 'dark',
  updated_at timestamptz not null default now()
);
;
-- ============================================================================
-- migrations/0010_env_overrides.sql
-- ============================================================================
-- Deployment configuration owned by the admin panel. Each key holds a
-- development value and a production value; the deployment applies the column
-- matching its active configuration on boot and refreshes it periodically.
create table if not exists public.env_overrides (
  key text not null,
  environment text not null check (environment in ('development', 'production')),
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (key, environment)
);
;
-- ============================================================================
-- migrations/0011_subscription_promo.sql
-- ============================================================================
-- Discount code carried on the Whop membership, when Whop includes one.
-- Display-only: the billing page acknowledges the promo, and nothing prices
-- from this column. Nullable because most purchases are full price.
alter table public.subscriptions
  add column if not exists promo_code text;
;
-- ============================================================================
-- migrations/0012_build_executor.sql
-- ============================================================================
-- Which executor ran each build ("github" or "runtime"). Display-only: the
-- dashboard shows where a build ran, and nothing dispatches from this column.
-- Nullable because builds created before executors were recorded have no value.
alter table public.builds
  add column if not exists executor text;
;
-- ============================================================================
-- migrations/0013_admin_audit.sql
-- ============================================================================
-- Who did what to whom: every privileged admin mutation leaves one row here.
-- Append-only by convention (no route updates or deletes these rows).
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_id text not null,
  action text not null,
  target text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_created on public.admin_audit(created_at);
;
-- ============================================================================
-- migrations/0014_webhook_processed_index.sql
-- ============================================================================
-- Webhook log lookups by processing state, plus per-request session lookups.
create index if not exists idx_webhook_events_processed
  on public.webhook_events(provider, processed, created_at);

create index if not exists idx_user_sessions_token
  on public.user_sessions(token_hash, user_id);
;
-- ============================================================================
-- migrations/0015_project_language.sql
-- ============================================================================
-- Which language toolchain builds each project, plus the project's runtime
-- environment (encrypted by the app layer; this column holds ciphertext, never
-- plaintext). Builds record the language too. All nullable: rows created
-- before languages existed predate the columns.
alter table public.projects
  add column if not exists language text;
alter table public.projects
  add column if not exists env_ciphertext text;
alter table public.builds
  add column if not exists language text;
;
-- ============================================================================
-- migrations/0016_feedback.sql
-- ============================================================================
-- User feedback for the admin panel. The sender's email is resolved at read
-- time from the users table (never duplicated here), and read entries stay
-- for history — the panel hides them by default instead of deleting.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_feedback_unread
  on public.feedback(is_read, created_at desc);
;