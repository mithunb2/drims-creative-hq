#!/usr/bin/env node
// gen-registry.mjs — derive lib/launch/registry.json from the SAME source the Python side reads
// (~/drims-workers/clickup_structure.json → stores[slug].meta). This makes the Vercel registry a
// PROJECTION of the single source of truth, never a hand-maintained divergent copy. Re-run whenever
// the underlying registry changes; the parity test (test/launch/registry-parity.test.js) fails if
// registry.json drifts from what this generator would produce.
//
// Store-agnostic BY CONSTRUCTION: this reads EVERY store from the data — zero store names appear here.
// Emits only non-secret routing data (business_id + act_ ad-account ids). NO tokens, ever.
//
// Usage: node scripts/gen-registry.mjs [--check]
//   (no flag) writes lib/launch/registry.json
//   --check   prints the JSON to stdout without writing (used by the parity test)

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.env.META_LAUNCH_REGISTRY_SRC
  || join(homedir(), 'drims-workers', 'clickup_structure.json');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'launch', 'registry.json');

/** Build the registry projection: slug -> {slug, store_name, aliases, business_id, business_name, accounts}.
 *  Mirrors registry.py load() exactly so both sides resolve identically. */
export function buildRegistry(structurePath = SRC) {
  const raw = JSON.parse(readFileSync(structurePath, 'utf8'));
  const stores = {};
  for (const [slug, cfg] of Object.entries(raw.stores || {})) {
    const m = cfg.meta || {};
    // Match registry.py's `m.get('ad_account_ids') or [ids from ad_accounts]`: an EMPTY
    // ad_account_ids ([]) is falsy in Python and falls through to ad_accounts — but [] is
    // truthy in JS, so test length explicitly (the little_berry case).
    const accounts = (Array.isArray(m.ad_account_ids) && m.ad_account_ids.length)
      ? m.ad_account_ids
      : (m.ad_accounts || []).map((a) => a.id).filter(Boolean);
    stores[slug] = {
      slug,
      store_name: cfg.store_name || slug,
      aliases: Array.isArray(cfg.aliases) ? cfg.aliases : [],
      business_id: m.business_id ?? null,
      business_name: m.business_name ?? null,
      accounts: Array.isArray(accounts) ? accounts.filter(Boolean) : [],
    };
  }
  return {
    _generated_from: 'clickup_structure.json stores[].meta (via scripts/gen-registry.mjs)',
    _note: 'PROJECTION of the single source of truth. Do not hand-edit — run gen-registry.mjs. No tokens.',
    stores,
  };
}

// Stable-key stringify so the parity test is order-independent.
function stable(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]]));
    }
    return v;
  }, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reg = buildRegistry();
  const json = stable(reg);
  if (process.argv.includes('--check')) {
    process.stdout.write(json + '\n');
  } else {
    writeFileSync(OUT, json + '\n');
    const n = Object.keys(reg.stores).length;
    const mapped = Object.values(reg.stores).filter((s) => s.accounts.length).length;
    console.log(`wrote ${OUT}\n  ${n} stores, ${mapped} with an ad account mapped`);
  }
}
