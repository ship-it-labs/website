-- Who did what to whom: every privileged admin mutation leaves one row here.
-- Append-only by convention (no route updates or deletes these rows). The
-- detail column carries short human-readable context, never secrets.
-- NOTE TO COORDINATOR: this file is new but not yet wired in. Apply:
--   1) server/src/db/sqlite/schema.ts — append the equivalent
--      `create table if not exists admin_audit (...)` block (see snippet below).
--   2) server/supabase/PROD_SETUP.sql — append the same create table.
-- Until then every audit write is defensive (warn + continue), so nothing breaks.
--
-- SQLite snippet for schema.ts:
--   create table if not exists admin_audit (
--     id text primary key,
--     admin_id text not null,
--     action text not null,
--     target text,
--     detail text,
--     created_at text not null default (datetime('now'))
--   );
--   create index if not exists idx_admin_audit_created on admin_audit(created_at);
--
-- Postgres snippet for PROD_SETUP.sql:
--   create table if not exists public.admin_audit (
--     id uuid primary key default gen_random_uuid(),
--     admin_id text not null,
--     action text not null,
--     target text,
--     detail text,
--     created_at timestamptz not null default now()
--   );
--   create index if not exists idx_admin_audit_created on public.admin_audit(created_at);
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_id text not null,
  action text not null,
  target text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_created on public.admin_audit(created_at);
