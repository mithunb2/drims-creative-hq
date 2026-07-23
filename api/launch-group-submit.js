// Vercel Serverless Function — POST /api/launch-group-submit
// The multi-select GROUPED launch endpoint (ClickUp Production Tasks tab → "Publish to Meta").
//
// The client sends INPUTS ONLY — { folder_id, store_slug, task_ids, options, edits }. A
// client-supplied plan is NEVER trusted: the server re-fetches the selected tasks from ClickUp
// itself (authoritative Drive links), re-resolves the store's Meta identity from Supabase, and
// rebuilds the plan through the SAME engine the review UI used (lib/launch/options.js), so what
// is validated here is exactly what the operator reviewed — recomputed, not replayed.
//
// FAIL-CLOSED GUARANTEES (each independently refuses the request):
//   • auth        — caller must present a valid Supabase session JWT (same gate as clickup-tasks).
//   • drive links — every selected task must carry a Drive link, verified server-side.
//   • isolation   — the final account_id/page_id must be the store's OWN configured identity
//                   (store_meta_config) or its explicit entry in store_launch_overrides.json.
//                   Any other id — however it got into the payload — is rejected. assert-account.
//   • PAUSED     — plan.status must be 'PAUSED' and do_activate false (the engine emits nothing
//                   else; this endpoint asserts it anyway and never carries an ACTIVE anywhere).
//   • ASL        — live Graph read of the account's spend_cap with the store's own token +
//                   appsecret_proof. No ASL → refuse. Computed TRUE total daily spend
//                   (totalDailySpend: ABO = budget × ad-set count) above ASL headroom → refuse.
//   • gate       — META_LAUNCH_ALLOW_LIVE_WRITES !== '1' → 403. The button is wired, the flag fires.
//
// On success: INSERT a launch_jobs row with overrides.build = { status:'requested_grouped', plan }.
// 'requested_grouped' is deliberately NOT 'requested' — today's launch_build_worker only matches
// 'requested', so grouped jobs are invisible to it until the grouped assembler exists. Job status
// is 'done' so launch_intake_worker (pending/running/failed) never fans it out as a doc job.
//
// HARDCODING: none. No store name/slug, BM id, account id or page id appears here — identity is
// data from Supabase + the override registry, per store, at request time.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveOptions, buildPlan, applyEdits, totalDailySpend, planSummary, LaunchOptionError } from '../lib/launch/options.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYXp0bGNvcGt2bGZ6aXdybXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzk1MzEsImV4cCI6MjA5MjYxNTUzMX0.T9fXxkmHOAH6g6IG4-krLXxuj7tqzOn54WDeHsqFh3Y';
// Env is read at REQUEST time (not import time) so a warm lambda picks up env changes and the
// test suite can exercise every gate.
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CLICKUP_TOKEN = () => process.env.CLICKUP_LAUNCH_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v21.0';

// ── auth gate (same pattern as api/clickup-tasks.js) ────────────────────────
async function requireUser(req) {
  const hdr = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!jwt) return { ok: false, code: 401, reason: 'Sign in to publish.' };
  try {
    const r = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!r.ok) return { ok: false, code: 401, reason: 'Session expired or invalid — sign in again.' };
    const u = await r.json();
    if (!u || !u.id) return { ok: false, code: 401, reason: 'Session expired or invalid — sign in again.' };
    return { ok: true, user: u.email || u.id };
  } catch {
    return { ok: false, code: 401, reason: 'Could not verify your session.' };
  }
}

async function svc(path, init) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE(), Authorization: `Bearer ${SERVICE()}`, 'Content-Type': 'application/json',
      ...(init && init.headers) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${path.split('?')[0]} -> ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// Server-side re-fetch of the selected tasks — Drive links come from ClickUp, not the client.
async function fetchTasksById(taskIds) {
  const out = new Map();
  await Promise.all(taskIds.map(async (id) => {
    const r = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}`, {
      headers: { Authorization: CLICKUP_TOKEN(), Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`ClickUp ${r.status} on task ${id}`);
    const t = await r.json();
    const cf = (t.custom_fields || []).find((c) => (c.name || '').trim().toLowerCase() === 'drive link');
    out.set(String(id), {
      task_id: t.id, id: t.id, name: t.name || '',
      drive_link: cf && cf.value ? String(cf.value) : null,
    });
  }));
  return out;
}

// The store's ALLOWED launch identities: its own config + its explicit override-registry entry.
// This IS the assert-account isolation — anything outside this set is rejected, fail-closed.
function allowedIdentity(cfg, slug) {
  let ov = null;
  try {
    const reg = JSON.parse(readFileSync(new URL('../lib/launch/store_launch_overrides.json', import.meta.url), 'utf8'));
    ov = (reg.stores || {})[slug] || null;
  } catch { /* no registry bundled -> config only */ }
  const accounts = new Set([cfg.ad_account_id, ov && ov.account_id].filter(Boolean));
  const pages = new Set([cfg.page_id, ov && ov.page_id].filter(Boolean));
  return { accounts, pages };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.code).json({ ok: false, reason: auth.reason });
  if (!SERVICE()) return res.status(503).json({ ok: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not set in the Vercel env' });
  if (!CLICKUP_TOKEN()) return res.status(503).json({ ok: false, reason: 'CLICKUP_LAUNCH_TOKEN not set in the Vercel env' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const slug = String(body.store_slug || '').trim();
    const taskIds = Array.isArray(body.task_ids) ? body.task_ids.map(String) : [];
    if (!slug) return res.status(400).json({ ok: false, reason: 'store_slug required' });
    if (!taskIds.length) return res.status(400).json({ ok: false, reason: 'task_ids required (select at least one task)' });

    // Store identity — from Supabase, per store, at request time. No config → fail closed.
    const cfg = (await svc(`store_meta_config?store_slug=eq.${encodeURIComponent(slug)}&select=*`) || [])[0];
    if (!cfg) return res.status(404).json({ ok: false, reason: `no Meta config for store '${slug}' — set it up in Meta Setup first` });

    // Authoritative task data. Every selected task must have a Drive link.
    const fetched = await fetchTasksById(taskIds);
    const missing = taskIds.filter((id) => !(fetched.get(id) || {}).drive_link);
    if (missing.length) {
      return res.status(400).json({ ok: false, reason: 'selected task(s) have no Drive link on ClickUp', task_ids: missing });
    }
    const selected = taskIds.map((id) => fetched.get(id));   // preserves operator selection order

    // Rebuild the plan server-side through the SAME engine the review UI used.
    let plan;
    try {
      const opts = resolveOptions(body.options || {}, cfg);
      plan = buildPlan(selected, opts, cfg, { dateStr: new Date().toISOString().slice(0, 10) });
      if (body.edits) plan = applyEdits(plan, body.edits);
    } catch (e) {
      if (e instanceof LaunchOptionError) return res.status(400).json({ ok: false, reason: e.message });
      throw e;
    }

    // ── ISOLATION (assert-account): final identity must be the store's own. ──
    const allow = allowedIdentity(cfg, slug);
    if (!allow.accounts.has(plan.account_id)) {
      return res.status(403).json({ ok: false, status: 'account_isolation_refused',
        reason: `account '${plan.account_id}' is not ${slug}'s configured launch account — a store can only launch to its own account` });
    }
    if (!allow.pages.has(plan.page_id)) {
      return res.status(403).json({ ok: false, status: 'page_isolation_refused',
        reason: `page '${plan.page_id}' is not ${slug}'s configured page` });
    }

    // ── PAUSED invariant (structural; the engine emits nothing else). ──
    if (plan.status !== 'PAUSED' || plan.do_activate) {
      return res.status(400).json({ ok: false, reason: 'plan must be PAUSED with do_activate=false' });
    }

    // ── ASL gate on the COMPUTED total (ABO = budget × ad-set count). ──
    const total = totalDailySpend(plan);
    if (!(total > 0)) return res.status(400).json({ ok: false, reason: 'daily budget must be > 0' });
    const sec = (await svc(`store_meta_secrets?store_slug=eq.${encodeURIComponent(slug)}&select=system_user_token,app_secret`) || [])[0];
    if (!sec || !sec.system_user_token || !sec.app_secret) {
      return res.status(400).json({ ok: false, reason: `no system-user token stored for '${slug}' — enter it in Meta Setup` });
    }
    const proof = crypto.createHmac('sha256', sec.app_secret).update(sec.system_user_token).digest('hex');
    const aslUrl = new URL(`${GRAPH}/${plan.account_id}`);
    aslUrl.searchParams.set('fields', 'spend_cap,amount_spent,currency');
    aslUrl.searchParams.set('access_token', sec.system_user_token);
    aslUrl.searchParams.set('appsecret_proof', proof);
    const aslR = await fetch(aslUrl); const asl = await aslR.json().catch(() => ({}));
    if (!aslR.ok) {
      return res.status(502).json({ ok: false, status: 'asl_unreadable',
        reason: `could not read the account spending limit: ${((asl.error || {}).message) || `HTTP ${aslR.status}`} — refusing (fail-closed)` });
    }
    const cap = asl.spend_cap; const capSet = cap !== undefined && cap !== null && cap !== '' && cap !== '0';
    if (!capSet) {
      return res.status(403).json({ ok: false, status: 'no_asl',
        reason: 'this account has NO spending limit (ASL) set — refusing to queue any build until one exists' });
    }
    const headroomUsd = (Number(cap) - Number(asl.amount_spent || 0)) / 100;
    if (total > headroomUsd) {
      return res.status(403).json({ ok: false, status: 'over_asl',
        reason: `computed TRUE total daily spend $${total.toFixed(2)} exceeds the ASL headroom $${headroomUsd.toFixed(2)} — lower the budget or raise the ASL` });
    }

    // ── security gate: armed by the button, fired only by the flag. ──
    if (process.env.META_LAUNCH_ALLOW_LIVE_WRITES !== '1') {
      return res.status(403).json({ ok: false, status: 'blocked_by_security_gate',
        reason: 'Launches are disabled. Set META_LAUNCH_ALLOW_LIVE_WRITES=1 in the Vercel env to enable Publish.',
        summary: planSummary(plan) });
    }

    // ── ENQUEUE. Nothing is written to Meta here — the grouped build worker does that, PAUSED. ──
    const row = {
      store_slug: slug, store_name: cfg.store_name || slug, account_id: plan.account_id,
      buyer: auth.user, editor_name: '—',                     // grouped launches have no doc editor
      campaign_config: { type: 'grouped_launch', options: body.options || {}, edits: body.edits || null },
      entry_count: plan.adsets.reduce((s, a) => s + a.ads.length, 0),
      status: 'done',                                          // NEVER 'pending' — intake must not fan this out
      overrides: { build: { status: 'requested_grouped', do_activate: false, plan,
        requested_at: new Date().toISOString(), source: 'grouped_publish_button' } },
    };
    const ins = await svc('launch_jobs', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
    return res.status(202).json({ ok: true, status: 'grouped_build_queued', job_id: ins && ins[0] && ins[0].id,
      summary: planSummary(plan),
      message: 'PAUSED grouped build queued. The launch worker will create the campaign/ad sets/ads paused — nothing activates; you review + activate in Ads Manager.' });
  } catch (err) {
    console.error('[api/launch-group-submit] error:', err);
    return res.status(500).json({ ok: false, reason: String((err && err.message) || err) });
  }
}
