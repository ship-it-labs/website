-- Assistant credit accounting. One row per user per calendar month, so the
-- monthly allowance is a single read and the admin view can sum cost without
-- scanning every message. Token counts are what Pollinations reported; credits
-- are derived from them in code (see services/ai-credits.ts) so the exchange
-- rate can change without a migration.
create table if not exists public.agent_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  period_start date not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  requests integer not null default 0,
  cache_hits integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, period_start)
);
create index if not exists idx_agent_usage_period on public.agent_usage(period_start desc);
create index if not exists idx_agent_usage_user on public.agent_usage(user_id, period_start desc);

-- Same pattern as 0018/0021/0023: created after forced RLS was lifted
-- elsewhere, so a database that still forces it would block every usage write
-- with 42501 while reads keep working. Lift FORCE only; the service-role key
-- keeps bypassing RLS as intended.
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE public.agent_usage NO FORCE ROW LEVEL SECURITY';
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
END $$;
