-- OAuth authorization codes for the first-party OpenCode plugin. Short-lived
-- (10 minutes) and single-use: the exchange deletes the row before minting,
-- so a replay finds nothing. Only the hash is stored; the raw code travels
-- out through the browser redirect and is never returned in a JSON body.
create table if not exists public.oauth_codes (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_codes_user on public.oauth_codes(user_id);
