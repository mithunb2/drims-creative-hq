// DRIMS Creative HQ — runtime config.
// Fill in real values after provisioning Supabase and ClickUp.
// Safe to commit: anon key is public by design (Supabase RLS protects data).
//
// This file is loaded BEFORE the main HTML's <script> block runs,
// so `window.DRIMS_CONFIG` is available everywhere in the app.

window.DRIMS_CONFIG = {
  // --- Supabase (Settings → API in the Supabase dashboard) ---
  SUPABASE_URL:       'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY:  'PASTE_YOUR_ANON_JWT_HERE',

  // --- ClickUp (from ClickUp URL: app.clickup.com/<workspace_id>/...) ---
  CLICKUP_WORKSPACE_ID:        'YOUR_WORKSPACE_ID',

  // The folder where inspiration-library ClickUp docs get created.
  // Create a folder in your workspace and grab its ID from the URL
  // (app.clickup.com/.../f/<folder_id>).
  CLICKUP_INSPIRATION_FOLDER_ID: 'YOUR_FOLDER_ID',

  // --- App branding ---
  APP_NAME: 'DRIMS Creative HQ',
  // localStorage keys are namespaced by this so multiple DRIMS tools on the
  // same domain don't collide. Safe to change; changing it logs users out.
  STORAGE_PREFIX: 'drims',
};
