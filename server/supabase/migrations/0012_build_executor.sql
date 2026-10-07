-- Which executor ran each build ("github" or "runtime"). Display-only: the
-- dashboard shows where a build ran, and nothing dispatches from this column.
-- Nullable because builds created before executors were recorded have no value.
alter table public.builds
  add column if not exists executor text;
