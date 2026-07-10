-- ============================================================
-- Launch EDIT layer: buyer overrides (server-validated) + tamper-resistant audit log.
-- Edits never overwrite the doc-held values — they layer on top, so provenance survives and
-- edits are reversible (revert = drop the override key). Effective value = override ?? held.
-- Overrides may be written ONLY by the service role (the validated /api/launch-edit endpoint);
-- the browser keeps INSERT (commit) + SELECT (read) but NOT update, so it cannot bypass validation.
-- ============================================================

-- Override layers (default empty; effective = held merged with these)
alter table public.launch_jobs  add column if not exists overrides jsonb not null default '{}'::jsonb;
alter table public.launch_holds add column if not exists overrides jsonb not null default '{}'::jsonb;

-- Append-only audit trail: WHO changed WHAT, old -> new, WHEN, on which task.
create table if not exists public.launch_edit_log (
  id              uuid primary key default uuid_generate_v4(),
  job_id          uuid not null references public.launch_jobs(id)  on delete cascade,
  hold_id         uuid references public.launch_holds(id) on delete cascade,   -- null = job-level (budget/account)
  field           text not null,                       -- budget_amount | spend_cap | account_id | ad_set | ad_copy | ad_name_short | ad_name_full ...
  old_value       text,
  new_value       text,
  safety_critical boolean not null default false,       -- budget / ad-account changes = true (spend / where-money-goes)
  actor_email     text,                                 -- from the verified Supabase session (real person)
  actor_user_id   uuid,
  created_at      timestamptz not null default now()
);
create index if not exists launch_edit_log_job_idx  on public.launch_edit_log(job_id, created_at desc);
create index if not exists launch_edit_log_hold_idx on public.launch_edit_log(hold_id);

alter table public.launch_edit_log enable row level security;

-- Re-scope launch_jobs / launch_holds RLS: authenticated may INSERT (commit) + SELECT (read),
-- but UPDATE/DELETE are NOT granted -> overrides can only be written by the service role
-- (which bypasses RLS) via /api/launch-edit. The Mac Mini workers already use the service role.
drop policy if exists launch_jobs_authed_all  on public.launch_jobs;
drop policy if exists launch_holds_authed_all on public.launch_holds;
create policy launch_jobs_authed_ins  on public.launch_jobs  for insert to authenticated with check (true);
create policy launch_jobs_authed_sel  on public.launch_jobs  for select to authenticated using (true);
create policy launch_holds_authed_ins on public.launch_holds for insert to authenticated with check (true);
create policy launch_holds_authed_sel on public.launch_holds for select to authenticated using (true);

-- Audit log: authenticated can READ (the surface shows the trail); nobody but the service role
-- can write it -> the record is authoritative and append-only from the server.
drop policy if exists launch_edit_log_sel on public.launch_edit_log;
create policy launch_edit_log_sel on public.launch_edit_log for select to authenticated using (true);
