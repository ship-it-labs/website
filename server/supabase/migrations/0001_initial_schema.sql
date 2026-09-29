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
  max_ram_mb integer not null default 512,
  cpu numeric(4,2) not null default 0.1,
  build_timeout_seconds integer not null default 180,
  price_cents integer not null default 0,
  whop_product_id text
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
  whop_subscription_id text not null unique,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_user on public.subscriptions(user_id);

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
