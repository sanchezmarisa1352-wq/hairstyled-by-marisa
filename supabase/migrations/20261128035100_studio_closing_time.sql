create or replace function public.studio_request(
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
  if day + start_time + make_interval(mins => duration) > day + time '19:00' then
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

create or replace function public.studio_manage(
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
    if day + start_time + make_interval(mins => duration) > day + time '19:00' then
      raise exception 'Choose an earlier time for this service.' using errcode = '22023';
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

