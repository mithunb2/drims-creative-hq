// Vercel Serverless Function — POST /api/launch/submit
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
import { parseLaunchDoc } from '../../lib/launch/parser.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { paragraphs, tables } = body;
    if (!Array.isArray(paragraphs) || !Array.isArray(tables)) {
      return res.status(400).json({ error: 'body must be { paragraphs, tables }' });
    }

    // Re-derive the plan server-side (authoritative; a client-supplied plan is never trusted).
    const plan = parseLaunchDoc({ paragraphs, tables });   // aslFields=null -> fail-closed

    // Gate A — the security flag. Off by default; only YOU set it after the runbook.
    if (process.env.META_LAUNCH_ALLOW_LIVE_WRITES !== '1') {
      return res.status(403).json({
        status: 'blocked_by_security_gate',
        reason: 'Live writes are disabled. Clear the 15-step security runbook, generate the hardened '
          + 'token, remove the Margin Monitor app, then set META_LAUNCH_ALLOW_LIVE_WRITES=1.',
        launch_permission: plan.launch_permission,
      });
    }

    // Gate B — even with the flag on, the live Meta connection is intentionally not wired in this
    // phase. There is no token and no live ASL read here, so a launch cannot proceed. Wiring the
    // MetaReadClient + hardened-token MetaManagementClient + money-gate is the next, separate step.
    return res.status(501).json({
      status: 'live_wiring_pending',
      reason: 'Security flag is set, but the live Meta connection (hardened token + live ASL read + '
        + 'money-gate) is not wired in this build. That is the deliberate next step, done separately.',
      launch_permission: plan.launch_permission,
    });
  } catch (err) {
    console.error('[api/launch/submit] error:', err);
    return res.status(500).json({ error: 'submit failed', detail: String((err && err.message) || err) });
  }
}
