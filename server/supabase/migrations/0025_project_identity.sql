-- Project identity. A project id is chosen by the caller (the plugin or the
-- AI), so two accounts can pick the same slug such as `mini-app`; because the
-- id is the primary key, a blind upsert moved the other account's project to
-- the writer. The upload route now resolves a colliding slug to a scoped id
-- (see src/services/project-identity.ts), and this index makes the display name
-- unique per account so identity cannot be shared even if a future write path
-- forgets. Wrapped: a database that already holds duplicate (user_id, name)
-- rows keeps the index from building rather than failing the migration.
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name
      ON public.projects (user_id, name);
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Skipping idx_projects_user_name: duplicate (user_id, name) rows exist';
  END;
END $$;
