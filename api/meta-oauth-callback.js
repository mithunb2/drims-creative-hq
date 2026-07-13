// Vercel Serverless Function — GET /api/meta-oauth-callback?code=...&state=...
// Facebook redirects here after login. Server-side: exchange code → SHORT-LIVED user token, run the
// read-only DISCOVERY enumeration, then postMessage ONLY the non-secret asset tree back to the opener
// and close. The user token is used transiently here and is NEVER stored, logged, or returned to the
// browser — it's discovery-only. Runtime launching still uses the stored system-user token.
import crypto from 'node:crypto';
const GRAPH = 'https://graph.facebook.com/v21.0';

async function fb(path, token, proof, fields) {
  const u = new URL(`${GRAPH}/${path}`);
  u.searchParams.set('fields', fields); u.searchParams.set('limit', '200');
  u.searchParams.set('access_token', token); u.searchParams.set('appsecret_proof', proof);
  try { const r = await fetch(u); const j = await r.json().catch(() => ({})); return r.ok ? (j.data || []) : []; }
  catch { return []; }
}

async function enumerateBm(bmId, token, proof) {
  const [ownedAcc, clientAcc, ownedPg, clientPg, pixels, ccs, igs] = await Promise.all([
    fb(`${bmId}/owned_ad_accounts`, token, proof, 'account_id,name,currency,account_status'),
    fb(`${bmId}/client_ad_accounts`, token, proof, 'account_id,name,currency,account_status'),
    fb(`${bmId}/owned_pages`, token, proof, 'id,name'),
    fb(`${bmId}/client_pages`, token, proof, 'id,name'),
    fb(`${bmId}/adspixels`, token, proof, 'id,name'),
    fb(`${bmId}/customconversions`, token, proof, 'id,name'),
    fb(`${bmId}/instagram_accounts`, token, proof, 'id,username'),
  ]);
  const acct = (a, owned) => ({ ad_account_id: 'act_' + a.account_id, name: a.name, currency: a.currency, status: a.account_status, bm_owned: owned });
  return {
    ad_accounts: [...ownedAcc.map((a) => acct(a, true)), ...clientAcc.map((a) => acct(a, false))],
    pages: [...ownedPg.map((p) => ({ page_id: p.id, name: p.name, bm_owned: true })),
            ...clientPg.map((p) => ({ page_id: p.id, name: p.name, bm_owned: false }))],
    pixels: pixels.map((p) => ({ pixel_id: p.id, name: p.name })),
    custom_conversions: ccs.map((c) => ({ custom_conversion_id: c.id, name: c.name })),
    ig_accounts: igs.map((g) => ({ ig_actor_id: g.id, username: g.username })),
  };
}

function page(payload, origin) {
  // postMessage the (non-secret) result to the opener, then close. No token in here.
  return `<!doctype html><meta charset=utf8><body style="font:14px system-ui;padding:24px">
  Discovery complete — you can close this window.
  <script>try{window.opener&&window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(origin)});}catch(e){}
  setTimeout(function(){window.close();},300);</script></body>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const APP_ID = process.env.META_APP_ID || '', APP_SECRET = process.env.META_APP_SECRET || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${host}`;
  const { code, state, error } = req.query || {};
  if (!APP_ID || !APP_SECRET) return res.status(200).send(page({ type: 'meta-discovery', state, error: 'META_APP_ID/META_APP_SECRET not set in the Vercel env' }, origin));
  if (error || !code) return res.status(200).send(page({ type: 'meta-discovery', state, error: String(error || 'login cancelled / no code') }, origin));
  try {
    const redirect = `${origin}/api/meta-oauth-callback`;
    const tokUrl = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(APP_ID)}&client_secret=${encodeURIComponent(APP_SECRET)}&redirect_uri=${encodeURIComponent(redirect)}&code=${encodeURIComponent(code)}`;
    const tok = await (await fetch(tokUrl)).json();
    const token = tok.access_token;
    if (!token) return res.status(200).send(page({ type: 'meta-discovery', state, error: (tok.error || {}).message || 'token exchange failed' }, origin));
    const proof = crypto.createHmac('sha256', APP_SECRET).update(token).digest('hex');
    const bms = await fb('me/businesses', token, proof, 'id,name');
    const businesses = [];
    for (const bm of bms) businesses.push({ business_manager_id: bm.id, name: bm.name, ...(await enumerateBm(bm.id, token, proof)) });
    // token goes out of scope here — never stored/returned.
    return res.status(200).send(page({ type: 'meta-discovery', state, data: { businesses } }, origin));
  } catch (err) {
    return res.status(200).send(page({ type: 'meta-discovery', state, error: String((err && err.message) || err) }, origin));
  }
}
