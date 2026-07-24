/**
 * store_cache.js — per-store, per-key session cache with stale-while-revalidate.
 *
 * The load-bearing scaffolding for the store-first IA: every per-store section (Store View, Production
 * Tasks, Live Ads, …) reads its data through this, so switching a store's sub-tabs — or leaving a
 * store and coming back — NEVER re-fetches data already loaded within the freshness window.
 *
 * Semantics (all proven in store-cache.test.js):
 *   • miss            → call the fetcher once, cache {data, at}, return it.
 *   • hit + fresh      (age < ttl) → return cached, NO fetch.
 *   • hit + stale      (age ≥ ttl) → return cached IMMEDIATELY, refresh in the background (SWR).
 *   • concurrent miss  → a single in-flight fetch is shared (no duplicate calls).
 *   • keys are (slug, key) so 'meta' / 'tasks' / 'ads' for one store are cached independently, and
 *     different stores never collide.
 *
 * `_fetches()` counts real fetcher invocations — the instrumentation the test and the in-app debug
 * badge use to assert "no refetch on switch-back".
 */
export function createStoreCache({ ttl = 5 * 60 * 1000 } = {}) {
  const store = new Map();   // `${slug}::${key}` -> { data, at, inflight }
  let fetches = 0;

  function _load(k, fetcher) {
    const p = (async () => {
      fetches += 1;
      const data = await fetcher();
      store.set(k, { data, at: Date.now(), inflight: null });
      return data;
    })();
    const prev = store.get(k) || {};
    store.set(k, { data: prev.data, at: prev.at || 0, inflight: p });
    return p;
  }

  function _revalidate(k, fetcher) {
    const e = store.get(k);
    if (e && e.inflight) return;                 // a refresh is already running
    _load(k, fetcher).catch(() => {});           // background — failure keeps the stale value
  }

  async function get(slug, key, fetcher) {
    const k = `${slug}::${key}`;
    const now = Date.now();
    const e = store.get(k);
    if (e) {
      if (e.data !== undefined && (now - e.at) < ttl) return e.data;   // fresh → no fetch
      if (e.inflight) return e.inflight;                               // in-flight → share it
      if (e.data !== undefined) { _revalidate(k, fetcher); return e.data; }  // stale → SWR
    }
    return _load(k, fetcher);
  }

  return {
    get,
    has: (slug, key) => { const e = store.get(`${slug}::${key}`); return !!(e && e.data !== undefined); },
    invalidate: (slug, key) => store.delete(`${slug}::${key}`),
    clear: () => store.clear(),
    _fetches: () => fetches,
  };
}
