-- Flexo Supplier Invoice Portal — Supabase schema (v2: sign-up + approval)
-- Run in Supabase Dashboard → SQL Editor. Safe to re-run.
--
-- Who can do what (enforced by the database, not just the screen):
--   supplier (pending)   can sign in and see "awaiting approval"; cannot submit
--   supplier (approved)  submits invoices + files; sees ONLY their own invoices
--   staff                sees all invoices; approves / returns / marks paid;
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
  insert into public.profiles (id, email, company_name, tin, contact_name, phone)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(new.raw_user_meta_data ->> 'company_name', ''), 200),
    left(coalesce(new.raw_user_meta_data ->> 'tin', ''), 40),
    left(coalesce(new.raw_user_meta_data ->> 'contact_name', ''), 120),
    left(coalesce(new.raw_user_meta_data ->> 'phone', ''), 40)
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
  status        text not null default 'submitted'
                check (status in ('submitted', 'approved', 'returned', 'paid')),
  return_reason text,
  paid_date     date,
  payment_ref   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  constraint returned_needs_reason check (status <> 'returned' or coalesce(trim(return_reason), '') <> ''),
  constraint paid_needs_details    check (status <> 'paid' or (paid_date is not null and coalesce(trim(payment_ref), '') <> ''))
);

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
  if new.status <> old.status and not (
       (old.status = 'submitted' and new.status in ('approved', 'returned'))
    or (old.status = 'approved'  and new.status in ('paid', 'returned', 'submitted'))
    or (old.status = 'returned'  and new.status = 'submitted')
  ) then
    raise exception 'Cannot change status from % to %', old.status, new.status;
  end if;
  if new.status <> 'returned' then new.return_reason := null; end if;
  if new.status <> 'paid' then new.paid_date := null; new.payment_ref := null; end if;
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
  elsif new.status is distinct from old.status then
    insert into public.invoice_events (invoice_id, actor_id, actor_name, action, note)
    values (new.id, auth.uid(), coalesce(who, 'system'), new.status,
            case new.status when 'returned' then new.return_reason
                            when 'paid' then 'Paid ' || new.paid_date || ', ref ' || new.payment_ref end);
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
-- Storage: private bucket; each supplier uploads into a folder named after
-- their user id; staff can read every file.
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
  execute $p$create policy "invoice files upload own" on storage.objects for insert to authenticated
    with check (bucket_id = 'invoice-files'
                and (storage.foldername(name))[1] = auth.uid()::text
                and public.is_approved_supplier())$p$;
  execute $p$create policy "invoice files read own or staff" on storage.objects for select to authenticated
    using (bucket_id = 'invoice-files'
           and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()))$p$;
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
