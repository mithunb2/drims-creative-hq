/**
 * lib/launch/secrets.js — ONE server-side resolver for a store's launch credentials.
 *
 * Every endpoint that needs a store's token+app_secret (test, name refresh, preview, group-submit)
 * MUST go through resolveStoreSecret so the launch path and the "ready" badge can never disagree.
 *
 * Two fallbacks live here and NOWHERE else:
 *   • app_secret — OPTIONAL per-store override. When the store's secret row has no app_secret, fall
 *     back to the global META_APP_SECRET env var. There is ONE Meta app (1327252202888713), so the
 *     global secret is correct for every store's token; the per-store column exists only as an escape
 *     hatch. Nothing here ever returns the secret to the browser.
 *   • system_user_token — a system-user token is scoped to ONE Business Manager. A store with no own
 *     token that has OPTED IN (inherit_bm_token) inherits the token of a sibling store in the SAME
 *     BM. The token is resolved at read time (never copied into the row), and inheritance is
 *     BM-bounded — cross-BM never inherits. Account isolation is unaffected: which account a launch
 *     touches is still fixed by the store's own ad_account_id config, not by whose token is used.
 *
 * RLS: reads here use the service role (RLS deny-read on store_meta_secrets is for the browser);
 * the resolved token/secret stay server-side and are never placed in any HTTP response.
 */

const GLOBAL_APP_SECRET = () => process.env.META_APP_SECRET || '';

async function sbGet(url, key, table, q) {
  const r = await fetch(`${url}/rest/v1/${table}?${q}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

/**
 * Find a store in the same Business Manager (excluding `excludeSlug`) that has its OWN token — the
 * donor whose token an inheriting store reuses. Only stores with a real own token qualify (a store
 * that itself inherits has a null token → never a donor → no inheritance chains). Freshest own
 * token wins (order by updated_at desc) so a rotation on the owner is what everyone picks up.
 * Returns { store_slug, system_user_token, app_secret } or null.
 */
export async function findBmTokenDonor(url, key, bm, excludeSlug) {
  if (!bm) return null;
  const sibs = (await sbGet(url, key, 'store_meta_config',
    `business_manager_id=eq.${encodeURIComponent(bm)}` +
    `&store_slug=neq.${encodeURIComponent(excludeSlug || '')}&select=store_slug`)) || [];
  if (!sibs.length) return null;
  const list = sibs.map((s) => String(s.store_slug)).filter((s) => /^[A-Za-z0-9_.-]+$/.test(s));
  if (!list.length) return null;
  const donors = (await sbGet(url, key, 'store_meta_secrets',
    `store_slug=in.(${list.join(',')})&system_user_token=not.is.null` +
    `&select=store_slug,system_user_token,app_secret,updated_at&order=updated_at.desc`)) || [];
  return donors[0] || null;
}

/**
 * Resolve a store's effective launch credentials + a non-secret description of how they resolved.
 *
 * Returns:
 *   token          the effective token (own or inherited) or null   — SERVER-SIDE ONLY
 *   secret         the effective app secret (own override or global) or null — SERVER-SIDE ONLY
 *   token_source   'own' | 'inherited' | 'none'
 *   secret_source  'own' | 'default' | 'none'
 *   inherited_from donor store_slug when token_source==='inherited', else null
 *   bm_donor_slug  a donor slug that exists for this store's BM (null if none) — drives the reuse
 *                  checkbox; present even when this store has its own token
 *   inherit_opted_in  the store's inherit_bm_token flag
 *
 * NEVER return `token`/`secret` to a client. Use tokenState() for anything browser-facing.
 */
export async function resolveStoreSecret(url, key, slug) {
  const own = ((await sbGet(url, key, 'store_meta_secrets',
    `store_slug=eq.${encodeURIComponent(slug)}` +
    `&select=system_user_token,app_secret,inherit_bm_token`)) || [])[0] || {};

  const secret = own.app_secret || GLOBAL_APP_SECRET() || null;
  const secret_source = own.app_secret ? 'own' : (GLOBAL_APP_SECRET() ? 'default' : 'none');
  const inherit_opted_in = !!own.inherit_bm_token;

  const cfg = ((await sbGet(url, key, 'store_meta_config',
    `store_slug=eq.${encodeURIComponent(slug)}&select=business_manager_id`)) || [])[0] || {};
  const bm = cfg.business_manager_id || null;

  if (own.system_user_token) {
    // Has its own token — still report whether the BM has a donor (unused by the badge, cheap).
    return { token: own.system_user_token, secret, token_source: 'own', secret_source,
      inherited_from: null, bm_donor_slug: null, inherit_opted_in };
  }

  const donor = bm ? await findBmTokenDonor(url, key, bm, slug) : null;
  if (inherit_opted_in && donor) {
    return { token: donor.system_user_token, secret, token_source: 'inherited', secret_source,
      inherited_from: donor.store_slug, bm_donor_slug: donor.store_slug, inherit_opted_in };
  }
  return { token: null, secret, token_source: 'none', secret_source,
    inherited_from: null, bm_donor_slug: donor ? donor.store_slug : null, inherit_opted_in };
}

/** Browser-safe projection: everything from resolveStoreSecret EXCEPT token and secret. */
export async function tokenState(url, key, slug) {
  const r = await resolveStoreSecret(url, key, slug);
  return {
    source: r.token_source,               // 'own' | 'inherited' | 'none'
    secret_source: r.secret_source,       // 'own' | 'default' | 'none'
    inherited_from: r.inherited_from,     // donor slug when inherited
    bm_token_available: !!r.bm_donor_slug, // a donor exists for this BM → offer the checkbox
    bm_donor_slug: r.bm_donor_slug,
    inherit_opted_in: r.inherit_opted_in,
  };
}
