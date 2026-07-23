-- ============================================================================
-- DRIMS — apply_meta_tables.sql
-- Paste this WHOLE file into the Supabase SQL Editor and Run.
-- ADDITIVE ONLY: creates tables/indexes/RLS policies. No DROP TABLE / DELETE /
-- TRUNCATE / UPDATE, and no ALTER against any existing table. Idempotent — safe
-- to run more than once. (The only DROPs are `drop policy if exists` on these
-- NEW tables' own policies, which touch no data.)
-- ============================================================================


-- ========== 1) Per-store Meta config (store-scoped launch identity) ==========
-- store_meta_config = non-secret (dashboard reads it for Meta Setup + resolution).
-- store_meta_secrets = system-user token + app secret, NEVER browser-readable.

create table if not exists store_meta_config (
  store_slug            text primary key,
  store_name            text,
  business_manager_id   text,
  ad_account_id         text,
  page_id               text,
  pixel_id              text,
  custom_conversion_id  text,
  ig_actor_id           text,
  default_landing       text,
  currency              text default 'USD',
  updated_at            timestamptz default now()
);
alter table store_meta_config enable row level security;
drop policy if exists smc_read on store_meta_config;
-- Dashboard (anon/authed) may READ non-secret config; all WRITES go through the service role.
create policy smc_read on store_meta_config for select using (true);

create table if not exists store_meta_secrets (
  store_slug         text primary key references store_meta_config(store_slug) on delete cascade,
  system_user_token  text,
  app_secret         text,
  updated_at         timestamptz default now()
);
alter table store_meta_secrets enable row level security;
-- INTENTIONALLY NO SELECT POLICY: anon/authenticated can NEVER read a token.
-- Only the service role (Vercel endpoints + local workers) bypasses RLS to read/write it.


-- ========== 2) Per-ad Live/Pause toggle backing tables ==========
-- meta_ads_sync.py mirrors REAL Meta status here (read-only); ad_toggle_worker.py applies flips.
-- Browser: SELECT only. Writes: service key only.

create table if not exists meta_accounts (
  account_id          text primary key,
  name                text,
  spend_cap_cents     bigint,      -- null / 0  => NO ASL set => toggle REFUSES activation
  amount_spent_cents  bigint,
  account_status      int,
  currency            text,
  synced_at           timestamptz
);

create table if not exists meta_ads (
  ad_id            text primary key,
  account_id       text not null,
  campaign_id      text,
  adset_id         text,
  name             text,
  status           text,          -- configured status (ACTIVE / PAUSED)
  effective_status text,          -- REAL delivery status from Meta (what the toggle reflects)
  desired_status   text,          -- pending toggle the buyer set (ACTIVE/PAUSED); null = settled
  last_error       text,          -- e.g. an ASL-refusal reason
  synced_at        timestamptz,
  updated_at       timestamptz
);
create index if not exists meta_ads_account_idx on meta_ads (account_id);
create index if not exists meta_ads_pending_idx on meta_ads (desired_status) where desired_status is not null;

alter table meta_accounts enable row level security;
alter table meta_ads      enable row level security;
drop policy if exists meta_accounts_read on meta_accounts;
drop policy if exists meta_ads_read      on meta_ads;
create policy meta_accounts_read on meta_accounts for select using (true);
create policy meta_ads_read      on meta_ads      for select using (true);

-- ============================================================================
-- END. Expected result: 4 new tables (store_meta_config, store_meta_secrets,
-- meta_accounts, meta_ads) + 2 indexes + RLS policies. Nothing else changes.
-- ============================================================================
