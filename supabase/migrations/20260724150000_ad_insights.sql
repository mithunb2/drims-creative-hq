-- ADDITIVE ONLY. Per-ad and per-account performance metrics from the Meta Insights API,
-- populated by meta_ads_sync (read-only vs Meta). NULL is the contract for "not tracked" — the UI
-- renders NULL revenue / roas / cpa as "—" with a reason, never a fake 0. roas_trackable records
-- whether the account reports purchase VALUE at all (pixel/CAPI Purchase events), so the UI can say
-- "no purchase tracking" vs "0 purchases so far".
--
-- Code is FAIL-SOFT without this: meta_ads_sync writes core status/ASL rows regardless, and attempts
-- the insights columns in a SEPARATE upsert that is swallowed if the columns don't exist yet — so
-- applying this migration is what turns the metrics on; nothing breaks before it.
--
-- Paste into the Supabase SQL Editor and Run. Idempotent.

alter table meta_ads add column if not exists spend_today_cents    bigint;
alter table meta_ads add column if not exists spend_lifetime_cents bigint;
alter table meta_ads add column if not exists revenue_cents        bigint;      -- NULL = no purchase value tracked
alter table meta_ads add column if not exists purchases            integer;
alter table meta_ads add column if not exists roas                 numeric;     -- NULL = "—"
alter table meta_ads add column if not exists cpa_cents            bigint;      -- NULL = "—" (no purchases)
alter table meta_ads add column if not exists cpm_cents            bigint;
alter table meta_ads add column if not exists impressions          bigint;
alter table meta_ads add column if not exists roas_trackable       boolean;     -- account reports purchase VALUE?
alter table meta_ads add column if not exists insights_synced_at   timestamptz;

alter table meta_accounts add column if not exists spend_today_cents    bigint;
alter table meta_accounts add column if not exists spend_lifetime_cents bigint;
alter table meta_accounts add column if not exists revenue_cents        bigint;
alter table meta_accounts add column if not exists purchases            integer;
alter table meta_accounts add column if not exists roas                 numeric;
alter table meta_accounts add column if not exists cpa_cents            bigint;
alter table meta_accounts add column if not exists cpm_cents            bigint;
alter table meta_accounts add column if not exists impressions          bigint;
alter table meta_accounts add column if not exists roas_trackable       boolean;
alter table meta_accounts add column if not exists insights_synced_at   timestamptz;
