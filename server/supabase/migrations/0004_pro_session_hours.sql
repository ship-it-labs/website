-- Pro sessions are six hours. The price page always advertised eight, but the
-- orchestrator's three hour ceiling meant every plan got three hours at most,
-- so this also repairs the oldest broken promise in the pricing.
update public.plans
set max_runtime_hours = 6
where id = 'pro';
