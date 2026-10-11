-- oauth_codes was created by 0019, after 0018 lifted forced RLS everywhere —
-- so a database that forced RLS later (or between the two) still blocks
-- authorization codes. Same pattern as 0018: lift FORCE, change nothing else.
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE public.oauth_codes NO FORCE ROW LEVEL SECURITY';
  EXCEPTION WHEN undefined_table THEN
    -- 0019 not run yet on this database; it creates the table normally
    -- (unforced) when it runs.
    NULL;
  END;
END $$;
