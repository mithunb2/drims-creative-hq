// Vercel Serverless Function — READ-ONLY ClickUp discovery + production-task feed.
//
//   GET /api/clickup-tasks?action=stores
//       -> { stores: [{ id, name, space, lists: [{id,name}] }] }
//       Walks team -> space -> folder LIVE. Every folder ClickUp returns becomes a store.
//       A folder added tomorrow appears automatically; nothing is enumerated in code.
//
//   GET /api/clickup-tasks?action=tasks&folder=<folder_id>[&mode=list]
//       -> { tasks: [...], lists_scanned, mode }
//       mode=status (default): every list in the folder, filtered to production STATUSES.
//       mode=list            : only lists whose name contains "production", unfiltered.
//
// Auth: CLICKUP_LAUNCH_TOKEN (server env, the same token /api/launch-split and /api/launch-drive
// use). Never returned, never logged, never sent to the browser. No writes — GET only, and the
// only host contacted is api.clickup.com.
//
// HARDCODING: none. No store name, folder id, list id or workspace id appears here. The only
// literals are ClickUp's own status vocabulary (below), which is workspace configuration, not a
// store identity — override it with CLICKUP_PROD_STATUSES if the team renames its statuses.

import { extractAdCopy, holdsQuery, holdsByTaskId, parseDocLink, fetchDocText } from '../lib/launch/ad_copy.js';

const TOKEN = process.env.CLICKUP_LAUNCH_TOKEN || '';
const API = 'https://api.clickup.com/api/v2';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── AUTH GATE ───────────────────────────────────────────────────────────────
// This endpoint reads the WHOLE ClickUp workspace with a privileged server token, so it must
// never answer an unauthenticated caller. The app's sign-in screen gates the UI only — a
// serverless function is reachable directly, so the check has to live HERE.
//
// The caller must present the Supabase session JWT the browser already holds
// (app.html `_accessToken()`). We verify it against Supabase's own /auth/v1/user endpoint:
// a forged or expired token fails there, so validity is Supabase's decision, not ours.
// Same fallback pattern as api/launch-edit.js. The anon key is public by design (it is served
// to every browser in config.js) — it identifies the project, it does not grant access. The JWT
// presented by the caller is what actually decides.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zeaztlcopkvlfziwrmto.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYXp0bGNvcGt2bGZ6aXdybXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzk1MzEsImV4cCI6MjA5MjYxNTUzMX0.T9fXxkmHOAH6g6IG4-krLXxuj7tqzOn54WDeHsqFh3Y';

async function requireUser(req) {
  const hdr = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!jwt) return { ok: false, code: 401, reason: 'Sign in to view ClickUp data.' };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Fail CLOSED: without a way to verify, we refuse rather than serve the workspace.
    return { ok: false, code: 500, reason: 'Auth is not configured on the server (SUPABASE_URL / SUPABASE_ANON_KEY missing).' };
  }
  try {
    const r = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!r.ok) return { ok: false, code: 401, reason: 'Session expired or invalid — sign in again.' };
    const u = await r.json();
    if (!u || !u.id) return { ok: false, code: 401, reason: 'Session expired or invalid — sign in again.' };
    return { ok: true, user: u.email || u.id };
  } catch {
    return { ok: false, code: 401, reason: 'Could not verify your session.' };
  }
}

const PROD_STATUSES = (process.env.CLICKUP_PROD_STATUSES || 'ready for testing,testing,scale')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Warm-lambda cache. Discovery is stable minute-to-minute; tasks are short-lived.
const CACHE = { stores: null, storesAt: 0 };
const STORES_TTL_MS = 5 * 60 * 1000;

async function cu(path) {
  const r = await fetch(API + path, {
    headers: { Authorization: TOKEN, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`ClickUp ${r.status} on ${path.split('?')[0]}`);
  return r.json();
}

/** team -> space -> folder. Nothing enumerated in code. */
async function discoverStores() {
  if (CACHE.stores && Date.now() - CACHE.storesAt < STORES_TTL_MS) return CACHE.stores;

  const { teams = [] } = await cu('/team');
  const out = [];

  for (const t of teams) {
    const { spaces = [] } = await cu(`/team/${t.id}/space`);
    const perSpace = await Promise.all(spaces.map(async (s) => {
      try {
        const { folders = [] } = await cu(`/space/${s.id}/folder`);
        return folders.map((f) => ({
          id: f.id,
          name: f.name,
          space: s.name,
          lists: (f.lists || []).map((l) => ({ id: l.id, name: l.name })),
        }));
      } catch { return []; }
    }));
    for (const group of perSpace) for (const f of group) if (f.lists.length) out.push(f);
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  CACHE.stores = out; CACHE.storesAt = Date.now();
  return out;
}

/** Resolve a ClickUp custom field to a display string (dropdowns store an index). */
function field(task, name) {
  const cf = (task.custom_fields || []).find(
    (c) => (c.name || '').trim().toLowerCase() === name.toLowerCase());
  if (!cf) return null;
  const v = cf.value;
  if (v === null || v === undefined || v === '') return null;

  if (cf.type === 'drop_down') {
    const opts = (cf.type_config && cf.type_config.options) || [];
    const o = opts.find((x) => x.orderindex === v) || opts[v];
    return o ? (o.name || o.label || null) : null;
  }
  if (cf.type === 'labels' && Array.isArray(v)) {
    const opts = (cf.type_config && cf.type_config.options) || [];
    return v.map((id) => {
      const o = opts.find((x) => x.id === id);
      return o ? (o.label || o.name) : id;
    }).join(', ');
  }
  return String(v);
}

const CHIP_FIELDS = ['Format', 'Hook Type', 'Creative Tone', 'Funnel Stage', 'Platform', 'Video Style'];
const isProdList = (n) => /production/i.test(n || '');

function slim(task, listName) {
  const chips = {};
  for (const f of CHIP_FIELDS) { const v = field(task, f); if (v) chips[f] = v; }
  return {
    id: task.id,
    custom_id: task.custom_id || null,
    name: task.name || '',
    status: (task.status && task.status.status) || '',
    url: task.url || '',
    list: listName,
    due_date: task.due_date ? Number(task.due_date) : null,   // ms epoch (ClickUp sends a string)
    assignees: (task.assignees || []).map((a) => a.username || a.email || '').filter(Boolean),
    description: task.description || '',
    angle: field(task, 'Angle'),
    persona: field(task, 'Persona'),
    drive_link: field(task, 'Drive Link'),
    chips,
  };
}

async function loadTasks(folderId, mode) {
  const stores = await discoverStores();
  const folder = stores.find((s) => s.id === String(folderId));
  if (!folder) throw new Error('folder not found (or not visible to the server token)');

  const lists = mode === 'list' ? folder.lists.filter((l) => isProdList(l.name)) : folder.lists;

  // Let ClickUp do the status filtering — it halves the payload and the time versus pulling
  // every task (incl. closed) and filtering here. Measured on one real list: 88 tasks / 1437KB
  // -> 39 tasks / 650KB. Only applies to status mode; list mode wants everything in the list.
  const statusQS = mode === 'list' ? ''
    : PROD_STATUSES.map((s) => `&statuses%5B%5D=${encodeURIComponent(s)}`).join('');
  const closedQS = mode === 'list' ? '&include_closed=true' : '';

  // Parallel across lists — one oversized list no longer stalls the whole load.
  const errors = [];
  const perList = await Promise.all(lists.map(async (l) => {
    try {
      const d = await cu(`/list/${l.id}/task?subtasks=false${closedQS}${statusQS}`);
      return (d.tasks || []).map((t) => slim(t, l.name));
    } catch (e) {
      // Do NOT swallow: a ClickUp blip must not masquerade as "this store has no tasks".
      errors.push(`${l.name}: ${(e && e.message) || e}`);
      return [];
    }
  }));

  const seen = new Map();
  for (const group of perList) for (const t of group) seen.set(t.id, t);

  // Ad copy per task: launch_holds (doc-pipeline, authoritative buyer copy) -> description
  // sections -> null (the UI flags null; the submit endpoint independently refuses it).
  let holds = new Map();
  if (SERVICE && seen.size) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${holdsQuery([...seen.keys()])}`,
        { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      if (r.ok) holds = holdsByTaskId(await r.json());
    } catch { /* holds unreachable -> description-only extraction still works */ }
  }
  await Promise.all([...seen.values()].map(async (t) => {
    let copy = extractAdCopy({ holdAdCopy: holds.get(t.id) || null, description: t.description });
    // Doc tier (lazy): only when primary text is still missing AND the description links a doc.
    if (!copy.primary_text) {
      const link = parseDocLink(t.description);
      if (link) {
        const docText = await fetchDocText(link, TOKEN);
        if (docText) copy = extractAdCopy({ holdAdCopy: holds.get(t.id) || null, description: t.description, docText });
      }
    }
    t.headline = copy.headline; t.primary_text = copy.primary_text;
  }));

  return {
    tasks: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    lists_scanned: lists.length,
    folder: folder.name,
    partial: errors.length > 0,
    errors,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Gate FIRST — before touching the ClickUp token or answering anything about the workspace.
  const auth = await requireUser(req);
  if (!auth.ok) {
    return res.status(auth.code).json({ ok: false, reason: auth.reason, stores: [], tasks: [] });
  }

  if (!TOKEN) {
    return res.status(200).json({
      ok: false,
      reason: 'CLICKUP_LAUNCH_TOKEN is not set in the Vercel env — the server can’t read ClickUp yet.',
      stores: [], tasks: [],
    });
  }

  try {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || 'stores';

    if (action === 'stores') {
      const stores = await discoverStores();
      return res.status(200).json({
        ok: true,
        stores: stores.map(({ id, name, space, lists }) => ({ id, name, space, lists })),
        discovered_at: new Date().toISOString(),
      });
    }

    if (action === 'tasks') {
      const folder = url.searchParams.get('folder');
      if (!folder) return res.status(400).json({ ok: false, reason: 'missing ?folder=' });
      const mode = url.searchParams.get('mode') === 'list' ? 'list' : 'status';
      const out = await loadTasks(folder, mode);
      return res.status(200).json({ ok: true, mode, prod_statuses: PROD_STATUSES, ...out });
    }

    return res.status(400).json({ ok: false, reason: `unknown action ${action}` });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: String((e && e.message) || e), stores: [], tasks: [] });
  }
}
