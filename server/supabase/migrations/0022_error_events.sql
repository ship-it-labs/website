-- Every failed thing, in one place: API 5xx responses (logged by the
-- server's send hook), browser failures (reported by the frontend's global
-- handlers), and process crashes. The admin panel reads this table; nothing
-- else does. user_id is nullable because logged-out pages crash too, and set
-- null on delete so wiping an account never wipes the failure history that
-- explains what happened to it.
create table if not exists public.error_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('api', 'client', 'process')),
  method text,
  path text,
  status_code integer,
  error_code text,
  message text not null,
  user_id uuid references public.users(id) on delete set null,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_error_events_created
  on public.error_events(created_at desc);
create index if not exists idx_error_events_source
  on public.error_events(source, created_at desc);
create index if not exists idx_error_events_status
  on public.error_events(status_code, created_at desc);
