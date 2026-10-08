-- Which language toolchain builds each project, plus the project's runtime
-- environment (encrypted by the app layer; this column holds ciphertext, never
-- plaintext). Builds record the language too, so a build row says what made it.
-- All nullable: rows created before languages existed predate the columns.
alter table public.projects
  add column if not exists language text;
alter table public.projects
  add column if not exists env_ciphertext text;
alter table public.builds
  add column if not exists language text;
