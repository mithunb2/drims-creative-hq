// Vercel Serverless Function — POST /api/launch-split
// Tokenless w.r.t. META (no Meta contact). Parses a dual-half doc into the SPLIT model and resolves
// the doc-named editor to a ClickUp assignee using the buyer's ClickUp token (forwarded in the
// Authorization header, same token the app already uses for /api/clickup). If the editor can't be
// resolved unambiguously, it becomes a BLOCKER — never a guess. The browser reviews the returned
// model, then commits launch_jobs/launch_holds to Supabase itself (authenticated session).
import { parseSplitDoc } from '../lib/launch/parser.js';
import { membersFromTeamResponse, matchEditor } from '../lib/launch/editor.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { paragraphs, tables, filename } = body;
    if (!Array.isArray(paragraphs) || !Array.isArray(tables)) {
      return res.status(400).json({ error: 'body must be { paragraphs, tables } (extract the .docx client-side)' });
    }

    const split = parseSplitDoc({ paragraphs, tables });
    split.source_filename = filename || null;

    // Resolve the doc-named editor → ClickUp assignee. SERVER-SIDE ONLY: the resolver token lives in
    // a Vercel env var (CLICKUP_LAUNCH_TOKEN), never in the browser, never returned, never logged.
    // If it isn't set, resolution is DEFERRED to the intake worker (which re-resolves authoritatively
    // on the Mac Mini with the existing key) — not a silent misassign, just checked one step later.
    let editor = { name: split.editor_name, resolved: false, deferred: false, assignee_id: null, reason: 'not attempted' };
    const token = process.env.CLICKUP_LAUNCH_TOKEN;   // server-side only
    if (split.editor_name) {
      if (!token) {
        editor.deferred = true;
        editor.reason = 'deferred — resolved + verified at intake (no server resolver token set)';
        // NOT a preview blocker: the intake worker resolves and fails loudly if the editor is bad.
      } else {
        try {
          const r = await fetch('https://api.clickup.com/api/v2/team', {
            headers: { Authorization: token, Accept: 'application/json' },
          });
          if (!r.ok) throw new Error(`ClickUp /team HTTP ${r.status}`);
          const members = membersFromTeamResponse(await r.json());
          const m = matchEditor(split.editor_name, members);
          editor = { name: split.editor_name, resolved: m.resolved, deferred: false, assignee_id: m.assignee_id,
            matched_username: m.matched ? m.matched.username : null, candidates: m.candidates, reason: m.reason };
          if (!m.resolved) split.blockers.push(`Editor not assignable: ${m.reason}`);
        } catch (e) {
          // Do NOT include the token in any message. On a resolver failure, defer to intake.
          editor.deferred = true;
          editor.reason = `preview resolution unavailable (${String((e && e.message) || e)}) — verified at intake`;
        }
      }
    }
    // editor_name absent is already a blocker from parseSplitDoc.
    split.editor = editor;
    split.editor_assignee_id = editor.assignee_id;
    split.ok = split.blockers.length === 0;

    return res.status(200).json({ ok: true, tokenless: true, split });
  } catch (err) {
    console.error('[api/launch-split] error:', err);
    return res.status(500).json({ error: 'split failed', detail: String((err && err.message) || err) });
  }
}
