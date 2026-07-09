// editor.js — resolve the doc-named editor to a ClickUp assignee. Mirrors the intent of the Python
// side's find_member_by_name / resolve_assignees, but PURE + testable: matchEditor(name, members)
// takes the workspace members list and returns a resolution. If it can't resolve unambiguously it
// returns resolved:false with candidates — the caller turns that into a PREVIEW BLOCKER. We NEVER
// guess or fall back to smart-assignment; an unresolved editor is a blocker the buyer must fix.

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const firstToken = (s) => norm(s).split(/[\s._-]+/)[0] || '';
const emailLocal = (s) => norm(s).split('@')[0] || '';

/** Flatten a ClickUp GET /team response into [{id, username, email}]. */
export function membersFromTeamResponse(json) {
  const out = [];
  for (const team of (json && json.teams) || []) {
    for (const m of team.members || []) {
      const u = m.user || m;
      if (u && u.id != null) out.push({ id: String(u.id), username: u.username || '', email: u.email || '' });
    }
  }
  // de-dup by id (a user can appear in multiple teams)
  const seen = new Set();
  return out.filter((u) => (seen.has(u.id) ? false : seen.add(u.id)));
}

/** Resolve `name` (as written in the doc) to exactly one member, or report why not.
 *  @returns {{resolved:boolean, assignee_id:string|null, matched:object|null, candidates:object[], reason:string}} */
export function matchEditor(name, members) {
  const n = norm(name);
  if (!n) return { resolved: false, assignee_id: null, matched: null, candidates: [], reason: 'no editor name given' };
  const list = members || [];

  // 1. exact match on full username or email local-part
  let hits = list.filter((m) => norm(m.username) === n || emailLocal(m.email) === n);
  // 2. else first-name match (doc says "Priya", username "Priya Sharma")
  if (hits.length === 0) hits = list.filter((m) => firstToken(m.username) === n || firstToken(m.email) === n);

  if (hits.length === 1) {
    return { resolved: true, assignee_id: hits[0].id, matched: hits[0], candidates: [], reason: 'resolved' };
  }
  if (hits.length > 1) {
    return { resolved: false, assignee_id: null, matched: null, candidates: hits,
      reason: `editor "${name}" is ambiguous — ${hits.length} members match (${hits.map((h) => h.username).join(', ')})` };
  }
  return { resolved: false, assignee_id: null, matched: null, candidates: [],
    reason: `editor "${name}" not found among workspace members` };
}
