// secrets.test.js — the shared launch-credential resolver: app_secret env fallback + BM-scoped
// token inheritance + browser-safe state projection. All data below is fixture; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStoreSecret, findBmTokenDonor, tokenState } from '../../lib/launch/secrets.js';

const URL_ = 'https://sb.example', KEY = 'svc';

// Tiny in-memory Supabase: route PostgREST GETs by table + the eq./in. filters in the URL.
function installDb({ config = {}, secrets = {} }) {
  const orig = global.fetch;
  const j = (rows) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
  const eqVal = (u, col) => { const m = u.match(new RegExp(`${col}=eq\\.([^&]+)`)); return m ? decodeURIComponent(m[1]) : null; };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('store_meta_secrets')) {
      const inm = u.match(/store_slug=in\.\(([^)]*)\)/);
      if (inm) {
        const slugs = inm[1].split(',').filter(Boolean);
        let rows = slugs.map((s) => ({ store_slug: s, ...(secrets[s] || {}) }))
          .filter((r) => r.system_user_token != null);
        rows = rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        return j(rows);
      }
      const s = eqVal(u, 'store_slug');
      return j(secrets[s] ? [{ store_slug: s, ...secrets[s] }] : []);
    }
    if (u.includes('store_meta_config')) {
      const bm = eqVal(u, 'business_manager_id');
      if (bm) {
        const neq = eqVal(u, 'store_slug'); // store_slug=neq.<x> also matches eq. regex on 'neq.' -> guard below
        const excl = (u.match(/store_slug=neq\.([^&]+)/) || [])[1];
        const rows = Object.entries(config)
          .filter(([slug, c]) => c.business_manager_id === bm && slug !== decodeURIComponent(excl || ''))
          .map(([slug]) => ({ store_slug: slug }));
        void neq;
        return j(rows);
      }
      const s = eqVal(u, 'store_slug');
      return j(config[s] ? [{ store_slug: s, ...config[s] }] : []);
    }
    return { ok: false, status: 404, text: async () => 'no route' };
  };
  return () => { global.fetch = orig; };
}

test('own token + own secret → sources own/own; token & secret are the row values', async () => {
  const restore = installDb({ config: { a: { business_manager_id: 'BM1' } },
    secrets: { a: { system_user_token: 'TA', app_secret: 'SA' } } });
  try {
    const r = await resolveStoreSecret(URL_, KEY, 'a');
    assert.equal(r.token, 'TA'); assert.equal(r.secret, 'SA');
    assert.equal(r.token_source, 'own'); assert.equal(r.secret_source, 'own');
  } finally { restore(); }
});

test('no per-store secret → falls back to global META_APP_SECRET (secret_source default)', async () => {
  const restore = installDb({ config: { a: { business_manager_id: 'BM1' } },
    secrets: { a: { system_user_token: 'TA' } } });
  const prev = process.env.META_APP_SECRET; process.env.META_APP_SECRET = 'GLOBAL';
  try {
    const r = await resolveStoreSecret(URL_, KEY, 'a');
    assert.equal(r.secret, 'GLOBAL'); assert.equal(r.secret_source, 'default');
    assert.equal(r.token_source, 'own');
  } finally { process.env.META_APP_SECRET = prev; restore(); }
});

test('no own token + opted in + same-BM donor → inherits the donor token (BM-scoped)', async () => {
  const restore = installDb({
    config: { a: { business_manager_id: 'BM1' }, b: { business_manager_id: 'BM1' } },
    secrets: { a: { inherit_bm_token: true }, b: { system_user_token: 'TB', app_secret: 'SB', updated_at: '2026-07-01' } },
  });
  const prev = process.env.META_APP_SECRET; process.env.META_APP_SECRET = 'GLOBAL';
  try {
    const r = await resolveStoreSecret(URL_, KEY, 'a');
    assert.equal(r.token, 'TB'); assert.equal(r.token_source, 'inherited');
    assert.equal(r.inherited_from, 'b');
    assert.equal(r.secret, 'GLOBAL');   // secret still resolves via the global (one app)
  } finally { process.env.META_APP_SECRET = prev; restore(); }
});

test('donor exists but NOT opted in → source none, but bm_donor_slug set (checkbox offered)', async () => {
  const restore = installDb({
    config: { a: { business_manager_id: 'BM1' }, b: { business_manager_id: 'BM1' } },
    secrets: { a: {}, b: { system_user_token: 'TB' } },
  });
  try {
    const r = await resolveStoreSecret(URL_, KEY, 'a');
    assert.equal(r.token, null); assert.equal(r.token_source, 'none');
    assert.equal(r.bm_donor_slug, 'b');
  } finally { restore(); }
});

test('opted in but donor is in a DIFFERENT BM → no inheritance across BMs', async () => {
  const restore = installDb({
    config: { a: { business_manager_id: 'BM1' }, b: { business_manager_id: 'BM2' } },
    secrets: { a: { inherit_bm_token: true }, b: { system_user_token: 'TB' } },
  });
  try {
    const r = await resolveStoreSecret(URL_, KEY, 'a');
    assert.equal(r.token, null); assert.equal(r.token_source, 'none');
    assert.equal(r.bm_donor_slug, null);
  } finally { restore(); }
});

test('a store that itself inherits is NOT a donor (no chains)', async () => {
  const restore = installDb({
    config: { a: { business_manager_id: 'BM1' }, b: { business_manager_id: 'BM1' } },
    secrets: { a: { inherit_bm_token: true }, b: { inherit_bm_token: true } },   // b has no OWN token
  });
  try {
    const donor = await findBmTokenDonor(URL_, KEY, 'BM1', 'a');
    assert.equal(donor, null);
  } finally { restore(); }
});

test('freshest own token wins when the BM has multiple donors', async () => {
  const restore = installDb({
    config: { a: { business_manager_id: 'BM1' }, b: { business_manager_id: 'BM1' }, c: { business_manager_id: 'BM1' } },
    secrets: { a: { inherit_bm_token: true },
      b: { system_user_token: 'TB', updated_at: '2026-06-01' },
      c: { system_user_token: 'TC', updated_at: '2026-07-15' } },
  });
  try {
    const r = await resolveStoreSecret(URL_, KEY, 'a');
    assert.equal(r.token, 'TC'); assert.equal(r.inherited_from, 'c');
  } finally { restore(); }
});

test('tokenState NEVER exposes token or secret', async () => {
  const restore = installDb({ config: { a: { business_manager_id: 'BM1' } },
    secrets: { a: { system_user_token: 'TA', app_secret: 'SA' } } });
  try {
    const st = await tokenState(URL_, KEY, 'a');
    assert.equal(st.source, 'own');
    assert.ok(!('token' in st) && !('secret' in st));
    assert.ok(!JSON.stringify(st).includes('TA'));
    assert.ok(!JSON.stringify(st).includes('SA'));
  } finally { restore(); }
});
