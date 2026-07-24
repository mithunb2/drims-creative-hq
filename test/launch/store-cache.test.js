// store-cache.test.js — proves the per-store cache does NOT refetch data already loaded (the
// step-1 gate: switch away from a store and back → no refetch). No network; a counting fetcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStoreCache } from '../../lib/store_cache.js';

const counter = () => { let n = 0; const f = async () => { n += 1; return { v: n }; }; f.count = () => n; return f; };
const tick = () => new Promise((r) => setTimeout(r, 5));

test('miss fetches once; repeat within TTL is a cache hit (NO refetch)', async () => {
  const c = createStoreCache({ ttl: 10_000 });
  const f = counter();
  const a = await c.get('soap_craft_academy', 'meta', f);
  const b = await c.get('soap_craft_academy', 'meta', f);
  assert.deepEqual(a, { v: 1 });
  assert.deepEqual(b, { v: 1 });          // same cached object, not re-fetched
  assert.equal(f.count(), 1);             // fetcher called exactly once
  assert.equal(c._fetches(), 1);
});

test('switch away to another store and BACK → no refetch of the first', async () => {
  const c = createStoreCache({ ttl: 10_000 });
  const fa = counter(), fb = counter();
  await c.get('store_a', 'tasks', fa);    // open A  (fetch A)
  await c.get('store_b', 'tasks', fb);    // switch to B (fetch B)
  await c.get('store_a', 'tasks', fa);    // back to A → cache hit
  await c.get('store_b', 'tasks', fb);    // back to B → cache hit
  assert.equal(fa.count(), 1, 'store A fetched once');
  assert.equal(fb.count(), 1, 'store B fetched once');
});

test('per-key isolation: meta and tasks for one store are separate entries', async () => {
  const c = createStoreCache({ ttl: 10_000 });
  const meta = counter(), tasks = counter();
  await c.get('s', 'meta', meta);
  await c.get('s', 'tasks', tasks);
  await c.get('s', 'meta', meta);
  assert.equal(meta.count(), 1);
  assert.equal(tasks.count(), 1);
});

test('concurrent misses share ONE in-flight fetch (no duplicate call)', async () => {
  const c = createStoreCache({ ttl: 10_000 });
  const f = counter();
  const [a, b, d] = await Promise.all([
    c.get('s', 'k', f), c.get('s', 'k', f), c.get('s', 'k', f),
  ]);
  assert.equal(f.count(), 1);
  assert.deepEqual(a, b); assert.deepEqual(b, d);
});

test('stale (age ≥ TTL) → returns cached immediately, refreshes in background (SWR)', async () => {
  const c = createStoreCache({ ttl: 0 });    // everything is immediately stale
  const f = counter();
  const first = await c.get('s', 'k', f);     // miss → fetch #1
  assert.deepEqual(first, { v: 1 });
  const second = await c.get('s', 'k', f);    // stale → returns cached {v:1} NOW, kicks bg refresh
  assert.deepEqual(second, { v: 1 }, 'returns the stale value instantly, not a spinner');
  await tick();                               // let the background revalidate land (fetch #2 → {v:2})
  const third = await c.get('s', 'k', f);     // SWR returns the now-current cached value, not a spinner
  assert.deepEqual(third, { v: 2 }, 'cache advanced in the background without a blocking fetch');
  assert.ok(f.count() >= 2, 'a background refresh happened after the stale read');
});

test('invalidate forces a refetch', async () => {
  const c = createStoreCache({ ttl: 10_000 });
  const f = counter();
  await c.get('s', 'k', f);
  c.invalidate('s', 'k');
  await c.get('s', 'k', f);
  assert.equal(f.count(), 2);
});
