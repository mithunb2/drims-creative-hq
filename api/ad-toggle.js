// Vercel Serverless Function — POST /api/ad-toggle   { ad_id, desired: 'ACTIVE'|'PAUSED' }
// Records a per-ad Live/Pause INTENT (meta_ads.desired_status). It does NOT call Meta and holds NO
// Meta token — the isolated local ad_toggle_worker performs the actual activate/pause and the
// authoritative live ASL re-check. This endpoint enforces the money gate on SYNCED data as a first
// line: activation is REFUSED if the ad's account has no spending limit (meta_accounts.spend_cap_cents
// null/0). Pausing is always allowed. Per-ad only — it touches the one ad_id.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function svcGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function svcPatch(table, filter, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patch ${table} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
    const ad_id = String(body.ad_id || '').trim();
    const desired = String(body.desired || '').trim().toUpperCase();
    if (!ad_id) return res.status(400).json({ error: 'ad_id required' });
    if (desired !== 'ACTIVE' && desired !== 'PAUSED') return res.status(400).json({ error: "desired must be 'ACTIVE' or 'PAUSED'" });

    const ad = (await svcGet(`meta_ads?ad_id=eq.${encodeURIComponent(ad_id)}&select=ad_id,account_id,effective_status`) || [])[0];
    if (!ad) return res.status(404).json({ error: 'ad not found in meta_ads (run meta_ads_sync)' });

    // MONEY GATE (first line): activation requires a real ASL on the ad's account.
    if (desired === 'ACTIVE') {
      const acct = (await svcGet(`meta_accounts?account_id=eq.${encodeURIComponent(ad.account_id)}&select=spend_cap_cents`) || [])[0];
      const cap = acct && acct.spend_cap_cents;
      if (!cap || Number(cap) <= 0) {
        return res.status(409).json({ status: 'refused_no_asl',
          reason: 'This account has no spending limit (ASL). Set an account spending limit before an ad can go live.' });
      }
    }

    // Record the intent. The local ad_toggle_worker applies it to Meta + re-checks the live ASL.
    await svcPatch('meta_ads', `ad_id=eq.${encodeURIComponent(ad_id)}`, { desired_status: desired, last_error: null });
    return res.status(202).json({ status: 'toggle_queued', ad_id, desired,
      message: desired === 'ACTIVE'
        ? 'Going live requested — the ad will activate on Meta (ASL-capped). Refresh to see live status.'
        : 'Pause requested — the ad will stop delivering. Refresh to see paused status.' });
  } catch (err) {
    console.error('[api/ad-toggle] error:', err);
    return res.status(500).json({ error: 'toggle failed', detail: String((err && err.message) || err) });
  }
}
