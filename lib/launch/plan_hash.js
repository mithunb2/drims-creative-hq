/**
 * lib/launch/plan_hash.js — canonical hash of the launch INPUTS + a signed "preview was rendered"
 * token. Server-side only (Node crypto). Used by item-4's live guard:
 *   /api/launch-preview  signs a token bound to (user, inputs-hash) when a preview renders.
 *   /api/launch-group-submit (live mode) re-derives the hash from the SAME inputs and verifies the
 *   token — so a LIVE launch is refused unless a preview of THAT EXACT plan was just rendered.
 * Change anything (budget, a copy edit, the task set) → the hash changes → the token is invalid →
 * you must re-preview. The token also expires. HMAC key is the service role key (server-only secret).
 */
import crypto from 'node:crypto';

const TTL_MS = 15 * 60 * 1000;   // a rendered preview authorizes a live launch for 15 minutes

/** Deterministic canonical string of the launch inputs (stable key order; task order ignored). */
export function planInputsHash({ store_slug, task_ids, options, edits }) {
  const canon = JSON.stringify({
    s: String(store_slug || ''),
    t: [...(task_ids || [])].map(String).sort(),
    o: sortKeys(options || {}),
    e: sortKeys(edits || null),
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

/** Sign a preview token for (user, inputsHash), valid TTL_MS. HMAC over user:hash:expiry. */
export function signPreviewToken(user, inputsHash, key, nowMs) {
  const exp = nowMs + TTL_MS;
  const payload = `${user}:${inputsHash}:${exp}`;
  const mac = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return Buffer.from(`${payload}:${mac}`).toString('base64url');
}

/** Verify a token matches (user, inputsHash), is unexpired, and is authentically signed.
 *  Returns {ok:true} or {ok:false, reason}. Never throws. */
export function verifyPreviewToken(token, user, inputsHash, key, nowMs) {
  try {
    const decoded = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return { ok: false, reason: 'malformed preview token' };
    const [u, h, expStr, mac] = parts;
    const exp = Number(expStr);
    const expect = crypto.createHmac('sha256', key).update(`${u}:${h}:${exp}`).digest('hex');
    if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect)))
      return { ok: false, reason: 'preview token signature invalid' };
    if (u !== String(user)) return { ok: false, reason: 'preview token was issued for a different user' };
    if (h !== inputsHash) return { ok: false, reason: 'the plan changed since it was previewed — re-render the preview' };
    if (!(exp > nowMs)) return { ok: false, reason: 'preview expired — re-render the preview' };
    return { ok: true };
  } catch { return { ok: false, reason: 'unreadable preview token' }; }
}
