// preview.test.js — /api/launch-preview: store/task match enforced, and previews returned per ad.
// Mocked network throughout (no real Meta/ClickUp/Supabase).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../api/launch-preview.js';

const CFG = { store_slug: 'fixture_store', store_name: 'Fixture Store', ad_account_id: 'act_FIX', page_id: '000PAGE', default_landing: 'https://ex/' };
function mockRes() { return { _status: 0, _json: null, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } }; }

function mockFetch(over = {}) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    const j = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o), json: async () => o });
    if (u.includes('/auth/v1/user')) return j({ id: 'u1', email: 'op@ex' });
    if (u.includes('store_meta_config')) return j([CFG]);
    if (u.includes('store_meta_secrets')) return j([{ system_user_token: 'tok', app_secret: 'sec' }]);
    if (u.includes('launch_holds')) return j([]);
    if (u.includes('generatepreviews')) return j({ data: [{ body: '<iframe src="https://meta/preview"></iframe>' }] });
    if (u.includes('api.clickup.com')) {
      const id = u.match(/task\/([^/?]+)/)[1];
      return j({ id, name: `Task ${id}`, description: 'HEADLINE: H\nPRIMARY COPY:\nBody copy.',
        folder: { id: 'fld', name: over.folderName ?? 'Fixture Store' },
        custom_fields: [{ name: 'Drive Link', value: 'https://drive.google.com/file/d/AAAAAAAAAA/view' }] });
    }
    throw new Error('unmocked ' + u.slice(0, 60));
  };
  return () => { global.fetch = orig; };
}
const REQ = (body) => ({ method: 'POST', headers: { authorization: 'Bearer jwt' }, body });
const withEnv = async (fn) => {
  const p = { S: process.env.SUPABASE_SERVICE_ROLE_KEY, C: process.env.CLICKUP_LAUNCH_TOKEN };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.CLICKUP_LAUNCH_TOKEN = 'cu';
  try { await fn(); } finally {
    p.S === undefined ? delete process.env.SUPABASE_SERVICE_ROLE_KEY : (process.env.SUPABASE_SERVICE_ROLE_KEY = p.S);
    p.C === undefined ? delete process.env.CLICKUP_LAUNCH_TOKEN : (process.env.CLICKUP_LAUNCH_TOKEN = p.C);
  }
};

test('preview: unauthenticated -> 401', async () => {
  const restore = mockFetch();
  try { await withEnv(async () => { const res = mockRes(); await handler({ method: 'POST', headers: {}, body: {} }, res); assert.equal(res._status, 401); }); }
  finally { restore(); }
});

test('preview: store/task mismatch -> 400 (same guard as launcher)', async () => {
  const restore = mockFetch({ folderName: 'Some Other Store' });
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ({ store_slug: 'fixture_store', task_ids: ['t1'], options: {} }), res);
    assert.equal(res._status, 400);
    assert.equal(res._json.status, 'store_task_mismatch');
  }); } finally { restore(); }
});

test('preview: happy path returns per-ad iframe previews across placements', async () => {
  const restore = mockFetch({ folderName: 'Fixture Store' });
  try { await withEnv(async () => {
    const res = mockRes();
    await handler(REQ({ store_slug: 'fixture_store', task_ids: ['t1', 't2'], options: { videos_per_adset: 5 } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.ads.length, 2);
    const ad = res._json.ads[0];
    assert.equal(ad.kind, 'thumbnail');                       // no video_id pre-publish -> thumbnail creative
    assert.ok(ad.previews.MOBILE_FEED_STANDARD.ok);
    assert.match(ad.previews.MOBILE_FEED_STANDARD.body, /<iframe/);
  }); } finally { restore(); }
});
