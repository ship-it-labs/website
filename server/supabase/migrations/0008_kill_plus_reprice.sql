-- Kill Plus, reprice Pro and Ultra, trim Free.
--
-- Plus is merged into Ultra: any account or subscription still naming it moves
-- to Ultra, then the row goes. Deleting the row while it is referenced would
-- 401 every request for those accounts, because authentication rejects a user
-- whose plan row is missing. Only the changed columns are written, so anything
-- an admin edited on these tiers (taglines, sale prices, timeouts) survives.

update public.plans
set runtime_hours_per_month = 10
where id = 'free';

update public.plans
set price_cents = 900,
    max_concurrent_runtimes = 3
where id = 'pro';

update public.plans
set price_cents = 1900,
    max_concurrent_runtimes = 5
where id = 'ultra';

update public.users
set plan_id = 'ultra'
where plan_id = 'plus';

update public.subscriptions
set plan_id = 'ultra'
where plan_id = 'plus';

delete from public.plans
where id = 'plus';
