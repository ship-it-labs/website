-- Adds the command that starts a built project.
--
-- The agent decides this when it uploads the project, because knowing how to
-- start the app is part of describing it. The server-agent uses it as the
-- container entrypoint instead of guessing, so a project with an unconventional
-- start still runs.

alter table public.projects
  add column if not exists run_command text;

-- Builds no longer require a compile step. A project that only needs its
-- dependencies installed, or nothing at all, can be run straight from source.
alter table public.builds
  alter column build_commands set default '[]'::jsonb;
