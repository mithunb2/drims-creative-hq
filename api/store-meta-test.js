// Vercel Serverless Function — POST /api/store-meta-test  { slug }
// READ-ONLY per-store connection test for onboarding. Reads the store's config + token (service role),
// runs Graph GETs with appsecret_proof, returns a per-check verdict. The token is used transiently
// server-side for READS ONLY (no writes, no spend), is fetched from Supabase per request (never in the
// Vercel env), and is NEVER returned to the browser. Checks: token valid? account reachable? ASL set?
// page usable (CREATE_CONTENT+ADVERTISE) + BM-owned?
import crypto from 'node:crypto';
import { resolveMetaNames, cacheMetaNames } from '../lib/launch/meta_names.js';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const G = 'https://graph.facebook.com/v21.0';

async function svcGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function fb(path, token, proof, fields) {
  const u = new URL(`${G}/${path}`);
  u.searchParams.set('access_token', token); u.searchParams.set('appsecret_proof', proof);
  if (fields) u.searchParams.set('fields', fields);
  u.searchParams.set('limit', '200');
  try { const r = await fetch(u); const j = await r.json().catch(() => ({})); return { status: r.status, j }; }
  catch (e) { return { status: 0, j: { error: { message: String(e).slice(0, 120) } } }; }
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
    const slug = String(body.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const cfg = (await svcGet(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=*`) || [])[0];
    if (!cfg) return res.status(404).json({ error: 'no Meta config for this store — save it first' });
    const sec = (await svcGet(`store_meta_secrets?store_slug=eq.${encodeURIComponent(slug)}&select=system_user_token,app_secret`) || [])[0];
    if (!sec || !sec.system_user_token || !sec.app_secret) return res.status(400).json({ error: 'no token set for this store — enter it first' });

    const token = sec.system_user_token, secret = sec.app_secret;
    const proof = crypto.createHmac('sha256', secret).update(token).digest('hex');
    const out = {};

    const me = await fb('me', token, proof, 'id,name');
    out.token_valid = { ok: me.status === 200, who: me.j.name, detail: me.status === 200 ? 'ok' : ((me.j.error || {}).message || `HTTP ${me.status}`) };

    const acc = await fb(cfg.ad_account_id || '', token, proof, 'name,account_status,currency,spend_cap,amount_spent');
    const cap = acc.j.spend_cap; const capSet = cap !== undefined && cap !== null && cap !== '' && cap !== '0';
    out.account = { ok: acc.status === 200, name: acc.j.name, status: acc.j.account_status, currency: acc.j.currency,
      detail: acc.status === 200 ? 'reachable' : ((acc.j.error || {}).message || `HTTP ${acc.status}`) };
    out.asl = { ok: !!capSet, spend_cap_usd: capSet ? Number(cap) / 100 : null,
      detail: capSet ? `$${(Number(cap) / 100).toFixed(2)} ceiling` : 'NO spending limit — activation will be refused' };

    const accts = await fb('me/accounts', token, proof, 'id,name,tasks');
    const p = ((accts.j.data) || []).find((x) => x.id === cfg.page_id);
    const tasks = (p && p.tasks) || [];
    const tasksOk = !!p && tasks.includes('CREATE_CONTENT') && tasks.includes('ADVERTISE');
    out.page_tasks = { ok: tasksOk, tasks,
      detail: tasksOk ? 'Create content + Advertise present' : (!p ? 'page not assigned to this system user' : `missing tasks (has ${tasks.join(', ') || 'none'})`) };

    // INFORMATIONAL ONLY — never part of readiness. Cross-BM is fully supported (Meta's agency
    // model): a store's page may live in a DIFFERENT Business Manager and be shared into this one,
    // in which case it appears under client_pages and NEVER under owned_pages. The real capability
    // gate is page_tasks above (system user's assigned pages + CREATE_CONTENT/ADVERTISE), which is
    // ownership-agnostic. (The old page_bm_owned readiness check falsely rejected valid cross-BM
    // setups — the actual historical blocker was app dev-mode, not page ownership.)
    let ownership = 'unknown';
    if (cfg.business_manager_id) {
      const [op, cp] = await Promise.all([
        fb(`${cfg.business_manager_id}/owned_pages`, token, proof, 'id'),
        fb(`${cfg.business_manager_id}/client_pages`, token, proof, 'id'),
      ]);
      if (((op.j.data) || []).some((x) => x.id === cfg.page_id)) ownership = 'bm_owned';
      else if (((cp.j.data) || []).some((x) => x.id === cfg.page_id)) ownership = 'shared_into_bm';
      else ownership = 'not_visible_in_bm';
    }
    out.page_ownership = { ok: true, ownership,
      detail: { bm_owned: 'BM-owned', shared_into_bm: 'shared into this BM (cross-BM — supported)',
        not_visible_in_bm: 'not listed in this BM (owned or client) — check the share', unknown: 'no BM id configured' }[ownership] };

    out.ready = ['token_valid', 'account', 'asl', 'page_tasks'].every((k) => out[k].ok);

    // Refresh the cached BM/account/page NAMES as part of every test (fail-soft: a failed read
    // leaves that name null and the UI shows the id alone; cache write tolerates missing columns).
    const names = await resolveMetaNames(cfg, token, secret);
    await cacheMetaNames(SUPABASE_URL, SERVICE, slug, names);

    return res.status(200).json({ slug, checks: out, names });   // NB: token never included in the response
  } catch (err) {
    console.error('[api/store-meta-test] error:', err);
    return res.status(500).json({ error: 'test failed', detail: String((err && err.message) || err) });
  }
}
