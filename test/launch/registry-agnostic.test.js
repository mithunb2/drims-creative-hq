// registry-agnostic.test.js — two guards:
//  1. PARITY: lib/launch/registry.json is exactly what the generator produces from the source, so
//     it can't silently drift from the Python side's single source of truth.
//  2. STORE-AGNOSTIC: no store slug / display name / alias appears hardcoded in the launch CODE
//     (lib/launch/*.js + api/launch/*.js) — same grep-guard discipline as test_agnostic.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildRegistry } from '../../scripts/gen-registry.mjs';
import { allStoreTerms } from '../../lib/launch/registry.js';

const root = new URL('../../', import.meta.url);

function stable(obj) {
  return JSON.stringify(obj, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v), 2);
}

test('registry.json is a current projection of the source (no drift)', () => {
  const onDisk = readFileSync(new URL('lib/launch/registry.json', root), 'utf8').trim();
  const fresh = stable(buildRegistry()).trim();
  assert.equal(onDisk, fresh,
    'registry.json is stale/hand-edited — run: node scripts/gen-registry.mjs');
});

test('launch CODE is store-agnostic (no hardcoded store names)', () => {
  const terms = [...allStoreTerms()].filter((t) => t && t.length >= 4); // skip trivially-short terms
  const files = [];
  for (const [dir, ext] of [['lib/launch', '.js'], ['api/launch', '.js']]) {
    let entries = [];
    try { entries = readdirSync(new URL(`${dir}/`, root)); } catch { /* dir may not exist yet */ }
    for (const f of entries) if (f.endsWith(ext)) files.push(`${dir}/${f}`);
  }
  assert.ok(files.length > 0, 'expected some launch source files to scan');
  const offenders = [];
  for (const rel of files) {
    const src = readFileSync(new URL(rel, root), 'utf8');
    for (const term of terms) {
      if (src.includes(term)) offenders.push(`${rel} contains store term ${JSON.stringify(term)}`);
    }
  }
  assert.deepEqual(offenders, [], `store names must live in DATA, not code:\n${offenders.join('\n')}`);
});
