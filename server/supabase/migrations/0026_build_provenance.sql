-- Build provenance columns. The control plane snapshots the archive sha256 and
-- the source repo URL onto the build row at dispatch time (see
-- services/build-service.ts setBuildProvenance). Without these columns
-- PostgREST answers PGRST204 "Could not find the column in the schema cache"
-- and provenance is skipped with a warning. The write is best-effort so a
-- missing column never fails a build, but the log noise hides real problems.
-- Idempotent: safe to re-run.
ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS source_repo text;
