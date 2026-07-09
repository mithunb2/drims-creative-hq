// writer.js — the WRITE path. 1:1 port of drims-meta-launch/meta_management.py + launch_writer.py.
//
// SAFETY SPINE (first code that can spend money — identical guarantees to the Python reference):
//   1. MetaManagementClient must be constructed with allowManagement=true AND a moneyGate.
//   2. Every POST must match WRITE_ALLOWLIST.
//   3. create* can ONLY create PAUSED objects — no path creates an ACTIVE object. Going live
//      happens ONLY through activate(), which calls the moneyGate (a FRESH ASL read) first.
//   4. The default live transport REFUSES to hit the network unless
//      META_LAUNCH_ALLOW_LIVE_WRITES === '1'. Tokenless/logic-proof phase performs no live writes.
//
// The real overspend guarantee is Meta's Account Spending Limit, not this client. This client's job:
// (a) refuse to go live into an account with no ceiling, (b) never leave a half-built launch live.
import { classifyAsl } from './asl.js';

export class MetaManagementError extends Error {}
export class MoneyGateDenied extends MetaManagementError {}

export const WRITE_ALLOWLIST = [
  /^act_[0-9]+\/advideos$/,
  /^act_[0-9]+\/campaigns$/,
  /^act_[0-9]+\/adsets$/,
  /^act_[0-9]+\/adcreatives$/,
  /^act_[0-9]+\/ads$/,
  /^[0-9]+$/, // status update on an id we created (activate)
];

const usdToCents = (usd) => Math.round(Number(usd) * 100);
const OBJECTIVE = 'OUTCOME_SALES';

export class MetaManagementClient {
  /** @param {object} o - {token, moneyGate, allowManagement, transport, apiVersion} */
  constructor({ token, moneyGate, allowManagement = false, transport = null, apiVersion = 'v21.0' } = {}) {
    if (!allowManagement) throw new MetaManagementError('refusing to build a write client without explicit allowManagement=true');
    if (moneyGate == null) throw new MetaManagementError('a moneyGate is REQUIRED — no ungated write client exists');
    this._token = token;
    this._gate = moneyGate;
    this._transport = transport || this._livePost.bind(this);
    this._api = apiVersion;
    this.calls = []; // audit log of every POST (path, params) — NEVER a token
  }

  // ── chokepoint ──────────────────────────────────────────────────────────────────
  async _post(path, params) {
    if (!WRITE_ALLOWLIST.some((rx) => rx.test(path))) {
      throw new MetaManagementError(`path not on WRITE allowlist: ${JSON.stringify(path)}`);
    }
    this.calls.push({ path, params: { ...params } });   // audit log: never a token
    return this._transport(path, { ...params });        // token NEVER reaches transport args
  }

  async _livePost(path, params) {
    if (process.env.META_LAUNCH_ALLOW_LIVE_WRITES !== '1') {
      throw new MetaManagementError('LIVE WRITES DISABLED (set META_LAUNCH_ALLOW_LIVE_WRITES=1 to enable). '
        + 'Tokenless/logic-proof phase performs no live writes.');
    }
    const url = `https://graph.facebook.com/${this._api}/${path}`;   // no token in URL
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const r = await fetch(url, {                                     // no token in body
      method: 'POST',
      headers: { Authorization: `Bearer ${this._token}` },
      body,
    });
    return r.json();
  }

  // ── build helpers: ONLY create PAUSED objects ────────────────────────────────────
  async uploadVideo(accountId, sourceRef) {
    return (await this._post(`${accountId}/advideos`, { source_ref: sourceRef })).id;
  }

  async createCampaign(accountId, { name, objective, launchSpendCapUsd }) {
    if (!launchSpendCapUsd || launchSpendCapUsd <= 0) {
      throw new MetaManagementError('createCampaign requires a positive Launch Spend Cap (the per-launch Layer-1 ceiling)');
    }
    return (await this._post(`${accountId}/campaigns`, {
      name, objective, buying_type: 'AUCTION',
      spend_cap: usdToCents(launchSpendCapUsd),
      status: 'PAUSED', // never ACTIVE here
    })).id;
  }

  async createAdset(accountId, { name, campaignId, dailyBudgetUsd, targeting, promotedObject }) {
    return (await this._post(`${accountId}/adsets`, {
      name, campaign_id: campaignId,
      daily_budget: usdToCents(dailyBudgetUsd),
      targeting, promoted_object: promotedObject,
      status: 'PAUSED',
    })).id;
  }

  async createAd(accountId, { name, adsetId, creative }) {
    return (await this._post(`${accountId}/ads`, { name, adset_id: adsetId, creative, status: 'PAUSED' })).id;
  }

  // ── the ONLY spend-starting call — money-gated on a FRESH read ────────────────────
  async activate(objectIds, { accountId, committedUsd }) {
    const decision = await this._gate({ accountId, committedUsd });   // may throw MoneyGateDenied
    const activated = [];
    for (const oid of objectIds) {
      await this._post(oid, { status: 'ACTIVE' });
      activated.push(oid);
    }
    return { activated, gate: decision };
  }
}

/** A moneyGate bound to a FRESH-read function. Policy: 'none'/'unknown' NEVER pass; 'tight' passes
 *  only if confirmTight; 'room' passes. Re-reads the ASL every call. */
export function makeMoneyGate(readAslFn, { confirmTight = false } = {}) {
  return async function gate({ accountId, committedUsd }) {
    const fields = await readAslFn(accountId);          // FRESH read, not a cached snapshot
    const d = classifyAsl(fields, committedUsd);
    if (d.state === 'none' || d.state === 'unknown') throw new MoneyGateDenied(`money_gate DENIED: ${d.message}`);
    if (d.state === 'tight' && !confirmTight) throw new MoneyGateDenied(`money_gate DENIED (tight, unconfirmed): ${d.message}`);
    return d;
  };
}

// ── staged Submit sequence (port of launch_writer.submit_launch) ──────────────────
const abort = (status, reason, extra = {}) => ({ status, activated: [], reason, ...extra });

function verify(mgmt, nAdsets, nAds) {
  const creates = mgmt.calls.filter((c) => /\/(campaigns|adsets|ads)$/.test(c.path));
  for (const c of creates) {
    if (c.params.status !== 'PAUSED') return [false, `non-PAUSED object built: ${c.path}`];
  }
  const camps = mgmt.calls.filter((c) => c.path.endsWith('/campaigns'));
  if (camps.length !== 1 || !camps[0].params.spend_cap) return [false, 'campaign missing or has no spend_cap (Layer-1 ceiling)'];
  const gotAdsets = mgmt.calls.filter((c) => c.path.endsWith('/adsets')).length;
  const gotAds = mgmt.calls.filter((c) => c.path.endsWith('/ads')).length;
  if (gotAdsets !== nAdsets || gotAds !== nAds) return [false, `tree count mismatch: adsets ${gotAdsets}/${nAdsets}, ads ${gotAds}/${nAds}`];
  return [true, ''];
}

/** Order (crash-safe): fresh ASL read + gate -> build everything PAUSED -> verify tree + ASL still
 *  set -> activate (the ONLY spend-starting step, itself money-gated on a fresh read). An abort or
 *  crash before activate leaves everything PAUSED => $0 spent. */
export async function submitLaunch(plan, { readAslFn, mgmtClient, confirmTight = false, doActivate = true }) {
  const accountId = plan.account_id;
  if (!accountId) return abort('aborted_no_account', 'no ad account mapped for this store');
  if (plan.blockers && plan.blockers.length) return abort('aborted_blocked', `plan has blockers: ${JSON.stringify(plan.blockers)}`);
  const committed = plan.budget.launch_spend_cap;

  // 1. FRESH ASL read + up-front gate (fail before any write)
  const upFront = classifyAsl(await readAslFn(accountId), committed);
  if (upFront.state === 'none' || upFront.state === 'unknown') return abort('aborted_no_asl', upFront.message, { asl: upFront });
  if (upFront.state === 'tight' && !confirmTight) return abort('aborted_tight_unconfirmed', upFront.message, { asl: upFront });

  // 2. build everything PAUSED
  const created = { videos: {}, campaign: null, adsets: {}, ads: [] };
  try {
    const daily = plan.budget.amount;
    for (const vf of [...new Set(plan.ads.map((a) => a.video_file))].sort()) {
      created.videos[vf] = await mgmtClient.uploadVideo(accountId, vf);
    }
    created.campaign = await mgmtClient.createCampaign(accountId, {
      name: plan.campaign.label, objective: OBJECTIVE, launchSpendCapUsd: committed,
    });
    for (const aset of Object.keys(plan.ad_sets).sort()) {
      created.adsets[aset] = await mgmtClient.createAdset(accountId, {
        name: aset, campaignId: created.campaign, dailyBudgetUsd: daily,
        targeting: { note: 'from doc defaults' },
        promotedObject: { custom_conversion: plan.config['Custom Conversion'] },
      });
    }
    for (const a of plan.ads) {
      const aid = await mgmtClient.createAd(accountId, {
        name: (a.name_string || '').slice(0, 90) || a.ad_number,
        adsetId: created.adsets[a.ad_set],
        creative: { video_id: created.videos[a.video_file] },
      });
      created.ads.push({ ad: a.ad_number, id: aid, adset: a.ad_set, week: a.launch_week });
    }
  } catch (e) {
    return abort('build_failed', `${e.constructor.name}: ${e.message}`, { created }); // all PAUSED -> $0
  }

  // 3. verify built tree + ASL still set
  const [ok, why] = verify(mgmtClient, Object.keys(plan.ad_sets).length, plan.ads.length);
  if (!ok) return abort('verify_failed', why, { created });
  const midState = classifyAsl(await readAslFn(accountId), committed).state;
  if (midState === 'none' || midState === 'unknown') return abort('aborted_asl_lost', 'ASL disappeared during build', { created });

  if (!doActivate) return { status: 'staged_paused', activated: [], created };

  // 4. activate — the ONLY spend-starting step; client re-gates on a FRESH read
  const liveIds = [created.campaign, ...Object.values(created.adsets)];
  liveIds.push(...created.ads.filter((a) => a.week === 1).map((a) => a.id)); // staged ads stay PAUSED
  try {
    const act = await mgmtClient.activate(liveIds, { accountId, committedUsd: committed });
    return { status: 'active', activated: act.activated, created, gate: act.gate };
  } catch (e) {
    if (e instanceof MoneyGateDenied) return abort('activate_denied', e.message, { created });
    throw e;
  }
}
