// Vercel Serverless Function — GET /api/store-meta-names?slug=<slug>
// Resolve + cache the store's BM / ad account / page NAMES via Graph (store's own token,
// appsecret_proof, read-only). Fail-soft per id: a failed read returns null for that name and
// the UI shows the id alone — never a blanked field. Session-gated (privileged token used
// server-side). Names are cached onto store_meta_config (best-effort; tolerates the name
// columns not existing yet).
import { resolveMetaNames, cacheMetaNames } from '../lib/launch/meta_names.js';
import { resolveStoreSecret } from '../lib/launch/secrets.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYXp0bGNvcGt2bGZ6aXdybXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzk1MzEsImV4cCI6MjA5MjYxNTUzMX0.T9fXxkmHOAH6g6IG4-krLXxuj7tqzOn54WDeHsqFh3Y';
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function requireUser(req) {
  const hdr = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!jwt) return false;
  try {
    const r = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`,
      { headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_ANON_KEY } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}

async function svc(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`,
    { headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await requireUser(req))) return res.status(401).json({ ok: false, reason: 'Sign in first.' });
  if (!SERVICE()) return res.status(503).json({ ok: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not set in the Vercel env' });

  try {
    const slug = String((req.query && req.query.slug) || '').trim();
    if (!slug) return res.status(400).json({ ok: false, reason: 'slug required' });
    const cfg = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=*`) || [])[0];
    if (!cfg) return res.status(404).json({ ok: false, reason: 'no Meta config for this store' });

    // Cached names first (columns may not exist yet -> undefined -> falls through to live read).
    let names = { bm_name: cfg.bm_name || null, account_name: cfg.account_name || null, page_name: cfg.page_name || null };
    const missing = !(names.bm_name && names.account_name && names.page_name);
    if (missing || req.query.refresh === '1') {
      const { token, secret } = await resolveStoreSecret(SUPABASE_URL, SERVICE(), slug);
      if (token && secret) {
        const live = await resolveMetaNames(cfg, token, secret);
        names = { bm_name: live.bm_name || names.bm_name, account_name: live.account_name || names.account_name,
          page_name: live.page_name || names.page_name };
        await cacheMetaNames(SUPABASE_URL, SERVICE(), slug, names);   // best-effort
      }
    }
    return res.status(200).json({ ok: true, slug,
      bm: { id: cfg.business_manager_id || null, name: names.bm_name },
      account: { id: cfg.ad_account_id || null, name: names.account_name },
      page: { id: cfg.page_id || null, name: names.page_name } });
  } catch (err) {
    console.error('[api/store-meta-names] error:', err);
    return res.status(500).json({ ok: false, reason: String((err && err.message) || err) });
  }
}
