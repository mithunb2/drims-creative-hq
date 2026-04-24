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

  // --- App branding ---
  APP_NAME: 'DRIMS Creative HQ',
  // localStorage keys are namespaced by this so multiple DRIMS tools on the
  // same domain don't collide. Safe to change; changing it logs users out.
  STORAGE_PREFIX: 'drims',
};
