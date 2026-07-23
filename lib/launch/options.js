/**
 * lib/launch/options.js — configurable-input engine for the multi-select grouped launch.
 * JS parity port of drims-workers/launch_options.py. Keep the two in sync.
 *
 * HARD RULE: defaults are fine, hardcodes are banned.
 *   Every value is (default, overridable). No store slug / BM / account / page / per-store
 *   number appears in this file. Store values arrive only via storeCfg.
 */

export const DEFAULTS = {
  videos_per_adset: 5,      // operator sets 3/4/5/6/... per launch
  objective: 'OUTCOME_SALES', // Meta ODAX objective — editable per launch
  budget_mode: 'CBO',       // 'CBO' = budget on campaign | 'ABO' = budget per ad set
  daily_budget_usd: 0,
  spend_cap_usd: 0,
  schedule: { start_time: null, end_time: null, run_days: null },
  targeting: null,
  account_id: null,         // null -> from store config
  page_id: null,            // null -> from store config
};

export const BUDGET_MODES = ['CBO', 'ABO'];
// Meta ODAX campaign objectives (the current non-deprecated set).
export const OBJECTIVES = ['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION'];

const EDITABLE = {
  campaign: new Set(['name', 'objective', 'budget_mode', 'daily_budget_usd', 'spend_cap_usd']),
  adset: new Set(['name', 'daily_budget_usd', 'targeting', 'schedule']),
  ad: new Set(['name', 'headline', 'primary_text', 'drive_url', 'landing_url']),
};

export class LaunchOptionError extends Error {}

const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

export function validateOptions(o) {
  if (!Number.isInteger(o.videos_per_adset) || o.videos_per_adset < 1)
    throw new LaunchOptionError(`videos_per_adset must be an integer >= 1, got ${o.videos_per_adset}`);
  if (!BUDGET_MODES.includes(o.budget_mode))
    throw new LaunchOptionError(`budget_mode must be CBO or ABO, got ${o.budget_mode}`);
  if (!OBJECTIVES.includes(o.objective))
    throw new LaunchOptionError(`objective must be one of ${OBJECTIVES.join('/')}, got ${o.objective}`);
  for (const k of ['daily_budget_usd', 'spend_cap_usd']) {
    if (typeof o[k] !== 'number' || Number.isNaN(o[k]) || o[k] < 0)
      throw new LaunchOptionError(`${k} must be a non-negative number, got ${o[k]}`);
  }
}

/** Merge operator input over store defaults over DEFAULTS. Operator ALWAYS wins. */
export function resolveOptions(operatorInput, storeCfg) {
  storeCfg = storeCfg || {};
  const opts = clone(DEFAULTS);

  if (storeCfg.targeting != null) opts.targeting = clone(storeCfg.targeting);
  if (storeCfg.ad_account_id) opts.account_id = storeCfg.ad_account_id;
  if (storeCfg.page_id) opts.page_id = storeCfg.page_id;

  for (const [k, v] of Object.entries(operatorInput || {})) {
    if (!(k in opts)) throw new LaunchOptionError(`unknown launch option ${k}`);
    if (v !== null && v !== undefined) opts[k] = v;
  }
  validateOptions(opts);
  return opts;
}

/** Chunk selection into ad-set groups, preserving operator selection order. */
export function groupVideos(selected, videosPerAdset) {
  if (!Number.isInteger(videosPerAdset) || videosPerAdset < 1)
    throw new LaunchOptionError(`videos_per_adset must be an integer >= 1, got ${videosPerAdset}`);
  if (!selected || !selected.length) throw new LaunchOptionError('no videos selected');
  const out = [];
  for (let i = 0; i < selected.length; i += videosPerAdset)
    out.push(selected.slice(i, i + videosPerAdset));
  return out;
}

export const adsetCount = (n, per) => Math.ceil(n / per);

// ── name suggestions (PREFILL ONLY — always editable downstream) ──────────
export const suggestCampaignName = (s, o, d) =>
  `${s.store_name || s.store_slug || 'launch'} — ${d} — ${o.budget_mode}`;

export function suggestAdsetName(s, i, tasks) {
  const ids = tasks.map((t) => String(t.task_id ?? t.id ?? '?'));
  const span = ids.length > 1 ? `${ids[0]}…${ids[ids.length - 1]}` : ids[0];
  return `${s.store_slug || 'set'} — Set ${i + 1} (${span})`;
}

// Prefer the human-readable task NAME (falls back to id) — operators read "SCA-0081 ST Gift Bars",
// not "86ajh3q0y". Editable downstream like every suggestion.
export const suggestAdName = (t) => String(t.name ?? t.task_id ?? t.id ?? 'ad');

/** Expand selection + options into the full reviewable object tree. Pure. */
export function buildPlan(selectedTasks, opts, storeCfg, { dateStr }) {
  if (!selectedTasks || !selectedTasks.length) throw new LaunchOptionError('no videos selected');
  validateOptions(opts);

  const account_id = opts.account_id || storeCfg.ad_account_id;
  const page_id = opts.page_id || storeCfg.page_id;
  if (!account_id) throw new LaunchOptionError('no ad account: store config has none and none supplied');
  if (!page_id) throw new LaunchOptionError('no page: store config has none and none supplied');

  const groups = groupVideos(selectedTasks, opts.videos_per_adset);
  const cbo = opts.budget_mode === 'CBO';

  const adsets = groups.map((tasks, i) => ({
    name: suggestAdsetName(storeCfg, i, tasks),
    daily_budget_usd: cbo ? null : opts.daily_budget_usd,
    targeting: clone(opts.targeting),
    schedule: clone(opts.schedule),
    ads: tasks.map((t) => ({
      name: suggestAdName(t),
      task_id: t.task_id ?? t.id,
      drive_url: t.drive_url ?? t.drive_link ?? null,
      headline: t.headline ?? null,
      primary_text: t.primary_text ?? t.ad_copy ?? null,
      landing_url: t.landing_url ?? storeCfg.default_landing ?? null,
    })),
  }));

  return {
    store_slug: storeCfg.store_slug ?? null,
    account_id,
    page_id,
    campaign: {
      name: suggestCampaignName(storeCfg, opts, dateStr),
      objective: opts.objective,
      budget_mode: opts.budget_mode,
      daily_budget_usd: cbo ? opts.daily_budget_usd : null,
      spend_cap_usd: opts.spend_cap_usd,
    },
    adsets,
    status: 'PAUSED',
    do_activate: false,
  };
}

/** Apply review-screen edits. Returns a NEW plan. Unknown fields raise. */
export function applyEdits(plan, edits) {
  const p = clone(plan);

  for (const [k, v] of Object.entries(edits.campaign || {})) {
    if (!EDITABLE.campaign.has(k)) throw new LaunchOptionError(`campaign field ${k} is not editable`);
    p.campaign[k] = v;
  }
  for (const [idx, patch] of Object.entries(edits.adsets || {})) {
    const i = Number(idx);
    if (!(i >= 0 && i < p.adsets.length)) throw new LaunchOptionError(`no ad set at index ${i}`);
    for (const [k, v] of Object.entries(patch)) {
      if (!EDITABLE.adset.has(k)) throw new LaunchOptionError(`ad set field ${k} is not editable`);
      p.adsets[i][k] = v;
    }
  }
  for (const [key, patch] of Object.entries(edits.ads || {})) {
    const [si, ai] = key.split(',').map(Number);
    if (!(si >= 0 && si < p.adsets.length) || !(ai >= 0 && ai < p.adsets[si].ads.length))
      throw new LaunchOptionError(`no ad at (${si}, ${ai})`);
    for (const [k, v] of Object.entries(patch)) {
      if (!EDITABLE.ad.has(k)) throw new LaunchOptionError(`ad field ${k} is not editable`);
      p.adsets[si].ads[ai][k] = v;
    }
  }
  return renormalizeBudget(p);
}

/** Keep budget placement consistent with budget_mode after an edit. */
export function renormalizeBudget(p) {
  if (p.campaign.budget_mode === 'CBO') {
    p.adsets.forEach((a) => { a.daily_budget_usd = null; });
  } else if (p.campaign.daily_budget_usd !== null) {
    const fallback = p.campaign.daily_budget_usd;
    p.campaign.daily_budget_usd = null;
    p.adsets.forEach((a) => { if (a.daily_budget_usd === null) a.daily_budget_usd = fallback; });
  }
  return p;
}

/**
 * TRUE total daily spend. CBO = campaign budget. ABO = SUM across ad sets —
 * 3 ad sets at $500 is $1500/day, not $500. ASL gate and confirm dialog both use this.
 */
export function totalDailySpend(plan) {
  if (plan.campaign.budget_mode === 'CBO') return Number(plan.campaign.daily_budget_usd || 0);
  return plan.adsets.reduce((s, a) => s + Number(a.daily_budget_usd || 0), 0);
}

export function planSummary(plan) {
  return {
    store_slug: plan.store_slug,
    account_id: plan.account_id,
    campaign: plan.campaign.name,
    budget_mode: plan.campaign.budget_mode,
    adsets: plan.adsets.length,
    ads: plan.adsets.reduce((s, a) => s + a.ads.length, 0),
    total_daily_usd: totalDailySpend(plan),
    spend_cap_usd: plan.campaign.spend_cap_usd,
    status: plan.status,
  };
}
