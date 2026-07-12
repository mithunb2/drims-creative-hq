// DRIMS Creative HQ — runtime config.
// Fill in real values after provisioning Supabase and ClickUp.
// Safe to commit: anon key is public by design (Supabase RLS protects data).
//
// This file is loaded BEFORE the main HTML's <script> block runs,
// so `window.DRIMS_CONFIG` is available everywhere in the app.

window.DRIMS_CONFIG = {
  // --- Supabase (Settings → API in the Supabase dashboard) ---
  SUPABASE_URL:       'https://zeaztlcopkvlfziwrmto.supabase.co',
  SUPABASE_ANON_KEY:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYXp0bGNvcGt2bGZ6aXdybXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzk1MzEsImV4cCI6MjA5MjYxNTUzMX0.T9fXxkmHOAH6g6IG4-krLXxuj7tqzOn54WDeHsqFh3Y',

  // --- ClickUp (from ClickUp URL: app.clickup.com/<workspace_id>/...) ---
  CLICKUP_WORKSPACE_ID:        '9013714387',

  // The folder where inspiration-library ClickUp docs get created.
  // Create a folder in your workspace and grab its ID from the URL
  // (app.clickup.com/.../f/<folder_id>).
  CLICKUP_INSPIRATION_FOLDER_ID: '901318110695',

  // --- Team capacity view ---
  // People with a Jibble mapping but who don't actually track time (founders /
  // media buyers). Excluded from the capacity/hours view by stable ClickUp user id.
  // (People with NO Jibble mapping are already excluded automatically.)
  // Edit this list to change who's excluded — no code change needed.
  CAPACITY_EXCLUDE_IDS: [
    '126242856', // Mithun Sharma (founder)
    '88022265',  // Deepa Ch
    '88004300',  // GSiddharth Shinge (Sid — media buyer)
    '100048167', // Sourabh (media buyer)
  ],

  // --- Inspiration image uploads (Supabase Storage, private bucket) ---
  // Winning/inspiration IMAGE files upload here (logged-in only, RLS-gated).
  // Change the bucket name here if you rename it in Supabase — no code change.
  INSPIRATION_BUCKET: 'inspiration-uploads',

  // --- App branding ---
  APP_NAME: 'DRIMS Creative HQ',
  // localStorage keys are namespaced by this so multiple DRIMS tools on the
  // same domain don't collide. Safe to change; changing it logs users out.
  STORAGE_PREFIX: 'drims',

  // --- Launch pipeline UI visibility (Phase 1 ship) ---
  // Hide the gated launch tabs (Doc→Tasks, Add Automation) on these hostnames until the
  // Phase-2 security runbook is cleared, so the team doesn't see disabled tabs. This is
  // VISIBILITY ONLY — the real gate is the SERVER env flag META_LAUNCH_ALLOW_LIVE_WRITES
  // (launch physically cannot fire without it, regardless of the UI). Previews and
  // localhost still show the tabs for development. Empty this list to reveal everywhere.
  LAUNCH_UI_HOSTS_HIDDEN: ['drims-creative-hq.vercel.app'],

  // --- Store launch-account overrides (DISPLAY parity) ---
  // slug -> ad account the store's launches actually build on. Mirrors the server's
  // lib/launch/store_launch_overrides.json so the UI SHOWS the same account the build uses
  // (no display/launch mismatch). The server file is authoritative; keep this in sync with it.
  STORE_LAUNCH_ACCOUNTS: {
    cake_craft_academy: 'act_2501861963596691',  // TEST: CCA-named launches build on the Lolis test account
  },
};
