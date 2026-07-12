// Vercel Serverless Function — POST /api/launch-submit
// The launch endpoint. In the tokenless phase it is PHYSICALLY UNABLE to launch, guarded by two
// independent gates that BOTH must open, neither of which is wired yet:
//
//   Gate A (env flag):   META_LAUNCH_ALLOW_LIVE_WRITES !== '1'  -> hard refuse (security runbook not cleared)
//   Gate B (live wiring): even with the flag, there is NO Meta token and NO live ASL read wired here,
//                         so submitLaunch cannot run. Wiring that is the SEPARATE, deliberate step
//                         you do AFTER clearing the 15-step runbook + generating the hardened token.
//
// It still re-parses the doc SERVER-SIDE (never trusts a client plan) and reports the launch_permission
// so the UI can show exactly why launch is disabled. No token is read, imported, or referenced here.
import { parseLaunchDoc } from '../lib/launch/parser.js';
import { buildEffectivePlan, effectiveIdentity } from '../lib/launch/overrides.js';
import { load as loadRegistry } from '../lib/launch/registry.js';

// Optional read-only Supabase access for the {job_id} launch path (holds ∪ overrides). The GATE
// below is unaffected by these — they only choose WHICH plan is validated.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
async function svcGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function svcPatch(table, id, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`supabase patch ${table} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Two authoritative ways to derive the plan — a client-supplied plan is NEVER trusted in either:
    //  • {job_id}          → rebuild from launch_holds ∪ overrides (the EDITED values are what would
    //                        launch), re-validated server-side (budget + ASL + registry containment).
    //  • {paragraphs,tables} → re-parse the doc (original tokenless path).
    let plan, source, jobRow = null;
    if (body.job_id) {
      if (!SERVICE) return res.status(503).json({ status: 'edit_path_not_provisioned',
        reason: 'The {job_id} launch path needs SUPABASE_SERVICE_ROLE_KEY in the Vercel env.' });
      const job = (await svcGet(`launch_jobs?id=eq.${encodeURIComponent(body.job_id)}&select=*`) || [])[0];
      if (!job) return res.status(404).json({ error: 'job not found' });
      const holds = await svcGet(`launch_holds?job_id=eq.${encodeURIComponent(body.job_id)}&select=*&order=entry_index`) || [];
      plan = buildEffectivePlan(job, holds, loadRegistry(), null);   // resolves the override account + identity
      jobRow = job;
      source = 'holds+overrides';
    } else {
      const { paragraphs, tables } = body;
      if (!Array.isArray(paragraphs) || !Array.isArray(tables)) {
        return res.status(400).json({ error: 'body must be { paragraphs, tables } or { job_id }' });
      }
      // Re-derive the plan server-side (authoritative; a client-supplied plan is never trusted).
      plan = parseLaunchDoc({ paragraphs, tables });   // aslFields=null -> fail-closed
      source = 'doc';
    }

    // Structural readiness. A PAUSED build spends $0, so we require account+budget validity (not a
    // live ASL read): the $20 account ASL is Meta-enforced at the MANUAL activation you do later.
    if (plan.blockers && plan.blockers.length) {
      return res.status(400).json({ status: 'not_ready', blockers: plan.blockers,
        account_id: plan.account_id, source });
    }
    // The Schedule button respects the safety flag. Off => the click is refused.
    if (process.env.META_LAUNCH_ALLOW_LIVE_WRITES !== '1') {
      return res.status(403).json({ status: 'blocked_by_security_gate',
        reason: 'Launches are disabled. Set META_LAUNCH_ALLOW_LIVE_WRITES=1 in the Vercel env to enable the Schedule button.',
        account_id: plan.account_id, source });
    }
    if (source !== 'holds+overrides' || !jobRow) {
      return res.status(400).json({ status: 'no_job',
        reason: 'Schedule must be clicked on a committed job (job_id) — nothing to attach the build to.', source });
    }

    // ENQUEUE a PAUSED build. NOTHING is written to Meta here (video upload + Meta writes run in the
    // launch_build_worker, which cannot fit in a serverless function). do_activate is false — the
    // worker only ever builds PAUSED; you activate manually in Ads Manager.
    const identity = effectiveIdentity(jobRow);
    const build = { status: 'requested', do_activate: false, account: plan.account_id, identity,
      requested_at: new Date().toISOString(), source: 'schedule_button' };
    await svcPatch('launch_jobs', jobRow.id, { overrides: { ...(jobRow.overrides || {}), build } });
    return res.status(202).json({ status: 'build_queued', account_id: plan.account_id, identity,
      message: 'PAUSED build requested on the account above. The launch worker will create the '
        + 'campaign/ad set/ad — refresh to see the IDs. Nothing is activated; you review + activate in Ads Manager.' });
  } catch (err) {
    console.error('[api/launch-submit] error:', err);
    return res.status(500).json({ error: 'submit failed', detail: String((err && err.message) || err) });
  }
}
