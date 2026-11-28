create table public.studio_earnings (
  id uuid primary key,
  owner_id uuid not null default auth.uid(),
  visit_date date not null,
  client_name text not null check (char_length(trim(client_name)) between 1 and 120),
  contact text not null default '' check (char_length(contact) <= 254),
  service_cents integer not null check (service_cents between 0 and 10000000),
  tip_cents integer not null check (tip_cents between 0 and 10000000),
  next_visit date check (next_visit > visit_date),
  follow_up date check (follow_up >= visit_date),
  created_at timestamptz not null default now()
);
alter table public.studio_earnings enable row level security;
revoke all on public.studio_earnings from public, anon, authenticated;
grant select, insert, update on public.studio_earnings to authenticated;
create policy owner_earnings on public.studio_earnings
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.studio_is_admin()))
  with check (owner_id = (select auth.uid()) and (select public.studio_is_admin()));
create index studio_earnings_owner_visits on public.studio_earnings (owner_id, visit_date desc, id);
