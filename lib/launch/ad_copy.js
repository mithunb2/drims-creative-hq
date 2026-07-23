/**
 * lib/launch/ad_copy.js — extract Meta ad copy (headline + primary text) for a Production task.
 *
 * Two REAL sources exist in this workspace (verified on live data), in priority order:
 *   1. launch_holds.launch_half.ad_copy   — doc-pipeline tasks; verbatim buyer copy, keyed by
 *      production_task_id / clickup_task_id. Format: "Headline: …\nPrimary text: …".
 *   2. The task DESCRIPTION                — strategist/manual tasks carry labeled sections,
 *      e.g. "HEADLINE: FREE Today. $79 Tomorrow." + "PRIMARY COPY:\n<body…>".
 * Nothing found -> {headline:null, primary_text:null}: the UI flags it and the submit endpoint
 * REFUSES rather than launching an ad with no copy.
 *
 * Store-agnostic: pure text parsing, no store name/id appears here.
 */

// Label variants seen in the wild (buyer docs use "Primary text:", strategist briefs "PRIMARY COPY:").
const HEADLINE_RE = /^[ \t>*_]*headline[ \t]*:[ \t]*(.+)$/im;
const PRIMARY_START_RE = /^[ \t>*_]*(?:primary[ \t]+(?:copy|text))[ \t]*:[ \t]*/im;
// A primary-copy block ends at the next ALL-CAPS "LABEL:" line (section boundary) or end of text.
const NEXT_LABEL_RE = /^[ \t]*[A-Z][A-Z0-9 ()/&-]{2,40}:[ \t]*(?:$|\S)/m;

/** Parse "Headline: …" / "Primary text|PRIMARY COPY: …" out of free text. Pure. */
export function parseAdCopy(text) {
  const out = { headline: null, primary_text: null };
  if (!text) return out;
  const mh = HEADLINE_RE.exec(text);
  if (mh) out.headline = mh[1].trim() || null;

  const mp = PRIMARY_START_RE.exec(text);
  if (mp) {
    let body = text.slice(mp.index + mp[0].length);
    const nl = NEXT_LABEL_RE.exec(body);
    if (nl) body = body.slice(0, nl.index);
    body = body.trim();
    if (body) out.primary_text = body;
  }
  return out;
}

/** Copy for one task: launch_holds ad_copy (authoritative buyer copy) wins over the description. */
export function extractAdCopy({ holdAdCopy, description }) {
  const fromHold = parseAdCopy(holdAdCopy);
  if (fromHold.headline || fromHold.primary_text) {
    // A hold's ad_copy may be primary-only prose with no labels — treat the whole thing as primary.
    return fromHold;
  }
  if (holdAdCopy && String(holdAdCopy).trim()) {
    return { headline: null, primary_text: String(holdAdCopy).trim() };
  }
  return parseAdCopy(description);
}

/**
 * Supabase REST query string for the holds of a set of ClickUp task ids. The ids match either
 * linkage column (drive-promotion copies tasks across lists, so both are real).
 * Caller runs it with the SERVICE key and feeds rows to holdsByTaskId().
 */
export function holdsQuery(taskIds) {
  const list = taskIds.map((id) => `"${String(id).replace(/[^A-Za-z0-9_-]/g, '')}"`).join(',');
  return `launch_holds?or=(production_task_id.in.(${list}),clickup_task_id.in.(${list}))&select=production_task_id,clickup_task_id,launch_half`;
}

/** rows -> Map(taskId -> ad_copy string) covering both linkage columns. */
export function holdsByTaskId(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const lh = typeof r.launch_half === 'string' ? JSON.parse(r.launch_half) : (r.launch_half || {});
    const copy = lh.ad_copy || null;
    if (!copy) continue;
    if (r.production_task_id) m.set(String(r.production_task_id), copy);
    if (r.clickup_task_id) m.set(String(r.clickup_task_id), copy);
  }
  return m;
}
