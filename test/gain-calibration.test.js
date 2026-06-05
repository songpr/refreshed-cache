// gain() recommendation CALIBRATION — behavioral, not branch-poking.
//
// Unlike test/recommend.test.js (which exercises the _recommend branch logic and,
// for refresh-waste, sets internal counters directly), this suite drives a real
// DataCache into each anti-pattern state using ONLY the public API (init / get /
// getOrFetch / asyncRefresh), then asserts gain().code. It is the "tested result"
// that calibrates the thresholds against real workloads before publishing 1.9.0:
// if a threshold were mis-set, the matching scenario below would emit the wrong code.
//
// Mapping to the documented anti-patterns (README → "Anti-Patterns", benchmark §0):
//   thrash          ↔ §C: working set > max  (constant eviction, low hit rate)
//   refresh-waste   ↔ §B Strategy A: cache full of keys demand isn't reading
//   healthy         ↔ §B Strategy C: full cache, high reuse  (the fall-through path)
//   over-provisioned / low-value: sizing edge cases

const DataCache = require('../index');

let activeCaches = [];
afterEach(async () => {
    for (const cache of activeCaches) {
        try { await cache.close(); } catch (e) {}
    }
    activeCaches = [];
});

function newCache(fetch, options) {
    const cache = new DataCache(fetch, options);
    activeCaches.push(cache);
    return cache;
}

// A loader that yields `n` synthetic [key,value] pairs (k0..k{n-1}).
const seedLoader = (n) => () => Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]);

describe('gain() calibration — real workloads emit the correct code', () => {
    it('disabled: max <= 0', () => {
        const cache = newCache(() => [], { max: 0 });
        expect(cache.gain().code).toBe('disabled');
    });

    it('healthy/gathering: fewer than 100 requests', async () => {
        const cache = newCache(seedLoader(10), { max: 100 });
        await cache.init();
        for (let i = 0; i < 20; i++) cache.get('k0'); // 20 requests < 100
        const g = cache.gain();
        expect(g.code).toBe('healthy');
        expect(g.recommendation).toMatch(/Gathering data/);
    });

    it('thrash: working set (1000 keys) far exceeds max (100) → low hit rate + high eviction', async () => {
        const cache = newCache(() => [], {
            max: 100,
            // Every key is valid → each miss populates and (once full) evicts.
            fetchByKey: async (k) => `v${k}`,
        });
        await cache.init();

        // 1500 sequential accesses over a 1000-key space the cache can't hold.
        for (let i = 0; i < 1500; i++) {
            await cache.getOrFetch(`k${i % 1000}`);
        }

        const g = cache.gain();
        expect(g.utilization).toBeGreaterThan(0.8);   // cache is full
        expect(g.code).toBe('thrash');
    });

    it('refresh-waste: full cache, but demand reads keys it does not hold (low reuse, no eviction)', async () => {
        // Cache is filled to capacity by the loader; reads then mostly target keys
        // that aren't cached — the "refreshing/holding keys nobody reads" pattern.
        const cache = newCache(seedLoader(100), { max: 100 });
        await cache.init();

        for (let i = 0; i < 5; i++) cache.get('k0');             // 5 hits on the held set
        for (let i = 0; i < 100; i++) cache.get(`absent-${i}`);  // 100 misses, no population

        const g = cache.gain();
        expect(g.utilization).toBeGreaterThan(0.8);
        expect(g.code).toBe('refresh-waste');
    });

    it('healthy: full cache with high reuse (the fall-through path)', async () => {
        const cache = newCache(() => [], {
            max: 100,
            fetchByKey: async (k) => `v${k}`,
        });
        await cache.init();

        // 100 distinct keys (fits exactly), each read 3× → high reuse, no eviction.
        for (let i = 0; i < 300; i++) {
            await cache.getOrFetch(`k${i % 100}`);
        }

        const g = cache.gain();
        expect(g.utilization).toBeGreaterThan(0.8);
        expect(g.code).toBe('healthy');
        expect(g.recommendation).toMatch(/High efficiency/);
    });

    it('over-provisioned: high hit rate but tiny utilization', async () => {
        const cache = newCache(seedLoader(1), { max: 1000 });
        await cache.init();
        for (let i = 0; i < 150; i++) cache.get('k0'); // all hits, util ~0.001
        const g = cache.gain();
        expect(g.utilization).toBeLessThan(0.8);
        expect(g.code).toBe('over-provisioned');
    });

    it('low-value: low hit rate and low utilization', async () => {
        const cache = newCache(seedLoader(10), { max: 1000 });
        await cache.init();
        for (let i = 0; i < 5; i++) cache.get('k0');            // few hits
        for (let i = 0; i < 150; i++) cache.get(`absent-${i}`); // mostly misses
        const g = cache.gain();
        expect(g.utilization).toBeLessThan(0.8);
        expect(g.code).toBe('low-value');
    });

    it('healthy survives a refresh-window roll (uses last-window counters)', async () => {
        // Build a healthy state, then roll the window via asyncRefresh so gain()
        // reads _lastWindow* instead of the live window — both paths must agree.
        const cache = newCache(seedLoader(100), {
            max: 100,
            resetOnRefresh: false,
            fetchByKey: async (k) => `v${k}`,
        });
        await cache.init();
        for (let i = 0; i < 300; i++) await cache.getOrFetch(`k${i % 100}`);
        await cache.asyncRefresh(); // rolls window: _lastWindow* now holds the activity
        const g = cache.gain();
        expect(g.code).toBe('healthy');
    });
});
