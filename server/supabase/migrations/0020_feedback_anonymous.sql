-- Anonymous feedback: the homepage button must work for logged-out visitors,
-- so user_id becomes nullable. Authenticated senders still attach their id
-- (the route prefers it whenever a valid bearer token is present); anonymous
-- rows carry null and are rate-limited hard per IP instead.
alter table public.feedback
  alter column user_id drop not null;
