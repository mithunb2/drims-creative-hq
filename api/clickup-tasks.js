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

const TOKEN = process.env.CLICKUP_LAUNCH_TOKEN || '';
const API = 'https://api.clickup.com/api/v2';

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

  // Parallel across lists — a folder with one oversized list no longer stalls the whole load.
  const perList = await Promise.all(lists.map(async (l) => {
    try {
      const d = await cu(`/list/${l.id}/task?include_closed=true&subtasks=false`);
      return (d.tasks || [])
        .filter((t) => mode === 'list'
          || PROD_STATUSES.includes(((t.status && t.status.status) || '').toLowerCase()))
        .map((t) => slim(t, l.name));
    } catch { return []; }
  }));

  const seen = new Map();
  for (const group of perList) for (const t of group) seen.set(t.id, t);
  return {
    tasks: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    lists_scanned: lists.length,
    folder: folder.name,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

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
