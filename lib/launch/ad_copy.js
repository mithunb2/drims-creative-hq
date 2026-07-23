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

/** Parse a hold's ad_copy into a candidate: labeled fields if present, else the whole thing = primary. */
function holdCandidate(holdAdCopy) {
  const h = parseAdCopy(holdAdCopy);
  if (h.headline || h.primary_text) return h;
  if (holdAdCopy && String(holdAdCopy).trim()) return { headline: null, primary_text: String(holdAdCopy).trim() };
  return { headline: null, primary_text: null };
}

/**
 * Copy for one task, merged PER FIELD across sources in priority order:
 *   launch_holds (verbatim buyer copy) > task description > linked ClickUp doc.
 * Per-field so a task can carry its headline in the description and its primary text in the doc —
 * the real case that motivated the doc tier (headlines came through, primary text was empty).
 * docText is optional and fetched lazily by the caller (only when primary is still missing), so a
 * store that keeps full copy on the task never triggers a doc read.
 */
export function extractAdCopy({ holdAdCopy, description, docText }) {
  const cands = [holdCandidate(holdAdCopy), parseAdCopy(description)];
  if (docText) cands.push(parseAdCopy(docText));
  const pick = (f) => { for (const c of cands) if (c[f] && String(c[f]).trim()) return String(c[f]).trim(); return null; };
  return { headline: pick('headline'), primary_text: pick('primary_text') };
}

/** Detect a ClickUp doc link in free text → {workspaceId, docId} | null. Pure. Matches the
 *  app.clickup.com/<ws>/v/dc/<docId>[/<pageId>] share URL that briefs embed in the description. */
export function parseDocLink(text) {
  if (!text) return null;
  const m = String(text).match(/clickup\.com\/(\d+)\/v\/dc\/([A-Za-z0-9-]+)/);
  return m ? { workspaceId: m[1], docId: m[2] } : null;
}

/** Fetch a ClickUp doc's text (all page names + content, markdown) via the Docs v3 API. Best-effort:
 *  returns '' on any failure so extraction degrades to hold+description. Caller supplies the token. */
export async function fetchDocText(link, token) {
  if (!link || !link.workspaceId || !link.docId) return '';
  try {
    const u = `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(link.workspaceId)}`
      + `/docs/${encodeURIComponent(link.docId)}/pages?content_format=text%2Fmd`;
    const r = await fetch(u, { headers: { Authorization: token, Accept: 'application/json' } });
    if (!r.ok) return '';
    const body = await r.json();
    const pages = Array.isArray(body) ? body : (body.pages || []);
    return pages.map((p) => `${p.name || ''}\n${p.content || ''}`).join('\n\n');
  } catch { return ''; }
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
