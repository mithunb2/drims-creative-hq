// Vercel Serverless Function — POST /api/store-meta-token
// WRITE-ONLY. Stores a store's launch credentials in store_meta_secrets (service role). The token is
// NEVER returned by any endpoint and is not readable by the browser (RLS deny-select). Requires the
// store's store_meta_config row to exist first (FK).
//
// Two write shapes:
//   { slug, system_user_token, app_secret? }  — save an OWN token. app_secret is OPTIONAL; when
//        omitted/blank it is stored null and the server falls back to the global META_APP_SECRET
//        (ONE Meta app). Saving an own token clears any prior inherit_bm_token opt-in.
//   { slug, inherit_bm_token: true }          — opt into reusing the token already saved on another
//        store in the SAME Business Manager. No token is pasted or copied; it is resolved at read
//        time. Rejected unless a donor token actually exists for this store's BM.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function svc(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`,
    { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SERVICE) return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set in the Vercel env' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const slug = String(body.slug || body.store_slug || '').trim();
    const token = String(body.system_user_token || '').trim();
    const secret = String(body.app_secret || '').trim();   // OPTIONAL override — blank => global env
    const inherit = body.inherit_bm_token === true || body.inherit_bm_token === 'true';
    if (!slug) return res.status(400).json({ error: 'slug required' });
    if (!token && !inherit) return res.status(400).json({ error: 'provide system_user_token, or set inherit_bm_token to reuse the BM token' });

    // The config row must exist (FK + it means the store was set up).
    const cfg = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=store_slug,business_manager_id`) || [])[0];
    if (!cfg) return res.status(400).json({ error: 'save the store Meta config first, then the token' });

    if (!token && inherit) {
      // Opt into BM-token reuse. Verify a donor actually exists for this store's BM before recording
      // the intent — an opt-in that resolves to nothing would leave the store silently unlaunchable.
      const { findBmTokenDonor } = await import('../lib/launch/secrets.js');
      const donor = await findBmTokenDonor(SUPABASE_URL, SERVICE, cfg.business_manager_id, slug);
      if (!donor) return res.status(400).json({ error: 'no token is saved on any other store in this Business Manager to reuse — enter one here instead' });
      // Clear any own token so resolution uses the inherited one; leave app_secret override untouched.
      await svc(`store_meta_secrets?on_conflict=store_slug`, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ store_slug: slug, system_user_token: null, inherit_bm_token: true, updated_at: new Date().toISOString() }),
      });
      return res.status(200).json({ status: 'token_inherited', slug, token_set: true, inherited_from: donor.store_slug });
    }

    // Save an OWN token. app_secret is optional: store null when blank so reads fall back to the
    // global META_APP_SECRET. Saving a real token clears any prior inherit opt-in.
    await svc(`store_meta_secrets?on_conflict=store_slug`, {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ store_slug: slug, system_user_token: token, app_secret: secret || null, inherit_bm_token: false, updated_at: new Date().toISOString() }),
    });
    // Never echo the token back — just confirm it's set.
    return res.status(200).json({ status: 'token_saved', slug, token_set: true, app_secret_source: secret ? 'own' : 'default' });
  } catch (err) {
    console.error('[api/store-meta-token] error:', err);
    return res.status(500).json({ error: 'token save failed', detail: String((err && err.message) || err) });
  }
}
