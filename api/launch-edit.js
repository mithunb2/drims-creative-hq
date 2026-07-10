// Vercel Serverless Function — POST /api/launch-edit
// The ONLY validated write path for buyer edits to launch-critical data. Every edit:
//   1. is attributed to a REAL person — the caller's Supabase session JWT is verified server-side
//      (auth.getUser); the client cannot supply its own identity.
//   2. is RE-VALIDATED by the same safety core the doc went through — a budget/account edit re-runs
//      computeBudget + ASL + registry containment (overrides.validateEdit). An edit that would
//      overspend a live ASL, or route spend cross-store, is REJECTED (nothing written).
//   3. writes an OVERRIDE (never overwrites the held doc value) + an append-only audit row, using
//      the service role. RLS blocks the browser from writing these directly, so this endpoint is
//      the sole door. Fail-closed: with no service key provisioned it refuses (503) — never a
//      silent client-side write.
// Launch itself is unaffected: this changes WHAT would launch; /api/launch-submit still gates it.
import { load as loadRegistry } from '../lib/launch/registry.js';
import { validateEdit, effectiveConfig, effectiveAccount, effectiveHold, JOB_FIELDS } from '../lib/launch/overrides.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYXp0bGNvcGt2bGZ6aXdybXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzk1MzEsImV4cCI6MjA5MjYxNTUzMX0.T9fXxkmHOAH6g6IG4-krLXxuj7tqzOn54WDeHsqFh3Y';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function rest(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcHeaders, ...(init.headers || {}) } });
  const t = await r.text();
  return { ok: r.ok, status: r.status, json: t ? JSON.parse(t) : null };
}

/** Verify the caller's Supabase access token → the real actor. null if missing/invalid. */
async function verifyActor(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = auth.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${jwt}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? { id: u.id, email: u.email || null } : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Fail-closed: the validated write path is unavailable until the service key is provisioned.
  if (!SERVICE) return res.status(503).json({ ok: false, error: 'edit path not provisioned',
    reason: 'Set SUPABASE_SERVICE_ROLE_KEY in the Vercel env to enable server-validated edits. Until then the review surface stays read-only.' });

  try {
    const actor = await verifyActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: 'not authenticated', reason: 'A valid Supabase session is required — edits are attributed to a real person.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { job_id, hold_id, field, value, op } = body;
    if (!job_id || !field) return res.status(400).json({ ok: false, error: 'body must include { job_id, field, value } (+ hold_id for per-ad fields)' });

    const jobRes = await rest(`launch_jobs?id=eq.${encodeURIComponent(job_id)}&select=*`);
    const job = jobRes.json && jobRes.json[0];
    if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
    const holdsRes = await rest(`launch_holds?job_id=eq.${encodeURIComponent(job_id)}&select=*&order=entry_index`);
    const holds = holdsRes.json || [];
    const isJobField = JOB_FIELDS.has(field);
    const hold = isJobField ? null : holds.find((h) => h.id === hold_id);
    if (!isJobField && !hold) return res.status(404).json({ ok: false, error: 'hold not found for per-ad edit' });
    const reg = loadRegistry();

    // Old (effective) value for the audit trail, BEFORE the change.
    const oldEff = isJobField
      ? (field === 'account_id' ? effectiveAccount(job) : effectiveConfig(job)[{ budget_amount: 'Budget Amount (USD)', budget_type: 'Budget Type', budget_level: 'Budget Level', spend_cap: 'Launch Spend Cap (USD)', run_length: 'Run Length (days)' }[field]])
      : effectiveHold(hold, job)[{ ad_set: 'ad_set', ad_copy: 'ad_copy', ad_name_short: 'ad_name_short', ad_name_full: 'name_string' }[field]];

    const target = isJobField ? job : hold;
    const table = isJobField ? 'launch_jobs' : 'launch_holds';
    const curOverrides = { ...(target.overrides || {}) };

    // ── REVERT: drop the override key → back to the doc-held value ──
    if (op === 'revert') {
      delete curOverrides[field];
      const w = await rest(`${table}?id=eq.${encodeURIComponent(target.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ overrides: curOverrides }) });
      if (!w.ok) return res.status(502).json({ ok: false, error: 'revert write failed', detail: w.json });
      await rest('launch_edit_log', { method: 'POST', body: JSON.stringify({ job_id, hold_id: isJobField ? null : hold.id, field, old_value: String(oldEff ?? ''), new_value: '(reverted to doc)', safety_critical: JOB_FIELDS.has(field), actor_email: actor.email, actor_user_id: actor.id }) });
      return res.status(200).json({ ok: true, reverted: true, field });
    }

    // ── VALIDATE the edit through the safety core (budget/account re-run ASL + registry) ──
    const v = validateEdit({ field, value, job, hold, holds, reg, aslFields: null });   // Phase 1: tokenless → ASL unknown
    if (!v.ok) return res.status(422).json({ ok: false, error: 'edit rejected by validation', reason: v.reason, safety_critical: v.safety_critical, revalidation: v.revalidation || null });

    // ── WRITE the override (never the held value) + the audit row ──
    curOverrides[field] = v.value;
    const w = await rest(`${table}?id=eq.${encodeURIComponent(target.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ overrides: curOverrides }) });
    if (!w.ok) return res.status(502).json({ ok: false, error: 'override write failed', detail: w.json });

    await rest('launch_edit_log', { method: 'POST', body: JSON.stringify({
      job_id, hold_id: isJobField ? null : hold.id, field,
      old_value: String(oldEff ?? ''), new_value: String(v.value),
      safety_critical: !!v.safety_critical, actor_email: actor.email, actor_user_id: actor.id,
    }) });

    return res.status(200).json({ ok: true, field, value: v.value, safety_critical: !!v.safety_critical, revalidation: v.revalidation || null, actor: actor.email });
  } catch (err) {
    console.error('[api/launch-edit] error:', err);
    return res.status(500).json({ ok: false, error: 'edit failed', detail: String((err && err.message) || err) });
  }
}
