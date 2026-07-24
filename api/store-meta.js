// Vercel Serverless Function — per-store Meta config (Part 1). NON-SECRET config only.
//   GET  /api/store-meta?slug=<slug>   -> { config, token_set }   (token itself is NEVER returned)
//   GET  /api/store-meta               -> { configs: [...] }       (list, non-secret)
//   POST /api/store-meta  { slug, ...fields }  -> upsert store_meta_config
// Tokens live in store_meta_secrets and are written via /api/store-meta-token — never here.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const FIELDS = ['store_name', 'business_manager_id', 'ad_account_id', 'page_id', 'pixel_id',
  'custom_conversion_id', 'ig_actor_id', 'default_landing', 'currency'];

async function svc(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`,
    { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!SERVICE) return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set in the Vercel env' });

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      // BM-donor lookup: does the given Business Manager already have a token saved on some OTHER
      // store? Drives the "reuse the BM token" checkbox live as a BM id is typed (pre-save). The
      // token itself is never touched — only whether a donor exists + which store it is.
      if (q.bm) {
        const { findBmTokenDonor } = await import('../lib/launch/secrets.js');
        const donor = await findBmTokenDonor(SUPABASE_URL, SERVICE, String(q.bm), String(q.exclude || ''));
        let donor_name = null;
        if (donor) {
          const drow = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(donor.store_slug)}&select=store_name`) || [])[0];
          donor_name = (drow && drow.store_name) || donor.store_slug;
        }
        return res.status(200).json({ bm_token_available: !!donor, donor_slug: donor ? donor.store_slug : null, donor_name });
      }
      const slug = q.slug ? String(q.slug) : '';
      if (!slug) {
        const configs = await svc(`store_meta_config?select=*&order=store_slug`);
        return res.status(200).json({ configs: configs || [] });
      }
      const cfg = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=*`) || [])[0] || null;
      // Resolved token state (own token / inherited BM token / genuinely none) + secret source.
      // The token value is NEVER read out — tokenState() strips it server-side.
      const { tokenState } = await import('../lib/launch/secrets.js');
      const token_state = await tokenState(SUPABASE_URL, SERVICE, slug);
      const token_set = token_state.source !== 'none';   // legacy field: is a token effectively available?
      return res.status(200).json({ config: cfg, token_set, token_state });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const slug = String(body.slug || body.store_slug || '').trim();
      if (!slug) return res.status(400).json({ error: 'slug required' });
      const row = { store_slug: slug, updated_at: new Date().toISOString() };
      for (const f of FIELDS) if (body[f] !== undefined) row[f] = body[f] === '' ? null : body[f];
      await svc(`store_meta_config?on_conflict=store_slug`,
        { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });

      // Refresh cached BM/account/page names on save — ids may have changed and stale names lie.
      // Best-effort: no token yet (mid-onboarding) or a failed read just leaves names for the
      // Test-connection refresh; a failed read never blanks the id display.
      try {
        const { resolveMetaNames, cacheMetaNames } = await import('../lib/launch/meta_names.js');
        const { resolveStoreSecret } = await import('../lib/launch/secrets.js');
        const { token, secret } = await resolveStoreSecret(SUPABASE_URL, SERVICE, slug);
        if (token && secret) {
          const cfg = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=*`) || [])[0];
          if (cfg) await cacheMetaNames(SUPABASE_URL, SERVICE, slug, await resolveMetaNames(cfg, token, secret));
        }
      } catch { /* name refresh is never allowed to fail a save */ }
      return res.status(200).json({ status: 'saved', slug });
    }
    return res.status(405).json({ error: 'GET or POST' });
  } catch (err) {
    console.error('[api/store-meta] error:', err);
    return res.status(500).json({ error: 'store-meta failed', detail: String((err && err.message) || err) });
  }
}
