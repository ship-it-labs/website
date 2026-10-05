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
