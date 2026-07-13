// Vercel Serverless Function — POST /api/store-meta-token  { slug, system_user_token, app_secret }
// WRITE-ONLY. Stores a store's system-user token + app secret in store_meta_secrets (service role).
// The token is NEVER returned by any endpoint and is not readable by the browser (RLS deny-select).
// Requires the store's store_meta_config row to exist first (FK).
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
    const secret = String(body.app_secret || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug required' });
    if (!token || !secret) return res.status(400).json({ error: 'system_user_token and app_secret required' });

    // The config row must exist (FK + it means the store was set up).
    const cfg = await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=store_slug`);
    if (!cfg || !cfg.length) return res.status(400).json({ error: 'save the store Meta config first, then the token' });

    await svc(`store_meta_secrets?on_conflict=store_slug`, {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ store_slug: slug, system_user_token: token, app_secret: secret, updated_at: new Date().toISOString() }),
    });
    // Never echo the token back — just confirm it's set.
    return res.status(200).json({ status: 'token_saved', slug, token_set: true });
  } catch (err) {
    console.error('[api/store-meta-token] error:', err);
    return res.status(500).json({ error: 'token save failed', detail: String((err && err.message) || err) });
  }
}
