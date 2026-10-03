-- Sale pricing: a tagline plus the pre-discount price shown crossed out.
-- Both nullable; a plan without them renders exactly as before.
alter table public.plans
  add column if not exists note text;

alter table public.plans
  add column if not exists previous_price_cents integer;
