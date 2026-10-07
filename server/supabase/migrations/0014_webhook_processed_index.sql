-- Webhook log lookups by processing state, plus per-request session lookups.
--
-- The admin panel lists recent webhook events per provider and the payments
-- page filters them by processed state; without a composite index both are
-- sequential scans that grow with every billing event. The session index
-- serves the auth middleware: hasSessionRow runs on every authenticated
-- request with (user_id, token_hash), and logout looks up token_hash alone,
-- so token_hash leads the composite.
create index if not exists idx_webhook_events_processed
  on public.webhook_events(provider, processed, created_at);

create index if not exists idx_user_sessions_token
  on public.user_sessions(token_hash, user_id);
