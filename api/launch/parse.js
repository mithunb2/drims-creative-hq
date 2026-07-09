// Vercel Serverless Function — POST /api/launch/parse
// Tokenless, read-only, ZERO Meta contact. Receives the browser-extracted { paragraphs, tables }
// (the .docx is unzipped client-side via CDN JSZip) and runs the FULL parse/validate/budget/routing
// logic server-authoritative. Returns the launch plan the UI renders as the preview.
//
// The ASL headroom is NOT read here (that needs a live Meta connection, which is gated). The plan's
// asl_gate is therefore 'unknown' -> launch_permission.allowed = false (fail-closed). No secrets.
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
      return res.status(400).json({ error: 'body must be { paragraphs: string[], tables: string[][][] } '
        + '(extract the .docx client-side before posting)' });
    }
    // aslFields intentionally omitted -> null -> fail-closed 'unknown' gate. NO live Meta read here.
    const plan = parseLaunchDoc({ paragraphs, tables });
    return res.status(200).json({
      ok: true,
      tokenless: true,
      note: 'Preview only. No Meta connection. Launch stays disabled until the security gate is cleared, '
        + 'META_LAUNCH_ALLOW_LIVE_WRITES is set, and a live ASL read confirms headroom.',
      plan,
    });
  } catch (err) {
    console.error('[api/launch/parse] error:', err);
    return res.status(500).json({ error: 'parse failed', detail: String((err && err.message) || err) });
  }
}
