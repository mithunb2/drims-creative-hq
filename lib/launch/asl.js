// asl.js — the Account-Spending-Limit decision logic. 1:1 port of asl_preflight.py's PURE
// functions (evaluate_asl, classify_asl). NO I/O here — the actual ASL value must come from a
// LIVE Meta read (MetaReadClient), which is gated behind the security runbook. Tokenless, callers
// pass fields=null → treated as UNKNOWN → BLOCK (fail-closed). A hand-typed ASL is NEVER accepted:
// the whole overspend guarantee rests on this being Meta's REAL enforced number.

/** spend_cap / amount_spent are the account currency's MINOR unit (cents for USD) as strings. */
export function centsToUsd(v) {
  return parseInt(String(v), 10) / 100.0;
}

/** Conservative read-only preflight decision (blocks 'tight'). Pure over a Meta fields dict. */
export function evaluateAsl(fields, launchSpendCapUsd) {
  const rawCap = fields ? fields.spend_cap : undefined;
  const spent = (fields && fields.amount_spent != null) ? fields.amount_spent : '0';
  if (rawCap === null || rawCap === undefined || rawCap === '' || rawCap === '0' || rawCap === 0) {
    return {
      decision: 'BLOCK',
      reason: 'no Account Spending Limit set on this account (spend_cap is 0/absent) — Meta would enforce no ceiling',
      asl_usd: null, spent_usd: centsToUsd(spent), headroom_usd: null, launch_cap_usd: launchSpendCapUsd,
    };
  }
  const asl = centsToUsd(rawCap);
  const spentUsd = centsToUsd(spent);
  const headroom = Math.round((asl - spentUsd) * 100) / 100;
  const status = parseInt(fields.account_status ?? 0, 10);
  const note = status === 1 ? '' : ` (account_status=${status} — not ACTIVE)`;
  if (headroom < launchSpendCapUsd) {
    return {
      decision: 'BLOCK',
      reason: `headroom $${headroom.toFixed(2)} < launch spend cap $${launchSpendCapUsd.toFixed(2)}${note}`,
      asl_usd: asl, spent_usd: spentUsd, headroom_usd: headroom, launch_cap_usd: launchSpendCapUsd,
    };
  }
  return {
    decision: 'ALLOW',
    reason: `ASL $${asl.toFixed(2)} - spent $${spentUsd.toFixed(2)} = headroom $${headroom.toFixed(2)} >= launch cap $${launchSpendCapUsd.toFixed(2)}${note}`,
    asl_usd: asl, spent_usd: spentUsd, headroom_usd: headroom, launch_cap_usd: launchSpendCapUsd,
  };
}

/** 3-state gate for the WRITE path: 'none' = no ceiling (HARD BLOCK), 'tight' = ceiling set but
 *  headroom < committed (business decision — caps early), 'room' = headroom >= committed.
 *  With ANY ASL set, overspend is impossible, so 'tight' is not a safety block. Pure; reused by
 *  the money-gate. fields=null (no live read yet) → 'unknown' → treated as BLOCK by callers. */
export function classifyAsl(fields, committedUsd) {
  if (fields == null) {
    return {
      state: 'unknown', asl_usd: null, spent_usd: null, headroom_usd: null, committed_usd: committedUsd,
      message: 'ASL not read yet — a LIVE Meta read is required (gated behind the security runbook). Fail-closed: treated as BLOCK.',
    };
  }
  const rawCap = fields.spend_cap;
  const spent = centsToUsd(fields.amount_spent != null ? fields.amount_spent : '0');
  if (rawCap === null || rawCap === undefined || rawCap === '' || rawCap === '0' || rawCap === 0) {
    return {
      state: 'none', asl_usd: null, spent_usd: spent, headroom_usd: null, committed_usd: committedUsd,
      message: 'no Account Spending Limit set (spend_cap 0/absent) — no Meta-enforced ceiling',
    };
  }
  const asl = centsToUsd(rawCap);
  const headroom = Math.round((asl - spent) * 100) / 100;
  if (headroom >= committedUsd) {
    return {
      state: 'room', asl_usd: asl, spent_usd: spent, headroom_usd: headroom, committed_usd: committedUsd,
      message: `headroom $${headroom.toFixed(2)} >= launch $${committedUsd.toFixed(2)}`,
    };
  }
  return {
    state: 'tight', asl_usd: asl, spent_usd: spent, headroom_usd: headroom, committed_usd: committedUsd,
    message: `headroom $${headroom.toFixed(2)} < launch $${committedUsd.toFixed(2)} — will cap early (under-deliver)`,
  };
}

/** Does this ASL classification permit launch? Only 'room' (or 'tight' with explicit confirm).
 *  'unknown'/'none' NEVER pass. Used by the preview HARD-BLOCK and the money-gate. */
export function aslAllowsLaunch(cls, { confirmTight = false } = {}) {
  if (!cls) return false;
  if (cls.state === 'room') return true;
  if (cls.state === 'tight') return confirmTight;
  return false; // 'none' | 'unknown'
}
