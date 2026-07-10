// Vercel Serverless Function — POST /api/launch-drive   { task_ids: [...] } -> { provisioned, drives }
// READ-ONLY. Resolves each ClickUp task's "Drive Link" custom field SERVER-SIDE using the app's own
// ClickUp token (CLICKUP_LAUNCH_TOKEN — the same server token /api/launch-split uses), so the review
// surface can show/play the delivered Google Drive video WITHOUT every buyer needing a personal
// ClickUp token in their browser. No writes, no launch API, no gate. The token is never returned.
const TOKEN = process.env.CLICKUP_LAUNCH_TOKEN || '';

function driveFromTask(task) {
  for (const cf of (task && task.custom_fields) || []) {
    if ((cf.name || '').trim().toLowerCase() === 'drive link') {
      const v = cf.value;
      return typeof v === 'string' ? v.trim() : '';
    }
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // No server token → tell the client so it can fall back (buyer token / task link). Not an error.
  if (!TOKEN) return res.status(200).json({ provisioned: false, drives: {},
    reason: 'CLICKUP_LAUNCH_TOKEN is not set in the Vercel env — Drive links can’t be resolved server-side yet.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ids = Array.isArray(body.task_ids) ? body.task_ids.filter(Boolean).slice(0, 50) : [];
    const drives = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}`,
          { headers: { Authorization: TOKEN, Accept: 'application/json' } });
        if (!r.ok) return;
        const d = driveFromTask(await r.json());
        if (d) drives[id] = d;
      } catch (e) { /* skip this task; others still resolve */ }
    }));
    return res.status(200).json({ provisioned: true, drives });
  } catch (err) {
    console.error('[api/launch-drive] error:', err);
    return res.status(500).json({ error: 'drive resolve failed', detail: String((err && err.message) || err) });
  }
}
