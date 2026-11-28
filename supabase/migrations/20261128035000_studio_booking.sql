begin;

create schema if not exists studio_private;
revoke all on schema studio_private from public;

alter table public.lola_requests
  add column starts_at timestamptz,
  add column ends_at timestamptz,
  add column email text,
  add column selection jsonb,
  add column submission_id uuid unique,
  add constraint studio_valid_period check (
    (starts_at is null and ends_at is null)
    or (starts_at is not null and ends_at is not null and ends_at > starts_at)
  );
do $$
declare old_constraint text;
begin
  select conname into strict old_constraint
  from pg_constraint
  where conrelid = 'public.lola_requests'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%contacted%';
  execute format('alter table public.lola_requests drop constraint %I', old_constraint);
end $$;
alter table public.lola_requests
  add constraint studio_status check (status in ('pending','approved','cancelled','blocked','contacted','closed')),
  add constraint studio_no_overlap exclude using gist (
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (starts_at is not null and status in ('pending','approved','blocked'));
alter table public.lola_requests enable row level security;
revoke all on public.lola_requests from public, anon, authenticated;
grant select on public.lola_requests to authenticated;

create function studio_private.local_start(day date, start_time time)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare result timestamptz := (day + start_time) at time zone 'America/Los_Angeles';
begin
  if day is null or start_time is null or extract(isodow from day) in (4,7)
    or start_time < time '10:00' or start_time > time '17:30'
    or extract(minute from start_time)::int % 15 <> 0 or extract(second from start_time) <> 0
    or result <= now() or day > (now() at time zone 'America/Los_Angeles')::date + 90 then
    raise exception 'Choose a future salon time within the next 90 days.' using errcode = '22023';
  end if;
  return result;
end $$;

create function studio_private.service_selection(items jsonb)
returns table (description text, minutes integer) language plpgsql stable set search_path = '' as $$
declare item record;
declare service_row public.lola_services%rowtype;
declare unit_minutes int;
declare includes_appointment boolean := false;
begin
  if coalesce(jsonb_typeof(items), '') <> 'object' or items = '{}'::jsonb
     or (select count(*) from jsonb_object_keys(items)) > 12 then
    raise exception 'Choose up to 12 different services.' using errcode = '22023';
  end if;
  description := '';
  minutes := 0;
  for item in select * from jsonb_each_text(items) order by key loop
    if item.value is null or item.value !~ '^([1-9]|1[0-2])$' then
      raise exception 'Invalid service quantity.' using errcode = '22023';
    end if;
    select * into service_row from public.lola_services where active and name = item.key;
    if not found then
      raise exception 'A selected service is unavailable.' using errcode = '22023';
    end if;
    unit_minutes := case
      when service_row.category like 'Hair only%' or service_row.pricing_unit like 'Hair from %' then 0
      when service_row.pricing_unit ~ '[0-9]+ min' then substring(service_row.pricing_unit from '([0-9]+) min')::int
      when service_row.name ilike '%consultation%' then 30
      when service_row.name ilike '%color correction%' or service_row.name ilike '%platinum card%' then 240
      when service_row.category in ('Highlights & Blonding','Balayage & Specialty Color') then 180
      when service_row.category = 'All-Over Color' then 120
      when service_row.name like 'Tape-In%' then 120
      when service_row.category = 'Hair Extension Installation' then 60
      when service_row.name like 'Brazilian Blowout%' then 120
      when service_row.category = 'Color Add-Ons' then 30
      else 60
    end;
    includes_appointment := includes_appointment or
      (unit_minutes > 0 and service_row.category <> 'Color Add-Ons');
    minutes := minutes + unit_minutes * item.value::int;
    description := concat_ws(', ', nullif(description,''), item.value || ' × ' || item.key);
  end loop;
  if not includes_appointment or minutes > 480 then
    raise exception 'Choose an appointment service and keep the estimated visit within eight hours.' using errcode = '22023';
  end if;
  return next;
end $$;

create function public.studio_slots(day date, items jsonb)
returns table (start_time text) language plpgsql stable security definer set search_path = '' as $$
declare duration int;
begin
  select minutes into duration from studio_private.service_selection(items);
  if day is null or extract(isodow from day) in (4,7)
    or day < (now() at time zone 'America/Los_Angeles')::date
    or day > (now() at time zone 'America/Los_Angeles')::date + 90 then
    return;
  end if;
  return query
  select to_char(s.local_time, 'HH24:MI')
  from generate_series(day + time '10:00', day + time '17:30', interval '15 minutes') s(local_time)
  cross join lateral (select s.local_time at time zone 'America/Los_Angeles' as start_at) z
  where z.start_at > now()
    and s.local_time + make_interval(mins => duration) <= day + time '19:00'
    and not exists (
      select 1 from public.lola_requests r
      where r.starts_at is not null and r.status in ('pending','approved','blocked')
        and tstzrange(r.starts_at,r.ends_at,'[)') &&
            tstzrange(z.start_at,z.start_at + make_interval(mins => duration),'[)')
    );
end $$;

create function public.studio_request(
  request_key uuid, day date, start_time time, items jsonb,
  full_name text, phone text, customer_email text, goals text, agreed boolean
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare start_at timestamptz;
declare duration int;
declare summary text;
declare existing public.lola_requests%rowtype;
declare digits text := regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g');
begin
  full_name := trim(coalesce(full_name,''));
  customer_email := lower(trim(coalesce(customer_email,'')));
  if length(digits) = 11 and left(digits,1) = '1' then digits := right(digits,10); end if;
  if request_key is null or agreed is distinct from true or length(full_name) not between 2 and 100
    or length(digits) <> 10 or length(customer_email) > 254
    or customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(coalesce(goals,'')) > 1000 then
    raise exception 'Enter your name, a valid mobile number and email, and accept appointment texts.' using errcode = '22023';
  end if;
  start_at := studio_private.local_start(day,start_time);
  select description,minutes into summary,duration from studio_private.service_selection(items);
  if start_time + make_interval(mins => duration) > time '19:00'
    or (start_at + make_interval(mins => duration) at time zone 'America/Los_Angeles')::date <> day then
    raise exception 'Choose an earlier time for this service.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(digits, 671));
  select * into existing from public.lola_requests where submission_id = request_key;
  if found then
    if existing.contact = digits and existing.email = customer_email and existing.client_name = full_name
       and existing.starts_at = start_at and existing.selection = items then return existing.id; end if;
    raise exception 'Start a new request after changing appointment details.' using errcode = '22023';
  end if;
  if (select count(*) from public.lola_requests where contact = digits and created_at > now() - interval '24 hours') >= 4 then
    raise exception 'Too many requests for this mobile number today.' using errcode = '22023';
  end if;
  insert into public.lola_requests (
    submission_id,client_name,contact,email,service,preferred_time,notes,consent,status,starts_at,ends_at,selection
  ) values (
    request_key,full_name,digits,customer_email,summary,day::text || ' ' || start_time::text,
    nullif(trim(goals),''),true,'pending',start_at,start_at + make_interval(mins => duration),items
  ) returning id into request_key;
  return request_key;
exception when exclusion_violation then
  raise exception 'That time was just taken. Choose another time.' using errcode = '23P01';
end $$;

create function public.studio_is_admin()
returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce(auth.uid() = '0b27059d-4e2a-4f49-a8fb-a2355a88909a'::uuid, false);
$$;

create function public.studio_manage(
  action text, appointment_id uuid default null, day date default null,
  start_time time default null, duration integer default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare current_row public.lola_requests%rowtype;
declare start_at timestamptz;
begin
  if not public.studio_is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  if action = 'block' then
    if day is null or start_time is null or duration is null or duration not between 15 and 1440
      or day < (now() at time zone 'America/Los_Angeles')::date then
      raise exception 'Enter a date, start time, and duration of 15–1440 minutes.' using errcode = '22023';
    end if;
    start_at := (day + start_time) at time zone 'America/Los_Angeles';
    insert into public.lola_requests (client_name,contact,service,preferred_time,consent,status,starts_at,ends_at)
    values ('Calendar block','','Unavailable',day::text,true,'blocked',start_at,start_at + make_interval(mins => duration));
    return;
  end if;
  select * into current_row from public.lola_requests where id = appointment_id for update;
  if not found then raise exception 'Appointment no longer exists.' using errcode = '22023'; end if;
  if action = 'cancel' and current_row.status in ('pending','approved','blocked','contacted') then
    update public.lola_requests set status = 'cancelled' where id = appointment_id;
  elsif action = 'approve' and current_row.status = 'pending' and current_row.starts_at > now() then
    update public.lola_requests set status = 'approved' where id = appointment_id;
  elsif action = 'reschedule' and current_row.status in ('pending','approved','contacted') then
    start_at := studio_private.local_start(day,start_time);
    duration := coalesce(duration, (extract(epoch from current_row.ends_at - current_row.starts_at) / 60)::int);
    if duration is null or duration not between 15 and 480 then
      raise exception 'Set a duration of 15–480 minutes.' using errcode = '22023';
    end if;
    update public.lola_requests set starts_at = start_at, ends_at = start_at + make_interval(mins => duration),
      preferred_time = day::text || ' ' || start_time::text,
      status = case when current_row.status = 'contacted' then 'pending' else current_row.status end
      where id = appointment_id;
  else
    raise exception 'This appointment cannot be changed that way.' using errcode = '22023';
  end if;
exception when exclusion_violation then
  raise exception 'That time overlaps an existing appointment or availability block.' using errcode = '23P01';
end $$;

revoke execute on function public.studio_request(uuid,date,time,jsonb,text,text,text,text,boolean),
  public.studio_slots(date,jsonb), public.studio_manage(text,uuid,date,time,integer), public.studio_is_admin()
  from public, anon, authenticated;
grant execute on function public.studio_request(uuid,date,time,jsonb,text,text,text,text,boolean),
  public.studio_slots(date,jsonb) to anon, authenticated;
grant execute on function public.studio_manage(text,uuid,date,time,integer), public.studio_is_admin()
  to authenticated;

-- Match the pricing and bookable services in the approved reservation page.
with approved as (
  select * from jsonb_to_recordset($catalog$[{"name":"Full-Head Color — Long/Thick","category":"All-Over Color","price_cents":18000,"pricing_unit":"$180"},{"name":"Full-Head Color — Medium/Thick to Long","category":"All-Over Color","price_cents":14500,"pricing_unit":"$145"},{"name":"Full-Head Color — Short/Medium","category":"All-Over Color","price_cents":11500,"pricing_unit":"$115"},{"name":"Full-Head Color — Very Short","category":"All-Over Color","price_cents":6500,"pricing_unit":"$65"},{"name":"Root Touch-Up","category":"All-Over Color","price_cents":7500,"pricing_unit":"From $75"},{"name":"Solid Bleach","category":"All-Over Color","price_cents":15000,"pricing_unit":"From $150"},{"name":"Balayage — Long/Thick","category":"Balayage & Specialty Color","price_cents":29000,"pricing_unit":"$290"},{"name":"Balayage — Medium/Thick to Long","category":"Balayage & Specialty Color","price_cents":23000,"pricing_unit":"$230"},{"name":"Balayage — Short/Medium","category":"Balayage & Specialty Color","price_cents":20000,"pricing_unit":"$200"},{"name":"Balayage — Very Short","category":"Balayage & Specialty Color","price_cents":17000,"pricing_unit":"$170"},{"name":"Color Correction","category":"Balayage & Specialty Color","price_cents":15000,"pricing_unit":"From $150"},{"name":"Full Balayage","category":"Balayage & Specialty Color","price_cents":27500,"pricing_unit":"$275–$350"},{"name":"Highlights & Lowlights","category":"Balayage & Specialty Color","price_cents":18500,"pricing_unit":"From $185"},{"name":"Partial Balayage","category":"Balayage & Specialty Color","price_cents":22500,"pricing_unit":"$225–$275"},{"name":"Reverse Balayage","category":"Balayage & Specialty Color","price_cents":19500,"pricing_unit":"From $195"},{"name":"Bridal Hair & Makeup","category":"Bridal & Special Events","price_cents":null,"pricing_unit":"Consultation required"},{"name":"Bridal Party Styling","category":"Bridal & Special Events","price_cents":null,"pricing_unit":"Consultation required"},{"name":"Event Styling","category":"Bridal & Special Events","price_cents":null,"pricing_unit":"Consultation required"},{"name":"Wedding Packages","category":"Bridal & Special Events","price_cents":null,"pricing_unit":"Custom quote"},{"name":"Formula 18 Additive","category":"Color Add-Ons","price_cents":4000,"pricing_unit":"$40–$50"},{"name":"Glossing & Glaze","category":"Color Add-Ons","price_cents":null,"pricing_unit":"Consultation required"},{"name":"Root Smudge","category":"Color Add-Ons","price_cents":5500,"pricing_unit":"$55"},{"name":"Toner","category":"Color Add-Ons","price_cents":4000,"pricing_unit":"$40"},{"name":"Formula 18 Conditioning Treatment","category":"Conditioning & Scalp Treatments","price_cents":3800,"pricing_unit":"$38"},{"name":"Formula 18 Deep Conditioning Masque","category":"Conditioning & Scalp Treatments","price_cents":4000,"pricing_unit":"$40"},{"name":"L’Oréal Metal Detox","category":"Conditioning & Scalp Treatments","price_cents":2500,"pricing_unit":"$25"},{"name":"Milbon Enhancing Vivacity Scalp Treatment","category":"Conditioning & Scalp Treatments","price_cents":10000,"pricing_unit":"$100"},{"name":"Milbon Reawaken 4-Step Treatment","category":"Conditioning & Scalp Treatments","price_cents":7500,"pricing_unit":"$75"},{"name":"Milbon Scalp-to-Ends Combo","category":"Conditioning & Scalp Treatments","price_cents":15000,"pricing_unit":"$150"},{"name":"Custom Extension Color Matching","category":"Extension Maintenance & Removal","price_cents":null,"pricing_unit":"Quote if additional color needed"},{"name":"Extension Consultation","category":"Extension Maintenance & Removal","price_cents":0,"pricing_unit":"Free"},{"name":"Extension Maintenance","category":"Extension Maintenance & Removal","price_cents":15000,"pricing_unit":"From $150"},{"name":"Extension Removal","category":"Extension Maintenance & Removal","price_cents":9500,"pricing_unit":"$95 / hour"},{"name":"Extension Repair","category":"Extension Maintenance & Removal","price_cents":null,"pricing_unit":"Consultation required"},{"name":"Butterfly Weft","category":"Hair Extension Installation","price_cents":12500,"pricing_unit":"$125 / row"},{"name":"I-Tip Installation","category":"Hair Extension Installation","price_cents":10000,"pricing_unit":"$100 / 25 strands"},{"name":"K-Tip Installation","category":"Hair Extension Installation","price_cents":12500,"pricing_unit":"$125 / 25 strands"},{"name":"Mini/Genius Weft — Beaded","category":"Hair Extension Installation","price_cents":10500,"pricing_unit":"$105 / row"},{"name":"Tape-In — 10 pieces","category":"Hair Extension Installation","price_cents":9000,"pricing_unit":"$90"},{"name":"Tape-In — 20 pieces","category":"Hair Extension Installation","price_cents":17500,"pricing_unit":"$175"},{"name":"Tape-In — 30 pieces","category":"Hair Extension Installation","price_cents":26500,"pricing_unit":"$265"},{"name":"Tape-In — 40 pieces","category":"Hair Extension Installation","price_cents":35000,"pricing_unit":"$350"},{"name":"Tape-In — 50–60 pieces","category":"Hair Extension Installation","price_cents":40000,"pricing_unit":"$400"},{"name":"Tape-In — 70–80 pieces","category":"Hair Extension Installation","price_cents":45000,"pricing_unit":"$450"},{"name":"Volume Weft — Beaded","category":"Hair Extension Installation","price_cents":10500,"pricing_unit":"$105 / row"},{"name":"Volume Weft — Hand-Tied","category":"Hair Extension Installation","price_cents":16500,"pricing_unit":"$165 / row"},{"name":"Butterfly weft — Standard 50g","category":"Hair only — Butterfly weft","price_cents":45000,"pricing_unit":"Published example hair-only price $450.00"},{"name":"Clip-in — 18-inch Indian Remy 120g","category":"Hair only — Clip-in","price_cents":18000,"pricing_unit":"Published starting hair-only price $180.00"},{"name":"Clip-in — 18-inch Russian Remy 120g","category":"Hair only — Clip-in","price_cents":25000,"pricing_unit":"Published starting hair-only price $250.00"},{"name":"Clip-in — 20-inch Russian Remy 160g","category":"Hair only — Clip-in","price_cents":35000,"pricing_unit":"Published starting hair-only price $350.00"},{"name":"Clip-in — 22-inch Brazilian body wave 140g","category":"Hair only — Clip-in","price_cents":29500,"pricing_unit":"Published starting hair-only price $295.00"},{"name":"Clip-in — 22-inch Indian Remy 160g","category":"Hair only — Clip-in","price_cents":29500,"pricing_unit":"Published starting hair-only price $295.00"},{"name":"Clip-in — 24-inch Indian Remy 160g","category":"Hair only — Clip-in","price_cents":35000,"pricing_unit":"Published starting hair-only price $350.00"},{"name":"Halo — 16-inch Clipo hybrid 120g","category":"Hair only — Halo","price_cents":25000,"pricing_unit":"Published starting hair-only price $250.00"},{"name":"Halo — 16-inch human hair 100g","category":"Hair only — Halo","price_cents":16000,"pricing_unit":"Published starting hair-only price $160.00"},{"name":"Halo — 20-inch Clipo hybrid 150g","category":"Hair only — Halo","price_cents":35000,"pricing_unit":"Published starting hair-only price $350.00"},{"name":"Halo — 20-inch human hair 120g","category":"Hair only — Halo","price_cents":20000,"pricing_unit":"Published starting hair-only price $200.00"},{"name":"Halo — 24-inch instant 150g","category":"Hair only — Halo","price_cents":29999,"pricing_unit":"Published starting hair-only price $299.99"},{"name":"Hand-tied — 20-inch Russian Virgin","category":"Hair only — Hand-tied","price_cents":27500,"pricing_unit":"Published starting hair-only price $275.00"},{"name":"Hand-tied — 24-inch Russian Remy","category":"Hair only — Hand-tied","price_cents":60000,"pricing_unit":"Published starting hair-only price $600.00"},{"name":"I-tip — 22-inch Russian Virgin 25 strands","category":"Hair only — I-tip","price_cents":30000,"pricing_unit":"Published starting hair-only price $300.00"},{"name":"K-tip — 20-inch Russian Remy 25 strands","category":"Hair only — K-tip","price_cents":12500,"pricing_unit":"Published starting hair-only price $125.00"},{"name":"Mini/Genius weft — Standard platinum example","category":"Hair only — Mini/Genius weft","price_cents":60000,"pricing_unit":"Published example hair-only price $600.00"},{"name":"Tape-in — 18-inch Russian Virgin 10 pieces 20g","category":"Hair only — Tape-in","price_cents":20000,"pricing_unit":"Published starting hair-only price $200.00"},{"name":"Tape-in — 20-inch Russian Remy 10 pieces 25g","category":"Hair only — Tape-in","price_cents":12500,"pricing_unit":"Published starting hair-only price $125.00"},{"name":"Tape-in — 22-inch Russian Virgin 10 pieces","category":"Hair only — Tape-in","price_cents":30000,"pricing_unit":"Published starting hair-only price $300.00"},{"name":"Tape-in — 26-inch Russian Remy 10 pieces 25g","category":"Hair only — Tape-in","price_cents":17500,"pricing_unit":"Published starting hair-only price $175.00"},{"name":"Topper — 10-inch curly human hair","category":"Hair only — Topper","price_cents":20000,"pricing_unit":"Published starting hair-only price $200.00"},{"name":"Topper — 12–14-inch Indian Remy","category":"Hair only — Topper","price_cents":18000,"pricing_unit":"Published starting hair-only price $180.00"},{"name":"Topper — 14-inch Russian Remy","category":"Hair only — Topper","price_cents":70000,"pricing_unit":"Published starting hair-only price $700.00"},{"name":"Weft — 20-inch Russian Remy 100g","category":"Hair only — Weft","price_cents":40000,"pricing_unit":"Published starting hair-only price $400.00"},{"name":"Weft — 26-inch Russian Remy 100g","category":"Hair only — Weft","price_cents":60000,"pricing_unit":"Published starting hair-only price $600.00"},{"name":"Dry Styling — Curls","category":"Haircuts & Styling","price_cents":4500,"pricing_unit":"$45"},{"name":"Dry Styling — Flat Iron","category":"Haircuts & Styling","price_cents":4500,"pricing_unit":"$45"},{"name":"Quick Dry Trim","category":"Haircuts & Styling","price_cents":4800,"pricing_unit":"$48"},{"name":"Shampoo, Blow Dry & Style","category":"Haircuts & Styling","price_cents":4500,"pricing_unit":"$45"},{"name":"Signature Haircut, Shampoo & Style","category":"Haircuts & Styling","price_cents":6800,"pricing_unit":"From $68"},{"name":"Baby Lights","category":"Highlights & Blonding","price_cents":19500,"pricing_unit":"From $195"},{"name":"Foiled Highlights","category":"Highlights & Blonding","price_cents":16500,"pricing_unit":"From $165"},{"name":"Full Highlights/Lowlights — Long/Thick","category":"Highlights & Blonding","price_cents":29000,"pricing_unit":"$290"},{"name":"Full Highlights/Lowlights — Medium/Long","category":"Highlights & Blonding","price_cents":23000,"pricing_unit":"$230"},{"name":"Full Highlights/Lowlights — Short/Medium","category":"Highlights & Blonding","price_cents":20000,"pricing_unit":"$200"},{"name":"Full Highlights/Lowlights — Very Short","category":"Highlights & Blonding","price_cents":17000,"pricing_unit":"$170"},{"name":"Partial Highlights — Long/Thick","category":"Highlights & Blonding","price_cents":20500,"pricing_unit":"$205"},{"name":"Partial Highlights — Medium/Long","category":"Highlights & Blonding","price_cents":17500,"pricing_unit":"$175"},{"name":"Partial Highlights — Short/Medium","category":"Highlights & Blonding","price_cents":15500,"pricing_unit":"$155"},{"name":"Partial Highlights — Very Short","category":"Highlights & Blonding","price_cents":12500,"pricing_unit":"$125"},{"name":"Platinum Card","category":"Highlights & Blonding","price_cents":25000,"pricing_unit":"From $250"},{"name":"Brazilian Blowout — Long","category":"BRAZILIAN BLOWOUT","price_cents":31000,"pricing_unit":"$310"},{"name":"Brazilian Blowout — Long/Thick","category":"BRAZILIAN BLOWOUT","price_cents":34000,"pricing_unit":"$340"},{"name":"Brazilian Blowout — Regular","category":"BRAZILIAN BLOWOUT","price_cents":28000,"pricing_unit":"$280"},{"name":"Japanese Thermal Straightening","category":"BRAZILIAN BLOWOUT","price_cents":40000,"pricing_unit":"From $400"},{"name":"Keratin Treatment","category":"BRAZILIAN BLOWOUT","price_cents":null,"pricing_unit":"Consultation required"},{"name":"Chemical Damage Correction","category":"Specialty Services","price_cents":null,"pricing_unit":"Custom quote"},{"name":"Express Extension Services","category":"Specialty Services","price_cents":null,"pricing_unit":"Custom quote"},{"name":"Hair Loss Consultation","category":"Specialty Services","price_cents":0,"pricing_unit":"Free"},{"name":"Hair Topper Consultation","category":"Specialty Services","price_cents":null,"pricing_unit":"Custom quote"},{"name":"Heat Damage Recovery","category":"Specialty Services","price_cents":null,"pricing_unit":"Custom quote"},{"name":"Mesh Integration","category":"Specialty Services","price_cents":null,"pricing_unit":"Custom quote"},{"name":"Thick, Long or Specialty Cut","category":"Haircuts & Styling","price_cents":10300,"pricing_unit":"$103 · 75 min"},{"name":"Clip-in Extension Consultation / Fitting","category":"Temporary Extensions","price_cents":null,"pricing_unit":"Service quote required"},{"name":"Clip-in Hair — 18–26 inch","category":"Temporary Extensions","price_cents":18000,"pricing_unit":"Hair from $180; up to $350"},{"name":"Halo Extension Consultation / Fitting","category":"Temporary Extensions","price_cents":null,"pricing_unit":"Service quote required"},{"name":"16-inch Halo Hair — 100g","category":"Temporary Extensions","price_cents":16000,"pricing_unit":"Hair from $160"},{"name":"Women’s Very Short Haircut","category":"Haircuts & Styling","price_cents":5300,"pricing_unit":"$53 · 30 min"},{"name":"Short to Medium Haircut","category":"Haircuts & Styling","price_cents":7300,"pricing_unit":"$73 · 45 min"},{"name":"Wash, Blow Dry & Style — Short to Medium","category":"Haircuts & Styling","price_cents":5500,"pricing_unit":"$55 · 45 min"},{"name":"Wash, Blow Dry & Style — Medium to Long","category":"Haircuts & Styling","price_cents":7000,"pricing_unit":"$70 · 60 min"},{"name":"Wash, Blow Dry & Style — Long and/or Thick","category":"Haircuts & Styling","price_cents":9500,"pricing_unit":"$95 · 75 min"},{"name":"Wash, Blow Dry & Style — Long, Thick and/or Extensions","category":"Haircuts & Styling","price_cents":11500,"pricing_unit":"$115 · 90 min"}]$catalog$::jsonb)
    as s(name text, category text, price_cents integer, pricing_unit text)
)
 , updated as (
insert into public.lola_services (name,category,price_cents,pricing_unit,active)
select name,category,price_cents,pricing_unit,true from approved
on conflict (name) do update set category=excluded.category,price_cents=excluded.price_cents,
  pricing_unit=excluded.pricing_unit,active=true
 returning name
)
update public.lola_services set active=false where active and name not in (select name from approved);

notify pgrst, 'reload schema';
commit;
