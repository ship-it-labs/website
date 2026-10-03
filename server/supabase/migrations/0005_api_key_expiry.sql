-- Keys can expire. Existing keys keep no deadline and never expire.
alter table public.api_keys
  add column if not exists expires_at timestamptz;
