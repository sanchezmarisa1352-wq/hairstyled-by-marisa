alter table public.studio_earnings
  add column hair_cents integer not null default 0 check (hair_cents between 0 and 10000000);
