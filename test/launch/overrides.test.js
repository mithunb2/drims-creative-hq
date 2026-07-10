// overrides.test.js — proves the buyer-edit SAFETY logic: effective layers, short-name generation,
// registry reverse-lookup + same-store account containment, budget/ASL re-validation on every
// money edit, verbatim ad-copy, short-name uniqueness, and the effective-plan gate verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveConfig, effectiveAccount, effectiveHold, storeAbbr, genShortName,
  recordForAccount, allowedAccounts, revalidateBudget, validateEdit, buildEffectivePlan,
} from '../../lib/launch/overrides.js';

const REG = {
  store_a: { slug: 'store_a', store_name: 'Alpha Store', aliases: [], accounts: ['act_100'] },
  store_b: { slug: 'store_b', store_name: 'Beta Store', aliases: [], accounts: ['act_200'] },
};
const baseJob = () => ({
  store_slug: 'store_a', store_name: 'Alpha Store', account_id: 'act_100',
  campaign_config: { Store: 'Alpha Store', 'Budget Level': 'ad_set', 'Budget Type': 'daily',
    'Budget Amount (USD)': '10', 'Launch Spend Cap (USD)': '200', 'Run Length (days)': '7' },
  overrides: {},
});
const holds = () => [
  { id: 'h1', ad_number: '026', overrides: {}, launch_half: { ad_copy: 'copy one', name_string: 'X', ad_set: 'AS1', tokens: { h: 'hook-1' }, video_file: 'V1.mp4' } },
  { id: 'h2', ad_number: '027', overrides: {}, launch_half: { ad_copy: 'copy two', name_string: 'Y', ad_set: 'AS2', tokens: { h: 'hook-2' }, video_file: 'V2.mp4' } },
];
// Live Meta ASL fields (minor units/cents). headroom = ASL - spent.
const ASL_ROOM = { spend_cap: '30000', amount_spent: '0', account_status: 1 };   // $300 headroom
const ASL_TIGHT = { spend_cap: '10000', amount_spent: '0', account_status: 1 };  // $100 headroom

test('effective = override ?? held (originals preserved, revert = drop the key)', () => {
  const job = baseJob(); job.overrides = { budget_amount: '25', account_id: 'act_100' };
  assert.equal(effectiveConfig(job)['Budget Amount (USD)'], '25');
  assert.equal(effectiveConfig(job)['Launch Spend Cap (USD)'], '200'); // untouched held value
  assert.equal(job.campaign_config['Budget Amount (USD)'], '10');      // original NOT mutated
  const h = holds()[0]; h.overrides = { ad_copy: 'EDITED verbatim!!', ad_set: 'AS9' };
  const eh = effectiveHold(h, baseJob());
  assert.equal(eh.ad_copy, 'EDITED verbatim!!');
  assert.equal(eh.ad_set, 'AS9');
  assert.equal(h.launch_half.ad_copy, 'copy one');                     // held untouched
});

test('short name = ABBR · hook · ad_set, from store-name initials', () => {
  assert.equal(storeAbbr('Alpha Store'), 'AS');
  assert.equal(storeAbbr('Cake Craft Academy'), 'CCA');
  assert.equal(storeAbbr('The Bible Made Simple'), 'BMS');            // stopword 'The' dropped
  assert.equal(genShortName(holds()[1], baseJob()), 'AS · hook-2 · AS2');
});

test('registry reverse-lookup + SAME-STORE account containment', () => {
  assert.equal(recordForAccount('act_200', REG).slug, 'store_b');
  assert.equal(recordForAccount('act_999', REG), null);
  assert.deepEqual(allowedAccounts(baseJob(), REG), ['act_100']);     // only THIS store's accounts
});

test('budget re-validation: recompute + cap<run warning; tokenless ASL is unknown (fail-closed)', () => {
  const rb = revalidateBudget(baseJob(), holds(), null);
  assert.equal(rb.ok, true);
  assert.equal(rb.budget.daily_total, 20);            // $10 x 2 ad-sets
  assert.equal(rb.asl.state, 'unknown');              // no live read -> unknown
  const big = baseJob(); big.overrides = { budget_amount: '80' };     // 80x2x7 = 1120 > cap 200
  const rb2 = revalidateBudget(big, holds(), null);
  assert.ok(rb2.warnings.some((w) => /cap may throttle/i.test(w)));
});

test('SAFETY: a budget/cap edit that overspends a LIVE ASL is REJECTED', () => {
  // spend_cap 200 vs $100 headroom -> evaluateAsl BLOCK -> reject
  const r = validateEdit({ field: 'spend_cap', value: '200', job: baseJob(), holds: holds(), reg: REG, aslFields: ASL_TIGHT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ASL/);
  // Same edit with room -> allowed
  const r2 = validateEdit({ field: 'spend_cap', value: '200', job: baseJob(), holds: holds(), reg: REG, aslFields: ASL_ROOM });
  assert.equal(r2.ok, true);
  // Tokenless (Phase 1) -> not rejected (recorded; launch still gated elsewhere)
  const r3 = validateEdit({ field: 'spend_cap', value: '200', job: baseJob(), holds: holds(), reg: REG, aslFields: null });
  assert.equal(r3.ok, true);
  assert.equal(r3.revalidation.asl.state, 'unknown');
});

test('SAFETY: budget must be a bare number; "$150"/"~15" rejected', () => {
  assert.equal(validateEdit({ field: 'budget_amount', value: '$150', job: baseJob(), holds: holds(), reg: REG }).ok, false);
  assert.equal(validateEdit({ field: 'budget_amount', value: '150', job: baseJob(), holds: holds(), reg: REG }).ok, true);
});

test('SAFETY: account switch stays in-store; cross-store + unknown are BLOCKED', () => {
  assert.equal(validateEdit({ field: 'account_id', value: 'act_100', job: baseJob(), holds: holds(), reg: REG }).ok, true);
  const cross = validateEdit({ field: 'account_id', value: 'act_200', job: baseJob(), holds: holds(), reg: REG });
  assert.equal(cross.ok, false);
  assert.match(cross.reason, /cross-store|not one of/i);
  const unknown = validateEdit({ field: 'account_id', value: 'act_777', job: baseJob(), holds: holds(), reg: REG });
  assert.equal(unknown.ok, false);
});

test('ad copy stored VERBATIM; ad_set non-empty; short name unique within job', () => {
  const weird = 'Line1\nLine2 — “curly” 100% free!!';
  const c = validateEdit({ field: 'ad_copy', value: weird, job: baseJob(), hold: holds()[0], holds: holds(), reg: REG });
  assert.equal(c.ok, true); assert.equal(c.value, weird);            // byte-for-byte, no regeneration
  assert.equal(validateEdit({ field: 'ad_set', value: '  ', job: baseJob(), hold: holds()[0], holds: holds(), reg: REG }).ok, false);
  // rename h2 to h1's effective short name -> clash
  const clash = validateEdit({ field: 'ad_name_short', value: 'AS · hook-1 · AS1', job: baseJob(), hold: holds()[1], holds: holds(), reg: REG });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /already used/);
});

test('effective launch plan: tokenless gate holds; edited budget flows in; cross-store override blocks', () => {
  const plan = buildEffectivePlan(baseJob(), holds(), REG, null);
  assert.equal(plan.launch_permission.allowed, false);              // asl unknown -> gate holds
  assert.equal(plan.launch_permission.asl_state, 'unknown');
  assert.equal(plan.launch_permission.structurally_ok, true);
  assert.equal(plan.budget.daily_total, 20);
  // an EDITED budget becomes what (would) launch — re-validated, not the doc value
  const edited = baseJob(); edited.overrides = { budget_amount: '50' };
  assert.equal(buildEffectivePlan(edited, holds(), REG, null).budget.daily_total, 100);
  // a tampered cross-store account override is caught at plan-build (fail-closed)
  const tampered = baseJob(); tampered.overrides = { account_id: 'act_200' };
  const tp = buildEffectivePlan(tampered, holds(), REG, null);
  assert.equal(tp.launch_permission.structurally_ok, false);
  assert.ok(tp.blockers.some((b) => /cross-store|outside this store/i.test(b)));
});
