// writer.test.js — proves the write-path safety spine with a FAKE transport (zero network):
// build-all-PAUSED -> verify -> activate-only-week-1; money-gate denies none/unknown/tight; live
// transport refuses without the env flag; the token never appears in the audit log or transport args.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLaunchDoc } from '../../lib/launch/parser.js';
import {
  MetaManagementClient, MetaManagementError, MoneyGateDenied, makeMoneyGate, submitLaunch,
} from '../../lib/launch/writer.js';

const SECRET = 'EAAG-SUPER-SECRET-TOKEN-should-never-leak';
const dir = new URL('./fixtures/', import.meta.url);
const goldenExtracted = JSON.parse(readFileSync(new URL('bms_golden.extracted.json', dir), 'utf8'));

// Inject a registry mapping the golden's store to an account that MATCHES the doc's Ad Account ID
// (act_1234567890 in the fixture's LAUNCH CONFIG), so the cross-check passes and the plan is clean.
const REG = {
  peaceful_path: {
    slug: 'peaceful_path', store_name: 'Bible Made Simple', aliases: [],
    business_id: '999000111', business_name: 'Test BM', accounts: ['act_1234567890'],
  },
};
const cleanPlan = () => parseLaunchDoc(goldenExtracted, { reg: REG });

// A fake transport returning NUMERIC ids (Meta object ids are numeric) so the created ids satisfy
// the activate allowlist (^[0-9]+$). NEVER receives the token. `kind` map lets tests classify ids.
function fakeTransport() {
  let n = 1000;
  const seen = [];
  const kind = {};   // id -> 'video'|'campaign'|'adset'|'ad'
  const fn = async (path, params) => {
    seen.push({ path, params });
    let k = 'other';
    if (path.endsWith('/advideos')) k = 'video';
    else if (path.endsWith('/campaigns')) k = 'campaign';
    else if (path.endsWith('/adsets')) k = 'adset';
    else if (path.endsWith('/ads')) k = 'ad';
    if (k !== 'other') { const id = String(++n); kind[id] = k; return { id }; }
    return { id: path, success: true };   // activate: status update on an existing numeric id
  };
  fn.seen = seen; fn.kind = kind;
  return fn;
}

const roomAsl = async () => ({ spend_cap: '100000000', amount_spent: '100000', account_status: 1 }); // $1M cap
const noAsl = async () => ({ spend_cap: '0', amount_spent: '0', account_status: 1 });
const tightAsl = async () => ({ spend_cap: '10000', amount_spent: '9900', account_status: 1 }); // $100 cap, $1 room

function client(readAsl, { confirmTight = false } = {}) {
  const transport = fakeTransport();
  const c = new MetaManagementClient({
    token: SECRET, moneyGate: makeMoneyGate(readAsl, { confirmTight }),
    allowManagement: true, transport,
  });
  return { c, transport };
}

test('cannot construct an ungated or unauthorized write client', () => {
  assert.throws(() => new MetaManagementClient({ token: SECRET, moneyGate: () => {} }), MetaManagementError);
  assert.throws(() => new MetaManagementClient({ token: SECRET, moneyGate: null, allowManagement: true }), MetaManagementError);
});

test('happy path: build all PAUSED, verify, activate only week-1', async () => {
  const plan = cleanPlan();
  assert.equal(plan.blockers.length, 0, 'injected reg should clear routing blocker');
  const { c, transport } = client(roomAsl);
  const res = await submitLaunch(plan, { readAslFn: roomAsl, mgmtClient: c });
  assert.equal(res.status, 'active');
  // every create call was PAUSED
  const creates = c.calls.filter((x) => /\/(campaigns|adsets|ads)$/.test(x.path));
  assert.ok(creates.length > 0);
  for (const cr of creates) assert.equal(cr.params.status, 'PAUSED');
  // campaign carried a spend_cap (Layer-1 ceiling)
  const camp = c.calls.find((x) => x.path.endsWith('/campaigns'));
  assert.ok(camp.params.spend_cap > 0);
  // only week-1 ads activated (staged ads stay PAUSED): activated = campaign + adsets + week1 ads
  const week1Ads = plan.ads.filter((a) => a.launch_week === 1).length;
  const nAdsets = Object.keys(plan.ad_sets).length;
  const activatedAds = res.activated.filter((id) => transport.kind[id] === 'ad').length;
  assert.equal(activatedAds, week1Ads, 'exactly the week-1 ads activated');
  assert.equal(res.activated.length, 1 + nAdsets + week1Ads, 'activated = 1 campaign + all adsets + week1 ads');
  assert.ok(res.activated.includes(res.created.campaign), 'campaign activated');
  // staged (non-week-1) ads were built but NOT activated
  const stagedAds = plan.ads.length - week1Ads;
  const builtAds = res.created.ads.length;
  assert.equal(builtAds, plan.ads.length);
  assert.equal(builtAds - activatedAds, stagedAds, 'staged ads remain PAUSED');
});

test('no-ASL account: hard block, NOTHING activated ($0)', async () => {
  const { c } = client(noAsl);
  const res = await submitLaunch(cleanPlan(), { readAslFn: noAsl, mgmtClient: c });
  assert.equal(res.status, 'aborted_no_asl');
  assert.equal(res.activated.length, 0);
  // no ACTIVE status ever posted
  assert.ok(!c.calls.some((x) => x.params.status === 'ACTIVE'));
});

test('tight ASL: staged (do not activate) unless confirmed', async () => {
  const { c } = client(tightAsl);                                   // confirmTight defaults false
  const res = await submitLaunch(cleanPlan(), { readAslFn: tightAsl, mgmtClient: c });
  assert.equal(res.status, 'aborted_tight_unconfirmed');
  assert.equal(res.activated.length, 0);
});

test('money-gate denies none/unknown, allows room', async () => {
  const gNone = makeMoneyGate(noAsl);
  await assert.rejects(() => gNone({ accountId: 'act_1', committedUsd: 10 }), MoneyGateDenied);
  const gUnknown = makeMoneyGate(async () => null);
  await assert.rejects(() => gUnknown({ accountId: 'act_1', committedUsd: 10 }), MoneyGateDenied);
  const gRoom = makeMoneyGate(roomAsl);
  const d = await gRoom({ accountId: 'act_1', committedUsd: 10 });
  assert.equal(d.state, 'room');
});

test('live transport REFUSES without META_LAUNCH_ALLOW_LIVE_WRITES=1', async () => {
  const prev = process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  delete process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  // default transport = _livePost (no injected transport)
  const c = new MetaManagementClient({ token: SECRET, moneyGate: makeMoneyGate(roomAsl), allowManagement: true });
  await assert.rejects(() => c.uploadVideo('act_1', 'x.mp4'), /LIVE WRITES DISABLED/);
  if (prev !== undefined) process.env.META_LAUNCH_ALLOW_LIVE_WRITES = prev;
});

test('TOKEN NEVER LEAKS: absent from audit log and transport args', async () => {
  const { c, transport } = client(roomAsl);
  await submitLaunch(cleanPlan(), { readAslFn: roomAsl, mgmtClient: c });
  const auditStr = JSON.stringify(c.calls);
  assert.ok(!auditStr.includes(SECRET), 'token found in audit log');
  const transportStr = JSON.stringify(transport.seen);
  assert.ok(!transportStr.includes(SECRET), 'token found in transport args');
  // token also never lives in any path
  for (const call of c.calls) assert.ok(!call.path.includes(SECRET));
});
