// grouped-submit.test.js — the multi-select grouped launch: engine invariants + endpoint gates.
// The endpoint is exercised with a mocked global fetch (Supabase auth/config + ClickUp + Graph),
// so every fail-closed branch is proven without any network: isolation (forged account/page),
// missing Drive link, no-ASL refusal, over-ASL refusal on the COMPUTED total, PAUSED invariant,
// and the security gate. No store name, account id or page id below is real — all fixture data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptions, buildPlan, applyEdits, totalDailySpend, groupVideos, adsetCount, LaunchOptionError } from '../../lib/launch/options.js';
import handler from '../../api/launch-group-submit.js';

const mkTasks = (n) => Array.from({ length: n }, (_, i) => ({ task_id: `t${i + 1}`, name: `Video ${i + 1}`, drive_link: `https://drive.example/d/f${i + 1}` }));
const CFG = { store_slug: 'fixture_store', store_name: 'Fixture Store', ad_account_id: 'act_000FIXTURE', page_id: '000PAGE', default_landing: 'https://example.com/' };

// ── engine invariants ───────────────────────────────────────────────────────
test('grouping math: 12 @ 4 -> [4,4,4]; 12 @ 5 -> [5,5,2]; count = ceil', () => {
  assert.deepEqual(groupVideos(mkTasks(12), 4).map((g) => g.length), [4, 4, 4]);
  assert.deepEqual(groupVideos(mkTasks(12), 5).map((g) => g.length), [5, 5, 2]);
  assert.equal(adsetCount(12, 5), 3);
  assert.throws(() => groupVideos(mkTasks(3), 0), LaunchOptionError);
});

test('videos_per_adset is NOT locked to 5 — any integer >= 1 builds', () => {
  for (const per of [1, 2, 3, 7, 11]) {
    const plan = buildPlan(mkTasks(11), resolveOptions({ videos_per_adset: per, daily_budget_usd: 10 }, CFG), CFG, { dateStr: '2026-07-23' });
    assert.equal(plan.adsets.length, Math.ceil(11 / per));
  }
});

test('ABO truth: total daily spend = budget × ad-set count, not the entered number', () => {
  const opts = resolveOptions({ budget_mode: 'ABO', daily_budget_usd: 500, videos_per_adset: 4 }, CFG);
  const plan = buildPlan(mkTasks(12), opts, CFG, { dateStr: '2026-07-23' });
  assert.equal(plan.adsets.length, 3);
  assert.equal(totalDailySpend(plan), 1500);            // 3 × $500 — NOT $500
  assert.equal(plan.campaign.daily_budget_usd, null);   // ABO: no campaign-level budget
});

test('CBO: campaign holds the budget, ad sets hold none', () => {
  const plan = buildPlan(mkTasks(6), resolveOptions({ budget_mode: 'CBO', daily_budget_usd: 80, videos_per_adset: 3 }, CFG), CFG, { dateStr: '2026-07-23' });
  assert.equal(totalDailySpend(plan), 80);
  assert.ok(plan.adsets.every((a) => a.daily_budget_usd === null));
});

test('objective: defaulted, editable, garbage rejected', () => {
  const plan = buildPlan(mkTasks(2), resolveOptions({ daily_budget_usd: 5 }, CFG), CFG, { dateStr: '2026-07-23' });
  assert.equal(plan.campaign.objective, 'OUTCOME_SALES');
  const edited = applyEdits(plan, { campaign: { objective: 'OUTCOME_LEADS' } });
  assert.equal(edited.campaign.objective, 'OUTCOME_LEADS');
  assert.throws(() => resolveOptions({ objective: 'CONVERSIONS', daily_budget_usd: 5 }, CFG), LaunchOptionError);
});

test('every plan is PAUSED with do_activate=false — no input can change it', () => {
  const plan = buildPlan(mkTasks(4), resolveOptions({ daily_budget_usd: 5 }, CFG), CFG, { dateStr: '2026-07-23' });
  assert.equal(plan.status, 'PAUSED');
  assert.equal(plan.do_activate, false);
  assert.throws(() => applyEdits(plan, { campaign: { status: 'ACTIVE' } }), LaunchOptionError);   // not an editable field
});

test('store-agnostic: identity comes only from storeCfg, cross-BM page carried unchanged', () => {
  const cfg = { ...CFG, page_id: '000SHARED_CROSS_BM_PAGE' };   // page in a DIFFERENT BM, shared in
  const plan = buildPlan(mkTasks(2), resolveOptions({ daily_budget_usd: 5 }, cfg), cfg, { dateStr: '2026-07-23' });
  assert.equal(plan.page_id, '000SHARED_CROSS_BM_PAGE');        // no ownership assumption anywhere
  assert.equal(plan.account_id, 'act_000FIXTURE');
});

// ── endpoint gates (mocked network) ─────────────────────────────────────────
function mockRes() {
  return { _status: 0, _json: null, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

/** Install a fetch mock. Routes: supabase auth user, store_meta_config, store_meta_secrets,
 *  launch_jobs insert, ClickUp task GET, Graph account read. Overridable per-test. */
function mockFetch(over = {}) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    const j = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o), json: async () => o });
    if (u.includes('/auth/v1/user')) return j(over.user ?? { id: 'u1', email: 'op@example.com' }, over.userStatus ?? 200);
    if (u.includes('store_meta_config')) return j(over.cfg ?? [CFG]);
    if (u.includes('store_meta_secrets')) return j(over.sec ?? [{ system_user_token: 'tok', app_secret: 'sec' }]);
    if (u.includes('launch_jobs')) return j(over.insert ?? [{ id: 'job-1' }], 201);
    if (u.includes('api.clickup.com')) {
      const id = u.match(/task\/([^/?]+)/)[1];
      const t = (over.cuTasks ?? Object.fromEntries(mkTasks(6).map((x) => [x.task_id, x])))[id];
      if (!t) return j({}, 404);
      return j({ id, name: t.name, custom_fields: t.drive_link ? [{ name: 'Drive Link', value: t.drive_link }] : [] });
    }
    if (u.includes('graph.facebook.com')) return j(over.asl ?? { spend_cap: '2000', amount_spent: '0', currency: 'USD' }, over.aslStatus ?? 200);
    throw new Error('unmocked fetch: ' + u.slice(0, 80));
  };
  return () => { global.fetch = orig; };
}

const BODY = { store_slug: 'fixture_store', task_ids: ['t1', 't2', 't3'], options: { daily_budget_usd: 10, videos_per_adset: 2 } };
const REQ = (body) => ({ method: 'POST', headers: { authorization: 'Bearer jwt' }, body });
const withEnv = async (fn) => {
  const prev = { S: process.env.SUPABASE_SERVICE_ROLE_KEY, C: process.env.CLICKUP_LAUNCH_TOKEN, F: process.env.META_LAUNCH_ALLOW_LIVE_WRITES };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.CLICKUP_LAUNCH_TOKEN = 'cu'; delete process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  try { await fn(); } finally {
    for (const [k, v] of [['SUPABASE_SERVICE_ROLE_KEY', prev.S], ['CLICKUP_LAUNCH_TOKEN', prev.C], ['META_LAUNCH_ALLOW_LIVE_WRITES', prev.F]])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

test('endpoint: unauthenticated -> 401, nothing touched', async () => {
  const restore = mockFetch();
  try { await withEnv(async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: BODY }, res);
    assert.equal(res._status, 401);
  }); } finally { restore(); }
});

test('endpoint: FORGED account id -> 403 account_isolation_refused (assert-account)', async () => {
  const restore = mockFetch();
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ({ ...BODY, options: { ...BODY.options, account_id: 'act_ATTACKER' } }), res);
    assert.equal(res._status, 403);
    assert.equal(res._json.status, 'account_isolation_refused');
  }); } finally { restore(); }
});

test('endpoint: forged page id -> 403 page_isolation_refused', async () => {
  const restore = mockFetch();
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ({ ...BODY, options: { ...BODY.options, page_id: '999NOT_OURS' } }), res);
    assert.equal(res._status, 403);
    assert.equal(res._json.status, 'page_isolation_refused');
  }); } finally { restore(); }
});

test('endpoint: task without a Drive link -> 400, names the offender', async () => {
  const tasks = Object.fromEntries(mkTasks(6).map((x) => [x.task_id, x]));
  tasks.t2 = { ...tasks.t2, drive_link: null };
  const restore = mockFetch({ cuTasks: tasks });
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ(BODY), res);
    assert.equal(res._status, 400);
    assert.deepEqual(res._json.task_ids, ['t2']);
  }); } finally { restore(); }
});

test('endpoint: NO ASL on the account -> 403 no_asl (refuse, fail-closed)', async () => {
  const restore = mockFetch({ asl: { spend_cap: null, amount_spent: '0' } });
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ(BODY), res);
    assert.equal(res._status, 403);
    assert.equal(res._json.status, 'no_asl');
  }); } finally { restore(); }
});

test('endpoint: COMPUTED ABO total over ASL headroom -> 403 over_asl', async () => {
  // ASL headroom $20; ABO $15/ad set × 2 ad sets = $30 computed -> refused even though 15 < 20.
  const restore = mockFetch({ asl: { spend_cap: '2000', amount_spent: '0' } });
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ({ ...BODY, task_ids: ['t1', 't2', 't3', 't4'], options: { budget_mode: 'ABO', daily_budget_usd: 15, videos_per_adset: 2 } }), res);
    assert.equal(res._status, 403);
    assert.equal(res._json.status, 'over_asl');
  }); } finally { restore(); }
});

test('endpoint: all checks pass, flag OFF -> 403 blocked_by_security_gate (armed, not fired)', async () => {
  const restore = mockFetch();
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ(BODY), res);
    assert.equal(res._status, 403);
    assert.equal(res._json.status, 'blocked_by_security_gate');
    assert.ok(res._json.summary);                       // operator still sees the validated summary
  }); } finally { restore(); }
});

test('endpoint: flag ON -> 202 grouped_build_queued, PAUSED, requested_grouped (invisible to old worker)', async () => {
  let inserted = null;
  const restore = mockFetch();
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('launch_jobs') && init && init.method === 'POST') inserted = JSON.parse(init.body);
    return origFetch(url, init);
  };
  try { await withEnv(async () => {
    process.env.META_LAUNCH_ALLOW_LIVE_WRITES = '1';
    const res = mockRes();
    await handler(REQ(BODY), res);
    assert.equal(res._status, 202);
    assert.equal(res._json.status, 'grouped_build_queued');
    assert.equal(inserted.status, 'done');                                    // intake worker never fans this out
    assert.equal(inserted.overrides.build.status, 'requested_grouped');       // old build worker never matches it
    assert.equal(inserted.overrides.build.do_activate, false);
    assert.equal(inserted.overrides.build.plan.status, 'PAUSED');
    assert.equal(inserted.account_id, CFG.ad_account_id);                     // isolation held through to the row
  }); } finally { global.fetch = origFetch; restore(); }
});
