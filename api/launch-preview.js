// Vercel Serverless Function — POST /api/launch-preview
// The REVIEW step: render each selected ad in Meta's REAL ad frame via /generatepreviews (GET),
// showing the actual copy, page identity, and creative image per placement. Read-only — no ad
// objects are created (generatepreviews only renders), and it is NOT blocked by the app's dev
// mode the way creative CREATION is.
//
// Fidelity note: pre-publish there is no uploaded video (video upload can't fit a serverless
// function), so the creative image is the Drive VIDEO THUMBNAIL (first frame) rendered as a photo
// creative. If an ad already carries a video_id (a prior build/resume), the real video is previewed
// instead. Either way copy + page + placement are exact.
//
// Same fail-closed identity path as launch-group-submit: session auth, store/task match, and the
// account/page resolved from the store's own config (never the client). Store-agnostic.
import crypto from 'node:crypto';
import { resolveOptions, buildPlan, applyEdits, LaunchOptionError } from '../lib/launch/options.js';
import { extractAdCopy, holdsQuery, holdsByTaskId, parseDocLink, fetchDocText } from '../lib/launch/ad_copy.js';
import { norm } from '../lib/launch/registry.js';
import { planInputsHash, signPreviewToken } from '../lib/launch/plan_hash.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYXp0bGNvcGt2bGZ6aXdybXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzk1MzEsImV4cCI6MjA5MjYxNTUzMX0.T9fXxkmHOAH6g6IG4-krLXxuj7tqzOn54WDeHsqFh3Y';
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CLICKUP_TOKEN = () => process.env.CLICKUP_LAUNCH_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v21.0';
// A small, sensible default set of placements to render. Overridable per request.
const DEFAULT_FORMATS = ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'FACEBOOK_STORY_MOBILE'];
const ALLOWED_FORMATS = new Set([...DEFAULT_FORMATS, 'DESKTOP_FEED_STANDARD', 'INSTAGRAM_STORY',
  'INSTAGRAM_REELS', 'FACEBOOK_REELS_MOBILE', 'RIGHT_COLUMN_STANDARD']);

async function requireUser(req) {
  const hdr = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!jwt) return { ok: false, code: 401, reason: 'Sign in to preview.' };
  try {
    const r = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`,
      { headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_ANON_KEY } });
    if (!r.ok) return { ok: false, code: 401, reason: 'Session expired — sign in again.' };
    const u = await r.json();
    if (!u || !u.id) return { ok: false, code: 401, reason: 'Session expired — sign in again.' };
    return { ok: true, user: u.email || u.id };
  } catch { return { ok: false, code: 401, reason: 'Could not verify your session.' }; }
}

async function svc(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`,
    { headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

const driveFileId = (u) => {
  const m = String(u || '').match(/\/d\/([A-Za-z0-9_-]{10,})/) || String(u || '').match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
};
const driveThumb = (u) => { const id = driveFileId(u); return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1080` : null; };

async function fetchTasks(taskIds) {
  const out = new Map();
  let holds = new Map();
  try { holds = holdsByTaskId(await svc(holdsQuery(taskIds))); } catch { /* description-only */ }
  await Promise.all(taskIds.map(async (id) => {
    const r = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}`,
      { headers: { Authorization: CLICKUP_TOKEN(), Accept: 'application/json' } });
    if (!r.ok) throw new Error(`ClickUp ${r.status} on task ${id}`);
    const t = await r.json();
    const cf = (t.custom_fields || []).find((c) => (c.name || '').trim().toLowerCase() === 'drive link');
    let copy = extractAdCopy({ holdAdCopy: holds.get(String(id)) || null, description: t.description || '' });
    if (!copy.primary_text) {
      const link = parseDocLink(t.description || '');
      if (link) { const dt = await fetchDocText(link, CLICKUP_TOKEN()); if (dt) copy = extractAdCopy({ holdAdCopy: holds.get(String(id)) || null, description: t.description || '', docText: dt }); }
    }
    out.set(String(id), { task_id: t.id, id: t.id, name: t.name || '',
      drive_link: cf && cf.value ? String(cf.value) : null, headline: copy.headline, primary_text: copy.primary_text,
      folder_id: t.folder && t.folder.id ? String(t.folder.id) : null, folder_name: (t.folder && t.folder.name) || '' });
  }));
  return out;
}

async function preview(account, spec, adFormat, token, proof) {
  const u = new URL(`${GRAPH}/${account}/generatepreviews`);
  u.searchParams.set('ad_format', adFormat);
  u.searchParams.set('creative', JSON.stringify({ object_story_spec: spec }));
  u.searchParams.set('access_token', token);
  u.searchParams.set('appsecret_proof', proof);
  try {
    const r = await fetch(u); const j = await r.json().catch(() => ({}));
    if (r.ok && j.data && j.data[0] && j.data[0].body) return { ok: true, body: j.data[0].body };
    return { ok: false, error: ((j.error || {}).message) || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.code).json({ ok: false, reason: auth.reason });
  if (!SERVICE() || !CLICKUP_TOKEN()) return res.status(503).json({ ok: false, reason: 'server env not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const slug = String(body.store_slug || '').trim();
    const taskIds = (Array.isArray(body.task_ids) ? body.task_ids.map(String) : []).slice(0, 8);   // cap the render fan-out
    const formats = (Array.isArray(body.formats) && body.formats.length ? body.formats : DEFAULT_FORMATS)
      .filter((f) => ALLOWED_FORMATS.has(f)).slice(0, 4);
    if (!slug || !taskIds.length) return res.status(400).json({ ok: false, reason: 'store_slug and task_ids required' });

    const cfg = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=*`) || [])[0];
    if (!cfg) return res.status(404).json({ ok: false, reason: `no Meta config for store '${slug}'` });
    const sec = (await svc(`store_meta_secrets?store_slug=eq.${encodeURIComponent(slug)}&select=system_user_token,app_secret`) || [])[0];
    if (!sec || !sec.system_user_token || !sec.app_secret) return res.status(400).json({ ok: false, reason: `no token stored for '${slug}'` });

    const fetched = await fetchTasks(taskIds);
    const selected = taskIds.map((id) => fetched.get(id));

    // Same store/task match guard as the launcher — a preview must reflect the right store.
    const folders = new Map();
    for (const t of selected) if (t.folder_id) folders.set(t.folder_id, t.folder_name || '');
    if (folders.size > 1) return res.status(400).json({ ok: false, status: 'tasks_span_multiple_stores', reason: `tasks span ${folders.size} stores` });
    const fname = [...folders.values()][0] || '';
    if (!new Set([norm(cfg.store_name), norm(cfg.store_slug)].filter(Boolean)).has(norm(fname)))
      return res.status(400).json({ ok: false, status: 'store_task_mismatch', reason: `tasks belong to '${fname}', config is '${cfg.store_name || cfg.store_slug}'` });

    let plan;
    try {
      plan = buildPlan(selected, resolveOptions(body.options || {}, cfg), cfg, { dateStr: new Date().toISOString().slice(0, 10) });
      if (body.edits) plan = applyEdits(plan, body.edits);
    } catch (e) { if (e instanceof LaunchOptionError) return res.status(400).json({ ok: false, reason: e.message }); throw e; }

    const token = sec.system_user_token, proof = crypto.createHmac('sha256', sec.app_secret).update(sec.system_user_token).digest('hex');
    const pageId = plan.page_id;
    const ads = plan.adsets.flatMap((a) => a.ads);

    const out = [];
    for (const ad of ads) {
      if (!ad.primary_text) { out.push({ task_id: ad.task_id, name: ad.name, skipped: 'no ad copy' }); continue; }
      // video_data if the ad already has an uploaded video; else a photo creative from the thumbnail.
      const cta = { type: 'SHOP_NOW', value: { link: ad.landing_url || cfg.default_landing || '' } };
      const spec = ad.video_id
        ? { page_id: pageId, video_data: { video_id: ad.video_id, message: ad.primary_text, title: ad.headline || '', call_to_action: cta } }
        : { page_id: pageId, link_data: { message: ad.primary_text, name: ad.headline || '', link: (ad.landing_url || cfg.default_landing || ''), picture: driveThumb(ad.drive_link || ad.drive_url), call_to_action: { type: 'SHOP_NOW' } } };
      const rendered = {};
      for (const f of formats) rendered[f] = await preview(plan.account_id, spec, f, token, proof);
      out.push({ task_id: ad.task_id, name: ad.name, kind: ad.video_id ? 'video' : 'thumbnail', previews: rendered });
    }
    // Item-4 live guard: a preview token bound to (user, exact inputs). The live-launch path in
    // /api/launch-group-submit requires it — so a live launch is impossible without having rendered
    // a preview of THIS plan. Any later edit changes the hash and invalidates the token.
    const rendered_any = out.some((a) => a.previews && Object.values(a.previews).some((p) => p.ok));
    const preview_token = rendered_any
      ? signPreviewToken(auth.user, planInputsHash({ store_slug: slug, task_ids: taskIds, options: body.options, edits: body.edits }), SERVICE(), Date.now())
      : null;
    return res.status(200).json({ ok: true, account_id: plan.account_id, page_id: pageId, formats, ads: out, preview_token });
  } catch (err) {
    console.error('[api/launch-preview] error:', err);
    return res.status(500).json({ ok: false, reason: String((err && err.message) || err) });
  }
}
