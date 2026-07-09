// parser-parity.test.js — proves the JS port produces the SAME plan the proven Python reference
// produces, over the real .docx fixtures. Fixtures are dumped from the Python side
// (extract_docx + parse_launch_doc) so any divergence in parse/validate/budget logic fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLaunchDoc } from '../../lib/launch/parser.js';

const dir = new URL('./fixtures/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

// Compare only the keys the Python plan carries (JS adds asl_gate/launch_permission on top).
const SHARED = ['store', 'account_id', 'campaign', 'ad_sets', 'active_ad_sets',
  'week1_active', 'blockers', 'warnings', 'ok'];

for (const name of ['bms_golden', 'bms_budget20', 'bms_bad_budget', 'bms_bad_store']) {
  test(`parity: ${name}`, () => {
    const extracted = load(`${name}.extracted.json`);
    const py = load(`${name}.plan.json`);
    const js = parseLaunchDoc(extracted);   // uses bundled registry.json (projection of same source)

    for (const k of SHARED) {
      assert.deepEqual(js[k], py[k], `field '${k}' diverged from Python for ${name}`);
    }
    // budget: deep-equal (floats normalize through JSON)
    assert.deepEqual(js.budget, py.budget, `budget diverged for ${name}`);
    // flags: same count, severities, ad_numbers, activation-blocking
    assert.equal(js.flags.length, py.flags.length, `flag count diverged for ${name}`);
    for (let i = 0; i < js.flags.length; i++) {
      for (const fk of ['severity', 'ad_number', 'video', 'in_week1', 'blocks_activation']) {
        assert.deepEqual(js.flags[i][fk], py.flags[i][fk], `flag[${i}].${fk} diverged for ${name}`);
      }
    }
    // ads: same id -> ad_set / launch_week / tokens
    assert.equal(js.ads.length, py.ads.length, `ad count diverged for ${name}`);
    const byId = (arr) => Object.fromEntries(arr.map((a) => [a.ad_number, a]));
    const jb = byId(js.ads); const pb = byId(py.ads);
    for (const id of Object.keys(pb)) {
      assert.equal(jb[id].ad_set, pb[id].ad_set, `ad ${id} ad_set diverged (${name})`);
      assert.deepEqual(jb[id].launch_week, pb[id].launch_week, `ad ${id} launch_week diverged (${name})`);
      assert.deepEqual(jb[id].tokens, pb[id].tokens, `ad ${id} tokens diverged (${name})`);
    }
  });
}

// The tokenless ASL gate must ALWAYS fail-closed (no live read -> unknown -> launch not allowed),
// even on a structurally clean plan.
test('ASL gate is fail-closed tokenless (unknown -> launch blocked)', () => {
  const extracted = load('bms_golden.extracted.json');
  const js = parseLaunchDoc(extracted);            // aslFields defaults to null
  assert.equal(js.asl_gate.state, 'unknown');
  assert.equal(js.launch_permission.asl_ok, false);
  assert.equal(js.launch_permission.allowed, false);
});
