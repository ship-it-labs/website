-- Repair path for user_sessions. `create table if not exists` cannot fix a
-- table that exists but is missing columns (partial 0009 run, manual edits),
-- and every login writes here: a missing column fails the insert while reads
-- keep working, which used to surface as SESSION_REVOKED on every login and
-- now as SESSION_NOT_RECORDED. Safe to run on healthy databases too.
create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  token_hash text,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.user_sessions
  add column if not exists user_id uuid references public.users(id) on delete cascade;
alter table public.user_sessions
  add column if not exists token_hash text;
alter table public.user_sessions
  add column if not exists user_agent text;
alter table public.user_sessions
  add column if not exists ip text;
alter table public.user_sessions
  add column if not exists created_at timestamptz not null default now();
alter table public.user_sessions
  add column if not exists last_seen_at timestamptz not null default now();

create index if not exists idx_user_sessions_user on public.user_sessions(user_id);
create index if not exists idx_user_sessions_token on public.user_sessions(token_hash, user_id);
