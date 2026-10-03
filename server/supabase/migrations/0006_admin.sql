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
