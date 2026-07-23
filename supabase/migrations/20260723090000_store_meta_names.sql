-- ADDITIVE ONLY: cached human-readable names for a store's Meta identity, refreshed on
-- Meta Setup save / Test connection (lib/launch/meta_names.js). Code is fail-soft: it works
-- (live Graph reads, ids shown alone on failure) even before this is applied — applying it
-- just makes name display a DB read instead of a Graph call per render.
-- Paste into the Supabase SQL Editor and Run. Idempotent.
alter table store_meta_config add column if not exists bm_name      text;
alter table store_meta_config add column if not exists account_name text;
alter table store_meta_config add column if not exists page_name    text;
