-- ============================================================
-- Doc → live-ad pipeline: split-job queue (Phase 1, tokenless).
-- One uploaded dual-half doc → one launch_job (campaign-level, held once) +
-- N launch_holds (one per script/entry, BOTH halves held verbatim).
-- The Vercel app writes these on Commit; the drims-workers intake worker reads
-- pending jobs and fans them out into Creative Pipeline tasks. Idempotency keys:
-- launch_holds.clickup_task_id (create-once) and .promoted_at (promote-once).
-- ============================================================
create extension if not exists "uuid-ossp";

-- One per uploaded split doc. campaign_config = the doc's LAUNCH CONFIG (budget/account/etc.).
create table if not exists public.launch_jobs (
  id                uuid primary key default uuid_generate_v4(),
  store_slug        text not null,                 -- registry slug (store-agnostic; resolved from doc Store)
  store_name        text,                          -- as written in the doc
  account_id        text,                          -- resolved ad account (null if store not mapped)
  buyer             text,                          -- media buyer (session email)
  editor_name       text not null,                 -- editor named IN THE DOC
  editor_assignee_id text,                         -- resolved ClickUp member id (null → blocker, never guessed)
  campaign_config   jsonb not null default '{}'::jsonb,
  entry_count       int  not null default 0,       -- ACTUAL number of entries parsed (N-agnostic)
  source_filename   text,
  status            text not null default 'pending', -- pending | running | done | failed
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One per script/entry. Holds BOTH halves verbatim + tracks fan-out and promotion.
create table if not exists public.launch_holds (
  id                uuid primary key default uuid_generate_v4(),
  job_id            uuid not null references public.launch_jobs(id) on delete cascade,
  entry_index       int  not null,
  ad_number         text,
  video_file        text,                          -- the script↔ad-copy pairing key
  test_label        text,                          -- buyer's "Testing:" label (for the unique Production name)
  script_half       text not null,                 -- EDITOR half, verbatim
  launch_half       jsonb not null,                -- BUYER half {ad_copy,name_string,ad_set,tokens,...}, verbatim
  clickup_task_id   text,                          -- set by intake worker (create-once idempotency)
  production_task_id text,                         -- set by drive-promotion worker
  promoted_at       timestamptz,                   -- set ONCE; no re-promote on an edited Drive link
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index  if not exists launch_holds_job_idx  on public.launch_holds(job_id);
create index  if not exists launch_holds_task_idx on public.launch_holds(clickup_task_id);
create unique index if not exists launch_holds_job_entry_uidx on public.launch_holds(job_id, entry_index);

-- RLS: logged-in buyers only (the app requires Supabase auth). Workers use the service-role key
-- (bypasses RLS) to read jobs and write back task ids.
alter table public.launch_jobs  enable row level security;
alter table public.launch_holds enable row level security;

drop policy if exists launch_jobs_authed_all  on public.launch_jobs;
drop policy if exists launch_holds_authed_all on public.launch_holds;
create policy launch_jobs_authed_all  on public.launch_jobs  for all to authenticated using (true) with check (true);
create policy launch_holds_authed_all on public.launch_holds for all to authenticated using (true) with check (true);
