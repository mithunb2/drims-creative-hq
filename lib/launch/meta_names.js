/**
 * lib/launch/meta_names.js — resolve human-readable names for a store's Meta identity
 * (Business Manager / ad account / page) via Graph, and cache them on store_meta_config.
 *
 * FAIL-SOFT BY DESIGN: each name is read independently; a failed read yields null for THAT
 * name only (the UI then shows the raw id alone — never a blanked field), and a cache write
 * against a DB that doesn't have the name columns yet is swallowed (additive migration
 * 20260723_store_meta_names.sql adds them; the feature works without the cache, just slower).
 *
 * Store-agnostic: ids and token arrive as arguments; nothing per-store lives here.
 */
import crypto from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function nameOf(id, token, proof) {
  if (!id) return null;
  try {
    const u = new URL(`${GRAPH}/${id}`);
    u.searchParams.set('fields', 'name');
    u.searchParams.set('access_token', token);
    u.searchParams.set('appsecret_proof', proof);
    const r = await fetch(u);
    if (!r.ok) return null;                       // unreadable -> id shown alone, not an error
    const j = await r.json().catch(() => ({}));
    return j.name || null;
  } catch { return null; }
}

/** Live-resolve the three names with the store's own token. Independent, never throws. */
export async function resolveMetaNames(cfg, token, appSecret) {
  const proof = crypto.createHmac('sha256', appSecret).update(token).digest('hex');
  const [bm_name, account_name, page_name] = await Promise.all([
    nameOf(cfg.business_manager_id, token, proof),
    nameOf(cfg.ad_account_id, token, proof),
    nameOf(cfg.page_id, token, proof),
  ]);
  return { bm_name, account_name, page_name };
}

/** Best-effort cache write. Only writes names that resolved (never nulls over a good cache).
 *  Missing columns (migration not applied yet) or any other failure is swallowed. */
export async function cacheMetaNames(supabaseUrl, serviceKey, slug, names) {
  const patch = {};
  for (const k of ['bm_name', 'account_name', 'page_name']) if (names[k]) patch[k] = names[k];
  if (!Object.keys(patch).length) return false;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/store_meta_config?store_slug=eq.${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    return r.ok;
  } catch { return false; }
}

/** Display helper contract (UI mirrors this): name -> "Name (id)"; no name -> the id alone. */
export const displayIdName = (id, name) => (id ? (name ? `${name} (${id})` : String(id)) : '—');
