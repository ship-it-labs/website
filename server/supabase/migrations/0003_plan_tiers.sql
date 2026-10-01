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
