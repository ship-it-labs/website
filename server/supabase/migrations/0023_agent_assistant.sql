-- The in-site assistant: per-user conversation threads, their messages, and a
-- shared response cache. Conversations and messages are scoped to a user and
-- cascade on delete; the cache is global (the same question and the same
-- account snapshot get the same answer regardless of who asked) and expires on
-- its own. See 0023.
create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_conversations_user
  on public.agent_conversations(user_id, updated_at desc);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  model text,
  tool_name text,
  tokens integer,
  cache_hit boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_messages_conversation
  on public.agent_messages(conversation_id, created_at);

create table if not exists public.agent_cache (
  cache_key text primary key,
  scope text not null default 'global',
  model text not null,
  response text not null,
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_agent_cache_expires on public.agent_cache(expires_at);

-- Same pattern as 0018/0021: the tables above are created after forced RLS was
-- lifted elsewhere, so a database that still forces RLS would block every
-- assistant write with 42501 while reads keep working. Lift FORCE only; the
-- service-role key keeps bypassing RLS as intended.
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE public.agent_conversations NO FORCE ROW LEVEL SECURITY';
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
  BEGIN
    EXECUTE 'ALTER TABLE public.agent_messages NO FORCE ROW LEVEL SECURITY';
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
  BEGIN
    EXECUTE 'ALTER TABLE public.agent_cache NO FORCE ROW LEVEL SECURITY';
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
END $$;
