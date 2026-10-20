-- API keys get a name, a set of permissions and a budget.
--
-- scopes: a comma separated list of permissions ("projects:read,runtimes:write").
--   NULL means every permission, which is what the keys minted by the OAuth
--   flows already have: they were created before this table existed and must
--   keep working untouched.
-- budget_minutes: the runtime minutes this key may reserve. NULL means no cap.
-- reserved_minutes: what it has reserved so far. A start reserves the session
--   length it was granted, so a key cannot start a hundred three-hour
--   runtimes against an hour of budget.
--
-- Idempotent: safe to re-run.

alter table public.api_keys add column if not exists scopes text;
alter table public.api_keys add column if not exists budget_minutes integer;
alter table public.api_keys add column if not exists reserved_minutes integer not null default 0;

comment on column public.api_keys.scopes is
  'Comma separated permissions. NULL means every permission.';
comment on column public.api_keys.budget_minutes is
  'Runtime minutes this key may reserve. NULL means no cap.';
comment on column public.api_keys.reserved_minutes is
  'Runtime minutes this key has already reserved.';

-- A start reserves the session length it was granted, so a key with an hour
-- of budget cannot start a hundred three-hour runtimes. The increment happens
-- in the database so two simultaneous starts cannot both read the same total.
create or replace function public.increment_api_key_reservation(
  p_api_key_id uuid,
  p_minutes integer
)
returns void
language plpgsql
as $$
begin
  update public.api_keys
     set reserved_minutes = coalesce(reserved_minutes, 0) + greatest(p_minutes, 0)
   where id = p_api_key_id;
end;
$$;
