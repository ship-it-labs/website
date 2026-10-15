-- Project activity stamp for storage retention. Uploads, CI bundle
-- deliveries and runtime starts refresh it; the hourly sweeper deletes the
-- zip object of projects idle past their tier budget (free 24h, pro 3 days,
-- ultra 7 days) while leaving rows, builds and history intact. Backfilled
-- from updated_at so existing projects get a truthful starting stamp.
-- Idempotent: safe to re-run.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
UPDATE public.projects
  SET last_activity_at = COALESCE(updated_at, created_at, now())
  WHERE last_activity_at IS NULL;
ALTER TABLE public.projects
  ALTER COLUMN last_activity_at SET DEFAULT now();
