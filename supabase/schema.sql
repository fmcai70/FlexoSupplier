-- Flexo Supplier Invoice Portal — Supabase schema
-- Run once in Supabase Dashboard → SQL Editor (safe to re-run).
--
-- The portal stores everything as JSON documents grouped into collections,
-- exactly like the claude.ai artifact database it was built on:
--   sap_po          one row per SAP purchase order (with its lines)
--   sap_grpo        one row per SAP goods receipt PO (with its lines)
--   invoices        one row per supplier invoice submission (+ match result, history)
--   invoice_files   page previews (JPEG data URLs) for each invoice
--   vendors         supplier access codes / enabled flag
--   settings        "app" (tolerances, staff PIN) and "sap_import" (last import info)

create table if not exists public.docs (
  collection text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists docs_collection_idx on public.docs (collection);

-- Top-level merge used by the portal's update() calls (atomic).
create or replace function public.doc_merge(p_collection text, p_id text, p_patch jsonb)
returns boolean
language sql
as $$
  with u as (
    update public.docs
       set data = data || p_patch, updated_at = now()
     where collection = p_collection and id = p_id
    returning 1
  )
  select exists (select 1 from u);
$$;

-- Realtime: push changes to every open portal tab.
alter table public.docs replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs'
  ) then
    execute 'alter publication supabase_realtime add table public.docs';
  end if;
exception when undefined_object then
  raise notice 'supabase_realtime publication not found (not a Supabase database?) — skipping';
end $$;

-- ---------------------------------------------------------------------------
-- Access policy — TEMPORARY / PILOT ONLY
-- The portal signs people in with a staff PIN and per-supplier access codes
-- checked in the browser, so the database is opened to the public anon key.
-- Anyone holding the site URL + anon key can read and change all rows.
-- Before real go-live, move to Supabase Auth and per-role RLS policies.
-- ---------------------------------------------------------------------------
alter table public.docs enable row level security;

drop policy if exists "pilot anon read"  on public.docs;
drop policy if exists "pilot anon write" on public.docs;
create policy "pilot anon read"  on public.docs for select to anon, authenticated using (true);
create policy "pilot anon write" on public.docs for all    to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.docs to anon, authenticated;
grant execute on function public.doc_merge(text, text, jsonb) to anon, authenticated;

-- Storage bucket for original invoice files (private; the portal uses signed links).
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit)
  values ('invoice-files', 'invoice-files', false, 26214400)
  on conflict (id) do nothing;

  execute 'drop policy if exists "pilot invoice files read" on storage.objects';
  execute 'drop policy if exists "pilot invoice files upload" on storage.objects';
  execute $p$create policy "pilot invoice files read" on storage.objects
           for select to anon, authenticated using (bucket_id = 'invoice-files')$p$;
  execute $p$create policy "pilot invoice files upload" on storage.objects
           for insert to anon, authenticated with check (bucket_id = 'invoice-files')$p$;
exception when undefined_table or invalid_schema_name then
  raise notice 'storage schema not found (not a Supabase database?) — skipping bucket setup';
when insufficient_privilege then
  raise notice 'Not allowed to change storage policies from SQL — create the bucket "invoice-files" (private) and its read/upload policies in Dashboard → Storage';
end $$;
