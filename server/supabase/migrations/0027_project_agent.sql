-- Project file-home affinity. Upload bytes persist on exactly one agent's
-- disk; runtime starts pin back to that host so archives read locally.
-- Null means legacy (pre-affinity) or Supabase-backed rows, which keep
-- least-loaded routing and fetch over HTTPS. Idempotent: safe to re-run.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS agent_id text,
  ADD COLUMN IF NOT EXISTS agent_url text;
