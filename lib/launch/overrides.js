// overrides.js — the buyer-edit layer for the launch pipeline. PURE (no I/O): the /api/launch-edit
// endpoint and /api/launch-submit both drive these functions; unit-tested in isolation. Two hard
// rules live here: (1) an edit NEVER overwrites the doc-held value — effective = override ?? held,
// so provenance survives and revert = drop the key; (2) a BUDGET or AD-ACCOUNT edit RE-RUNS the same
// budget + ASL + registry safety checks the doc went through — editing changes WHAT launches, never
// whether the safety gate holds. Money-critical validation reuses parser/asl/registry verbatim.
import { computeBudget, parseMoney, parseIntStrict, parseNameString } from './parser.js';
import { evaluateAsl, classifyAsl, aslAllowsLaunch } from './asl.js';
import { resolve as resolveStore, accountFor } from './registry.js';

export const SAFETY_CRITICAL = new Set(['budget_amount', 'budget_type', 'budget_level', 'spend_cap', 'run_length', 'account_id']);
export const JOB_FIELDS = new Set(['budget_amount', 'budget_type', 'budget_level', 'spend_cap', 'run_length', 'account_id']);
export const HOLD_FIELDS = new Set(['ad_set', 'ad_copy', 'ad_name_short', 'ad_name_full']);

// ── Effective layers (override ?? held) ─────────────────────────────────────────────
const CFG_KEY = { budget_amount: 'Budget Amount (USD)', budget_type: 'Budget Type',
  budget_level: 'Budget Level', spend_cap: 'Launch Spend Cap (USD)', run_length: 'Run Length (days)' };

/** Doc campaign_config with the job's budget overrides layered on (config-native keys). */
export function effectiveConfig(job) {
  const c = { ...((job && job.campaign_config) || {}) };
  const o = (job && job.overrides) || {};
  for (const k of ['budget_amount', 'budget_type', 'budget_level', 'spend_cap', 'run_length']) {
    if (o[k] != null && o[k] !== '') c[CFG_KEY[k]] = String(o[k]);
  }
  return c;
}

/** The account launches actually target = override ?? doc-resolved. */
export function effectiveAccount(job) {
  const o = (job && job.overrides) || {};
  return (o.account_id != null && o.account_id !== '') ? o.account_id : ((job && job.account_id) || null);
}

/** launch_half with per-ad overrides layered on (+ the effective short name). */
export function effectiveHold(hold, job) {
  const lh = { ...((hold && hold.launch_half) || {}) };
  const o = (hold && hold.overrides) || {};
  if (o.ad_set != null) lh.ad_set = o.ad_set;
  if (o.ad_copy != null) lh.ad_copy = o.ad_copy;
  if (o.ad_name_full != null) lh.name_string = o.ad_name_full;
  lh.ad_name_short = (o.ad_name_short != null && o.ad_name_short !== '')
    ? o.ad_name_short : genShortName(hold, job);
  return lh;
}

// ── Short, human ad name (auto from the task, editable) ──────────────────────────────
/** Store-name initials, e.g. "Acme Bright Co" -> "ABC". Deterministic, no registry field needed. */
export function storeAbbr(storeName) {
  const words = String(storeName || '').trim().split(/[\s_]+/).filter(Boolean);
  if (!words.length) return '';
  const skip = new Set(['the', 'of', 'and', 'a', 'an', '&']);
  const sig = words.filter((w) => !skip.has(w.toLowerCase()));
  return (sig.length ? sig : words).map((w) => w[0].toUpperCase()).join('');
}

/** Default short name = "{ABBR} · {hook} · {ad_set}" (falls back to AD number / video). */
export function genShortName(hold, job) {
  const lh = (hold && hold.launch_half) || {};
  const abbr = storeAbbr((job && (job.store_name || job.store_slug)) || '');
  const hook = (lh.tokens && lh.tokens.h) || hold?.test_label || (lh.tokens && lh.tokens.hook) || '';
  const setL = (hold?.overrides && hold.overrides.ad_set) || lh.ad_set || '';
  const mid = hook ? String(hook) : (hold?.ad_number ? `AD ${hold.ad_number}` : (lh.video_file || ''));
  return [abbr, mid, setL].filter(Boolean).join(' · ');
}

// ── Registry reverse lookup (which store owns an account) ────────────────────────────
/** Find the store record whose accounts include this id. null if unknown to the registry. */
export function recordForAccount(accountId, reg) {
  if (!accountId) return null;
  const R = reg || {};
  for (const [slug, r] of Object.entries(R)) {
    if ((r.accounts || []).includes(accountId)) return { slug, record: r };
  }
  return null;
}

/** The accounts a buyer may switch THIS job to = the job's store's own registry accounts (same BM).
 *  Cross-store switching is BLOCKED (spend must stay in the store's Business Manager). */
export function allowedAccounts(job, reg) {
  const rec = resolveStore((job && (job.store_slug || job.store_name)) || '', reg);
  return (rec && rec.accounts) ? rec.accounts.slice() : [];
}

// ── Budget re-validation (pure; reused on every budget edit AND at launch) ────────────
/** Distinct ad-sets across the job's holds (effective). Used as active==total (conservative). */
export function adSetsOf(holds) {
  const s = new Set();
  for (const h of holds || []) {
    const v = (h.overrides && h.overrides.ad_set) || (h.launch_half && h.launch_half.ad_set) || '';
    if (v) s.add(v);
  }
  return [...s];
}

/** Recompute the budget from effective config + re-run the ASL gate. aslFields=null (tokenless) ->
 *  ASL 'unknown' -> not launch-permitting (fail-closed), but the edit is still recordable. With a
 *  LIVE aslFields (Phase 2), evaluateAsl BLOCK means the budget overspends headroom -> hard reject. */
export function revalidateBudget(job, holds, aslFields = null) {
  const cfg = effectiveConfig(job);
  const nSets = Math.max(1, adSetsOf(holds).length);
  const out = { ok: true, blockers: [], warnings: [], budget: null, asl: null };
  let cap = 0;
  try {
    for (const [f, key] of Object.entries(CFG_KEY)) {
      if (f === 'budget_type' || f === 'budget_level') continue;
      if (cfg[key] != null && cfg[key] !== '') (f === 'run_length' ? parseIntStrict : parseMoney)(cfg[key]);
    }
    out.budget = computeBudget(cfg, nSets, nSets);
    cap = out.budget.launch_spend_cap;
    if (out.budget.launch_spend_cap < out.budget.run_total_estimate) {
      out.warnings.push(`Launch Spend Cap $${cap.toFixed(2)} < estimated run $${out.budget.run_total_estimate.toFixed(2)} — cap may throttle delivery`);
    }
  } catch (e) { out.ok = false; out.blockers.push(`budget: ${e.message}`); return out; }
  // Hard ASL gate: only rejects when a LIVE read proves overspend. Tokenless -> unknown (no reject).
  if (aslFields) {
    const av = evaluateAsl(aslFields, cap);
    out.asl = av;
    if (av.decision === 'BLOCK') { out.ok = false; out.blockers.push(`ASL: ${av.reason}`); }
  } else {
    out.asl = classifyAsl(null, cap);   // state 'unknown'
  }
  return out;
}

// ── Per-field edit validation (the /api/launch-edit brain) ───────────────────────────
/** Validate one edit against the effective state. Returns {ok, value, safety_critical, revalidation,
 *  reason}. On ok the caller writes overrides[field]=value + an audit row. Never mutates inputs. */
export function validateEdit({ field, value, job, hold, holds, reg, aslFields = null }) {
  const sc = SAFETY_CRITICAL.has(field);
  const bad = (reason) => ({ ok: false, safety_critical: sc, reason });
  if (!JOB_FIELDS.has(field) && !HOLD_FIELDS.has(field)) return bad(`unknown editable field '${field}'`);

  // Money / account edits re-run the safety checks on a TRIAL job with the edit applied.
  if (field === 'budget_amount' || field === 'spend_cap') {
    try { parseMoney(String(value)); } catch (e) { return bad(e.message); }
  }
  if (field === 'run_length') { try { parseIntStrict(String(value)); } catch (e) { return bad(e.message); } }
  if (field === 'budget_level' && !['ad_set', 'campaign'].includes(String(value)))
    return bad(`Budget Level must be 'ad_set' or 'campaign' (got '${value}')`);

  if (field === 'account_id') {
    const allowed = allowedAccounts(job, reg);
    if (!allowed.includes(String(value)))
      return bad(`account ${value} is not one of this store's registry accounts [${allowed.join(', ') || 'none'}] — cross-store switching is blocked`);
    // Re-validate the target account resolves + (Phase 2) its ASL is checked at launch.
    const owner = recordForAccount(String(value), reg);
    if (!owner) return bad(`account ${value} is not in the registry`);
    const trial = { ...job, overrides: { ...(job.overrides || {}), account_id: String(value) } };
    const rb = revalidateBudget(trial, holds, aslFields);
    return { ok: rb.ok, value: String(value), safety_critical: true,
      revalidation: { account_id: String(value), account_owner: owner.slug, ...rb },
      reason: rb.ok ? null : rb.blockers.join('; ') };
  }

  if (JOB_FIELDS.has(field)) {          // budget_* / spend_cap / run_length
    const trial = { ...job, overrides: { ...(job.overrides || {}), [field]: value } };
    const rb = revalidateBudget(trial, holds, aslFields);
    return { ok: rb.ok, value, safety_critical: sc, revalidation: rb,
      reason: rb.ok ? null : rb.blockers.join('; ') };
  }

  // ── Per-ad (non-safety) edits ──
  if (field === 'ad_copy') {
    const s = String(value);
    if (s.length > 5000) return bad('ad copy too long (>5000 chars)');
    return { ok: true, value: s, safety_critical: false };     // stored VERBATIM, never regenerated
  }
  if (field === 'ad_set') {
    const s = String(value).trim();
    if (!s) return bad('ad set cannot be empty');
    return { ok: true, value: s, safety_critical: false };
  }
  if (field === 'ad_name_short') {
    const s = String(value).trim();
    if (!s) return bad('short name cannot be empty');
    if (s.length > 80) return bad('short name too long (>80 chars)');
    // Unique within the job (compare against every OTHER hold's effective short name).
    const clash = (holds || []).some((h) => h.id !== (hold && hold.id) &&
      effectiveHold(h, job).ad_name_short.toLowerCase() === s.toLowerCase());
    if (clash) return bad(`short name '${s}' already used by another ad in this job`);
    return { ok: true, value: s, safety_critical: false };
  }
  if (field === 'ad_name_full') {
    const s = String(value).trim();
    const [, errs] = parseNameString(s);
    return { ok: true, value: s, safety_critical: false,
      revalidation: { name_warnings: errs } };                 // warn (not block) on token issues
  }
  return bad(`field '${field}' not handled`);
}

// ── Effective launch plan (the Phase-2 adapter: holds ∪ overrides -> gate verdict) ────
/** Reconstruct the launch permission from launch_holds + overrides (NOT the doc). Feeds the SAME
 *  gate in /api/launch-submit. Tokenless aslFields=null -> asl 'unknown' -> allowed:false (gate holds).
 *  This is what makes an EDITED value the thing that (would) launch — re-validated server-side. */
export function buildEffectivePlan(job, holds, reg, aslFields = null) {
  const blockers = [];
  const account_id = effectiveAccount(job);
  const owner = recordForAccount(account_id, reg);
  if (!account_id) blockers.push('no target account (store unmapped / account cleared)');
  else if (!owner) blockers.push(`effective account ${account_id} is not in the registry`);
  else {
    const allowed = allowedAccounts(job, reg);
    if (allowed.length && !allowed.includes(account_id))
      blockers.push(`effective account ${account_id} is outside this store's accounts — cross-store spend blocked`);
  }
  const rb = revalidateBudget(job, holds, aslFields);
  blockers.push(...rb.blockers);

  const committed = rb.budget ? rb.budget.launch_spend_cap : 0;
  const aslGate = classifyAsl(aslFields, committed);
  const structurallyOk = blockers.length === 0;
  const aslOk = aslAllowsLaunch(aslGate);
  const qaOk = true;                       // per-ad QA flags aren't held; doc QA gates ran at commit
  return {
    account_id, effective: true, budget: rb.budget, asl_gate: aslGate,
    blockers, warnings: rb.warnings, ok: structurallyOk,
    launch_permission: {
      allowed: structurallyOk && aslOk && qaOk,
      structurally_ok: structurallyOk, asl_ok: aslOk, qa_ok: qaOk,
      asl_state: aslGate.state,
      reason: !structurallyOk ? 'structural blockers present'
        : !aslOk ? `ASL gate ${aslGate.state} — ${aslGate.message}`
          : 'all gates clear (still requires META_LAUNCH_ALLOW_LIVE_WRITES + human submit)',
    },
  };
}
