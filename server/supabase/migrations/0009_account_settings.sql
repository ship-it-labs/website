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
