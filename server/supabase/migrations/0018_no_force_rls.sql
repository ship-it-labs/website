-- The control plane talks to Supabase with the service-role key, which
-- bypasses row level security — unless RLS is FORCED on a table, which blocks
-- even service-role. A forced table fails every write with 42501 while reads
-- keep working, the exact shape that broke every login with SESSION_REVOKED
-- (session inserts died, selects found nothing). This lifts FORCE wherever it
-- was set, on every table the server writes. It does not disable RLS itself:
-- ordinary policies keep applying to end-user keys.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.users',
    'public.plans',
    'public.api_keys',
    'public.subscriptions',
    'public.entitlements',
    'public.projects',
    'public.builds',
    'public.build_logs',
    'public.artifacts',
    'public.runtimes',
    'public.runtime_sessions',
    'public.usage_months',
    'public.webhook_events',
    'public.server_agents',
    'public.platform_settings',
    'public.user_sessions',
    'public.user_preferences',
    'public.env_overrides',
    'public.admin_audit',
    'public.feedback'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', t);
    EXCEPTION WHEN undefined_table THEN
      -- From a migration not run yet on this database; its own migration
      -- creates it normally (unforced) when it runs.
      NULL;
    END;
  END LOOP;
END $$;
