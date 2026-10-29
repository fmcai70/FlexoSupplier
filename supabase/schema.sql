-- Flexo Supplier Invoice Portal — Supabase schema (v2: sign-up + approval)
-- Run in Supabase Dashboard → SQL Editor. Safe to re-run.
--
-- Who can do what (enforced by the database, not just the screen):
--   supplier (pending)   can sign in and see "awaiting approval"; cannot submit
--   supplier (approved)  submits invoices + files; sees ONLY their own invoices
--   staff                sees all invoices; marks OK / returns; schedules the Friday
--                        check release; marks paid with proof of payment;
--                        approves supplier accounts and sets their SAP vendor code
--   admin                everything staff can do + makes other users staff/admin
--
-- First admin: sign up on the portal, then run (with your own email):
--   update public.profiles set role = 'admin', status = 'approved' where email = 'you@example.com';

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profiles (one per sign-up)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  role          text not null default 'supplier' check (role in ('supplier', 'staff', 'admin')),
  status        text not null default 'pending'  check (status in ('pending', 'approved', 'rejected', 'disabled')),
  company_name  text not null default '',
  tin           text not null default '',
  contact_name  text not null default '',
  phone         text not null default '',
  vendor_code   text,                       -- SAP Business Partner code (CardCode)
  status_note   text,                       -- reason shown when rejected / disabled
  approved_at   timestamptz,
  approved_by   uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint approved_supplier_needs_vendor_code
    check (role <> 'supplier' or status <> 'approved' or coalesce(trim(vendor_code), '') <> '')
);

-- What the person asked for when signing up. 'staff' only from the staff page AND only
-- for @flexo.com.ph emails. It grants nothing by itself: an admin still sets the role.
alter table public.profiles add column if not exists requested_role text not null default 'supplier';
alter table public.profiles drop constraint if exists profiles_requested_role_check;
alter table public.profiles add  constraint profiles_requested_role_check check (requested_role in ('supplier', 'staff'));

-- Helper checks used by the policies (security definer so they can read profiles).
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                  where id = auth.uid() and role in ('staff', 'admin') and status = 'approved');
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                  where id = auth.uid() and role = 'admin' and status = 'approved');
$$;
create or replace function public.is_approved_supplier() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                  where id = auth.uid() and role = 'supplier' and status = 'approved');
$$;
-- True when running from the SQL editor or with the service_role key — never for
-- requests from the portal (those always carry an anon/authenticated login token).
create or replace function public.is_backend() returns boolean
language sql stable as $$
  select auth.uid() is null
     and (coalesce(current_setting('request.jwt.claims', true), '') = ''
          or current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
$$;

-- New sign-up → pending supplier profile. Role is ALWAYS 'supplier' here;
-- nobody can make themselves staff through the sign-up form.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, company_name, tin, contact_name, phone, requested_role)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(new.raw_user_meta_data ->> 'company_name', ''), 200),
    left(coalesce(new.raw_user_meta_data ->> 'tin', ''), 40),
    left(coalesce(new.raw_user_meta_data ->> 'contact_name', ''), 120),
    left(coalesce(new.raw_user_meta_data ->> 'phone', ''), 40),
    case when new.raw_user_meta_data ->> 'requested_role' = 'staff'
          and lower(coalesce(new.email, '')) like '%@flexo.com.ph' then 'staff' else 'supplier' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Guard who may change which profile fields.
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_backend() then
    return new;
  end if;
  new.id := old.id;
  new.email := old.email;
  new.created_at := old.created_at;
  new.requested_role := old.requested_role;
  if not public.is_staff() then
    -- Users may only edit their own contact details.
    new.role := old.role; new.status := old.status; new.vendor_code := old.vendor_code;
    new.status_note := old.status_note; new.approved_at := old.approved_at; new.approved_by := old.approved_by;
  elsif not public.is_admin() then
    -- Staff manage supplier accounts only, and cannot change roles.
    if old.role <> 'supplier' and old.id <> auth.uid() then
      raise exception 'Only an admin can change staff accounts';
    end if;
    if new.role <> old.role then
      raise exception 'Only an admin can change roles';
    end if;
  end if;
  if old.id = auth.uid() and (new.role <> old.role or new.status <> old.status) then
    raise exception 'You cannot change your own role or status';
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    new.approved_at := now(); new.approved_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.profiles (id),
  vendor_code   text not null,
  company_name  text not null,
  invoice_no    text not null check (trim(invoice_no) <> ''),
  invoice_date  date not null,
  po_no         text not null check (trim(po_no) <> ''),
  vatex_amount  numeric(14, 2) not null check (vatex_amount > 0),
  total_amount  numeric(14, 2) not null check (total_amount >= vatex_amount),
  dr_no         text not null check (trim(dr_no) <> ''),
  dr_date       date not null,
  file_path     text not null,
  file_name     text not null,
  status        text not null default 'submitted',
  return_reason text,
  paid_date     date,
  payment_ref   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

-- Check release schedule + proof of payment (added in v2.1; safe on existing tables).
alter table public.invoices add column if not exists release_date   date;           -- always a Friday
alter table public.invoices add column if not exists release_amount numeric(14, 2); -- what the supplier will receive
alter table public.invoices add column if not exists release_note   text;           -- e.g. "less 1% EWT"
alter table public.invoices add column if not exists proof_path     text;           -- proof of payment file
alter table public.invoices add column if not exists proof_name     text;

-- Workflow: submitted → approved ("Checked OK") → scheduled (Friday release) → paid
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add  constraint invoices_status_check
  check (status in ('submitted', 'approved', 'scheduled', 'returned', 'paid'));
alter table public.invoices drop constraint if exists returned_needs_reason;
alter table public.invoices add  constraint returned_needs_reason
  check (status <> 'returned' or coalesce(trim(return_reason), '') <> '');
alter table public.invoices drop constraint if exists release_on_friday;
alter table public.invoices add  constraint release_on_friday
  check (release_date is null or extract(isodow from release_date) = 5);
alter table public.invoices drop constraint if exists release_amount_range;
alter table public.invoices add  constraint release_amount_range
  check (release_amount is null or (release_amount > 0 and release_amount <= total_amount));
-- NOT VALID: enforced for every new change, without failing on invoices paid before v2.1.
alter table public.invoices drop constraint if exists scheduled_needs_release;
alter table public.invoices add  constraint scheduled_needs_release
  check (status not in ('scheduled', 'paid') or (release_date is not null and release_amount is not null)) not valid;
alter table public.invoices drop constraint if exists paid_needs_details;
alter table public.invoices add  constraint paid_needs_details
  check (status <> 'paid' or (paid_date is not null and coalesce(trim(payment_ref), '') <> ''
                              and coalesce(proof_path, '') <> '')) not valid;

-- Same supplier can't submit the same invoice number twice (unless it was returned).
create unique index if not exists invoices_no_duplicates
  on public.invoices (vendor_code, upper(trim(invoice_no))) where status <> 'returned';
create index if not exists invoices_supplier_idx on public.invoices (supplier_id, created_at desc);
create index if not exists invoices_status_idx   on public.invoices (status, created_at desc);

create or replace function public.invoices_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  if not public.is_backend() then
    select * into p from public.profiles where id = auth.uid();
    new.supplier_id  := auth.uid();
    new.vendor_code  := p.vendor_code;
    new.company_name := p.company_name;
  end if;
  new.invoice_no := trim(new.invoice_no);
  new.po_no := trim(new.po_no);
  new.dr_no := trim(new.dr_no);
  new.status := 'submitted';
  new.return_reason := null; new.paid_date := null; new.payment_ref := null;
  new.release_date := null; new.release_amount := null; new.release_note := null;
  new.proof_path := null; new.proof_name := null;
  new.created_at := now(); new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists invoices_before_insert on public.invoices;
create trigger invoices_before_insert before insert on public.invoices
  for each row execute function public.invoices_before_insert();

-- Staff may only move an invoice through its workflow; what the supplier typed stays as typed.
create or replace function public.invoices_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_backend() then
    return new;
  end if;
  if (new.supplier_id, new.vendor_code, new.company_name, new.invoice_no, new.invoice_date, new.po_no,
      new.vatex_amount, new.total_amount, new.dr_no, new.dr_date, new.file_path, new.file_name, new.created_at)
     is distinct from
     (old.supplier_id, old.vendor_code, old.company_name, old.invoice_no, old.invoice_date, old.po_no,
      old.vatex_amount, old.total_amount, old.dr_no, old.dr_date, old.file_path, old.file_name, old.created_at) then
    raise exception 'Submitted invoice details cannot be changed';
  end if;
  if old.status = 'paid' then
    raise exception 'Paid invoices cannot be changed';
  end if;
  if new.status <> old.status and not (
       (old.status = 'submitted' and new.status in ('approved', 'returned'))
    or (old.status = 'approved'  and new.status in ('scheduled', 'returned', 'submitted'))
    or (old.status = 'scheduled' and new.status in ('paid', 'approved', 'returned'))
    or (old.status = 'returned'  and new.status = 'submitted')
  ) then
    raise exception 'Cannot change status from % to %', old.status, new.status;
  end if;
  if new.status = 'paid' then
    -- the schedule the supplier was told stays as it was
    new.release_date := old.release_date; new.release_amount := old.release_amount; new.release_note := old.release_note;
  end if;
  if new.status <> 'returned' then new.return_reason := null; end if;
  if new.status not in ('scheduled', 'paid') then
    new.release_date := null; new.release_amount := null; new.release_note := null;
  end if;
  if new.status <> 'paid' then
    new.paid_date := null; new.payment_ref := null; new.proof_path := null; new.proof_name := null;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists invoices_before_update on public.invoices;
create trigger invoices_before_update before update on public.invoices
  for each row execute function public.invoices_before_update();

-- ---------------------------------------------------------------------------
-- History log (written automatically; nobody can edit it)
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_events (
  id          bigserial primary key,
  invoice_id  uuid not null references public.invoices (id) on delete cascade,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_name  text,
  action      text not null,
  note        text
);
create index if not exists invoice_events_invoice_idx on public.invoice_events (invoice_id, at);

create or replace function public.invoices_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select coalesce(nullif(contact_name, ''), email) into who from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.invoice_events (invoice_id, actor_id, actor_name, action)
    values (new.id, auth.uid(), coalesce(who, 'system'), 'submitted');
  elsif new.status is distinct from old.status
     or (new.status = 'scheduled' and (new.release_date, new.release_amount, new.release_note)
                                      is distinct from (old.release_date, old.release_amount, old.release_note)) then
    insert into public.invoice_events (invoice_id, actor_id, actor_name, action, note)
    values (new.id, auth.uid(), coalesce(who, 'system'),
            case when new.status = old.status then 'rescheduled' else new.status end,
            case new.status
              when 'returned'  then new.return_reason
              when 'scheduled' then 'Check release ' || to_char(new.release_date, 'Dy Mon DD, YYYY')
                                    || ' · PHP ' || to_char(new.release_amount, 'FM999,999,999,990.00')
                                    || coalesce(' (' || nullif(trim(new.release_note), '') || ')', '')
              when 'paid'      then 'Paid ' || to_char(new.paid_date, 'Mon DD, YYYY') || ', ref ' || new.payment_ref
            end);
  end if;
  return null;
end $$;

drop trigger if exists invoices_log on public.invoices;
create trigger invoices_log after insert or update on public.invoices
  for each row execute function public.invoices_log();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.invoices       enable row level security;
alter table public.invoice_events enable row level security;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_staff()) with check (id = auth.uid() or public.is_staff());

drop policy if exists invoices_select on public.invoices;
drop policy if exists invoices_insert on public.invoices;
drop policy if exists invoices_update on public.invoices;
create policy invoices_select on public.invoices for select to authenticated
  using (supplier_id = auth.uid() or public.is_staff());
create policy invoices_insert on public.invoices for insert to authenticated
  with check (public.is_approved_supplier() and supplier_id = auth.uid());
create policy invoices_update on public.invoices for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists invoice_events_select on public.invoice_events;
create policy invoice_events_select on public.invoice_events for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id));

revoke all on public.profiles, public.invoices, public.invoice_events from anon;
grant select, update         on public.profiles       to authenticated;
grant select, insert, update on public.invoices       to authenticated;
grant select                 on public.invoice_events to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket.
--   <supplier user id>/...        invoice files, uploaded by that supplier
--   payments/<invoice id>/...     proof of payment, uploaded by staff,
--                                 readable by the supplier of that invoice
-- ---------------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('invoice-files', 'invoice-files', false, 10485760,
          array['application/pdf', 'image/jpeg', 'image/png'])
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- remove the open pilot policies from v1
  execute 'drop policy if exists "pilot invoice files read" on storage.objects';
  execute 'drop policy if exists "pilot invoice files upload" on storage.objects';
  execute 'drop policy if exists "invoice files upload own" on storage.objects';
  execute 'drop policy if exists "invoice files read own or staff" on storage.objects';
  execute 'drop policy if exists "payment proofs upload staff" on storage.objects';
  execute $p$create policy "invoice files upload own" on storage.objects for insert to authenticated
    with check (bucket_id = 'invoice-files'
                and (storage.foldername(name))[1] = auth.uid()::text
                and public.is_approved_supplier())$p$;
  execute $p$create policy "payment proofs upload staff" on storage.objects for insert to authenticated
    with check (bucket_id = 'invoice-files'
                and (storage.foldername(name))[1] = 'payments'
                and public.is_staff())$p$;
  execute $p$create policy "invoice files read own or staff" on storage.objects for select to authenticated
    using (bucket_id = 'invoice-files'
           and ((storage.foldername(name))[1] = auth.uid()::text
                or public.is_staff()
                or ((storage.foldername(name))[1] = 'payments'
                    and exists (select 1 from public.invoices i
                                 where i.id::text = (storage.foldername(name))[2]
                                   and i.supplier_id = auth.uid()))))$p$;
exception when undefined_table or invalid_schema_name then
  raise notice 'storage schema not found (not a Supabase database?) — skipping bucket setup';
end $$;

-- ---------------------------------------------------------------------------
-- Close the v1 pilot table (it was readable by anyone with the site's key).
-- Its data is kept; delete it yourself with:  drop table public.docs;
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.docs') is not null then
    execute 'drop policy if exists "pilot anon read" on public.docs';
    execute 'drop policy if exists "pilot anon write" on public.docs';
    execute 'revoke all on public.docs from anon, authenticated';
  end if;
  if to_regprocedure('public.doc_merge(text,text,jsonb)') is not null then
    execute 'revoke execute on function public.doc_merge(text,text,jsonb) from public, anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Email notifications (v2.2)
-- Every event that should send an email is queued here by a trigger. The
-- "notify" Edge Function sends the queue through Microsoft Graph and marks
-- each row sent. Nobody using the portal can read or change this table.
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          bigserial primary key,
  kind        text not null,       -- signup | account_approved | account_rejected | invoice_submitted
                                   -- invoice_returned | invoice_scheduled | invoice_rescheduled | invoice_paid
  invoice_id  uuid references public.invoices (id) on delete cascade,
  profile_id  uuid references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  attempts    int not null default 0,
  last_error  text
);
create index if not exists notifications_pending_idx on public.notifications (id) where sent_at is null;
alter table public.notifications enable row level security;   -- no policies: closed to portal users
revoke all on public.notifications from anon, authenticated;

create or replace function public.queue_notifications() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'profiles' then
    if tg_op = 'INSERT' and new.role = 'supplier' then
      insert into public.notifications (kind, profile_id) values ('signup', new.id);
    elsif tg_op = 'UPDATE' and new.role = 'supplier' and new.status is distinct from old.status
          and new.status in ('approved', 'rejected') then
      insert into public.notifications (kind, profile_id) values ('account_' || new.status, new.id);
    end if;
  else
    if tg_op = 'INSERT' then
      insert into public.notifications (kind, invoice_id) values ('invoice_submitted', new.id);
    elsif new.status is distinct from old.status and new.status in ('returned', 'scheduled', 'paid') then
      insert into public.notifications (kind, invoice_id) values ('invoice_' || new.status, new.id);
    elsif new.status = 'scheduled' and old.status = 'scheduled'
          and (new.release_date, new.release_amount) is distinct from (old.release_date, old.release_amount) then
      insert into public.notifications (kind, invoice_id) values ('invoice_rescheduled', new.id);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists profiles_notify on public.profiles;
create trigger profiles_notify after insert or update on public.profiles
  for each row execute function public.queue_notifications();
drop trigger if exists invoices_notify on public.invoices;
create trigger invoices_notify after insert or update on public.invoices
  for each row execute function public.queue_notifications();

-- Used only by the notify Edge Function (service role): take up to p_limit
-- unsent emails (retrying failed ones up to 5 times) together with the data to write them.
create or replace function public.claim_notifications(p_limit int default 25) returns setof jsonb
language sql security definer set search_path = public as $$
  with c as (
    update public.notifications n
       set claimed_at = now(), attempts = n.attempts + 1
     where n.id in (select id from public.notifications
                     where sent_at is null and attempts < 5
                       and (claimed_at is null or claimed_at < now() - interval '10 minutes')
                     order by id limit p_limit
                     for update skip locked)
    returning n.*
  )
  select jsonb_build_object('id', c.id, 'kind', c.kind,
                            'invoice', to_jsonb(i), 'profile', to_jsonb(p))
    from c
    left join public.invoices i on i.id = c.invoice_id
    left join public.profiles p on p.id = coalesce(c.profile_id, i.supplier_id)
   order by c.id;
$$;
create or replace function public.finish_notification(p_id bigint, p_error text default null) returns void
language sql security definer set search_path = public as $$
  update public.notifications
     set sent_at = case when p_error is null then now() end,
         claimed_at = null,
         last_error = p_error
   where id = p_id;
$$;
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;
revoke execute on function public.finish_notification(bigint, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_notifications(int) to service_role';
    execute 'grant execute on function public.finish_notification(bigint, text) to service_role';
    execute 'grant select, update on public.notifications to service_role';
  end if;
end $$;
revoke execute on function public.queue_notifications() from public, anon, authenticated;
