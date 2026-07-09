// registry.js — SINGLE source of truth for Store -> Business Manager -> ad account, for the
// Vercel side. 1:1 port of drims-meta-launch/registry.py. Store-agnostic BY CONSTRUCTION: ZERO
// store names/slugs/aliases in this code — every store is DATA read from registry.json (itself a
// projection of clickup_structure.json via scripts/gen-registry.mjs). Onboarding a store is a data
// edit + re-gen, never a code change.
import { readFileSync } from 'node:fs';

/** @typedef {{slug:string, store_name:string, aliases:string[], business_id:string|null,
 *   business_name:string|null, accounts:string[]}} StoreRecord */

let _cache = null;

/** Load slug -> StoreRecord from the bundled projection. @returns {Record<string,StoreRecord>} */
export function load() {
  if (_cache) return _cache;
  const raw = JSON.parse(readFileSync(new URL('./registry.json', import.meta.url), 'utf8'));
  _cache = raw.stores || {};
  return _cache;
}

/** Normalize a name for matching: collapse whitespace/underscores, trim, lowercase. */
export function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/** {normalized name -> slug} built entirely from DATA: slug, store_name, aliases. */
function nameIndex(reg) {
  const idx = {};
  for (const [slug, r] of Object.entries(reg)) {
    idx[norm(slug)] = slug;
    idx[norm(r.store_name)] = slug;
    for (const a of r.aliases || []) idx[norm(a)] = slug;
  }
  return idx;
}

/** Store (slug | display name | alias) -> record, or null. Pure data-driven lookup. */
export function resolve(store, reg = null) {
  const R = reg || load();
  return R[nameIndex(R)[norm(store)]] || null;
}

/** Resolve the ONE ad account a store's launches target. Same lookup for every store;
 *  fail-closed with an explicit reason. */
export function accountFor(store, reg = null) {
  const r = resolve(store, reg);
  // Single-quote wrap to match the Python reference's repr() in these operator-facing messages.
  if (!r) return { ok: false, reason: `Store '${store}' is not in the registry`, record: null, account_id: null };
  if (!r.accounts || !r.accounts.length) {
    return { ok: false, reason: `Store '${r.slug}' has no ad account mapped (run setup_meta_map for its BM)`, record: r, account_id: null };
  }
  return { ok: true, reason: 'resolved', record: r, account_id: r.accounts[0] };
}

/** Every store slug / display name / alias — used by the store-agnostic guard test. */
export function allStoreTerms(reg = null) {
  const R = reg || load();
  const terms = new Set();
  for (const [slug, r] of Object.entries(R)) {
    terms.add(slug); terms.add(r.store_name);
    for (const a of r.aliases || []) terms.add(a);
  }
  return new Set([...terms].filter(Boolean));
}
