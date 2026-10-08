-- User feedback for the admin panel. The sender's email is resolved at read
-- time from the users table (never duplicated here), and read entries stay
-- for history — the panel hides them by default instead of deleting.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_feedback_unread
  on public.feedback(is_read, created_at desc);
