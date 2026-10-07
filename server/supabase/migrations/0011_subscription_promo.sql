-- Discount code carried on the Whop membership, when Whop includes one.
-- Display-only: the billing page acknowledges the promo, and nothing prices
-- from this column. Nullable because most purchases are full price.
alter table public.subscriptions
  add column if not exists promo_code text;
