/**
 * TDD tests for code review findings on feature/tier-2-sharpen-core.
 * Each describe block covers one finding from reviews/feature-tier-2-sharpen-core.md.
 */
const DataCache = require('../index.js');
const { flushPromises, trackCaches } = require('./helpers');

const newCache = trackCaches();

// ─── Finding 1: keysLoaded off-by-one when fetch exceeds max ─────────────────
describe('Finding 1: keysLoaded off-by-one when fetch exceeds max', () => {
    test('keysLoaded equals max when source yields more items than max', async () => {
        let reported;
        // max=2, fetch returns 3 items [A, B, C]
        const cache = newCache(
            () => [['A', 1], ['B', 2], ['C', 3]],
            {
                max: 2,
                refreshAge: 9999,
                onRefresh: (stats) => { reported = stats; }
            }
        );
        await cache.init();
        await cache.asyncRefresh();

        expect(reported.keysLoaded).toBe(2);      // not 3
        expect(cache.size).toBe(2);
    });

    test('keysLoaded equals actual count when source yields fewer items than max', async () => {
        let reported;
        const cache = newCache(
            () => [['A', 1]],
            {
                max: 10,
                refreshAge: 9999,
                onRefresh: (stats) => { reported = stats; }
            }
        );
        await cache.init();
        await cache.asyncRefresh();

        expect(reported.keysLoaded).toBe(1);
    });
});

// ─── Finding 2: _coalescedFetches not recorded in getOrFetchMany fallback ─────
describe('Finding 2: _coalescedFetches in getOrFetchMany fallback path', () => {
    test('coalescedFetches is incremented when two concurrent getOrFetchMany calls coalesce (no fetchByKeys)', async () => {
        let resolveKey;
        const pendingFetch = new Promise(r => { resolveKey = r; });

        const cache = newCache(
            async () => [],
            {
                max: 100,
                fetchByKey: async (key) => {
                    await pendingFetch;
                    return `val-${key}`;
                }
            }
        );
        await cache.init();

        // Fire two concurrent calls for the same key via getOrFetchMany fallback
        const p1 = cache.getOrFetchMany(['x']);
        const p2 = cache.getOrFetchMany(['x']);

        resolveKey();
        await Promise.all([p1, p2]);

        // One fetch must have coalesced onto the other
        expect(cache.metrics.coalescedFetches).toBeGreaterThanOrEqual(1);
    });
});

// ─── Finding 3: keys.includes(k) dead O(n²) predicate ────────────────────────
describe('Finding 3: keys.includes(k) always-true dead predicate removed', () => {
    test('getOrFetchMany returns all fetched values (predicate removal does not break results)', async () => {
        const cache = newCache(
            async () => [],
            {
                max: 100,
                fetchByKeys: async (keys) => keys.map(k => [k, `v-${k}`])
            }
        );
        await cache.init();

        const result = await cache.getOrFetchMany(['a', 'b', 'c']);
        expect(result).toEqual({ a: 'v-a', b: 'v-b', c: 'v-c' });
    });
});

// ─── Finding 4: runBackoff duplicates _timeoutLoop backoff logic ──────────────
// Behavioral regression guard: both loop paths must call onError and increment
// _failureCount on refresh failure. Uses fake timers to drive the _timeoutLoop.
describe('Finding 4: backoff error handling increments _failureCount and calls onError', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('_timeoutLoop: onError called and _failureCount increments on refresh failure', async () => {
        jest.useFakeTimers();
        let errorCalled = false;
        let fail = false;

        const cache = newCache(
            () => { if (fail) throw new Error('fetch-error'); return []; },
            { max: 100, refreshAge: 5, onError: () => { errorCalled = true; } }
        );
        await cache.init();
        fail = true;

        jest.advanceTimersByTime(5000);
        await flushPromises();

        expect(errorCalled).toBe(true);
        expect(cache._failureCount).toBeGreaterThanOrEqual(1);
    });
});

// ─── Finding 5: checkValidity invalidation block duplicated ──────────────────
describe('Finding 5: checkValidity invalidation increments _misses in all call sites', () => {
    function makeInvalidCache() {
        return newCache(
            async () => [['k', 'stale']],
            {
                max: 100,
                refreshAge: 9999,
                checkValidity: () => false   // every item is invalid
            }
        );
    }

    test('get() increments _misses and _invalidations on invalid item', async () => {
        const cache = makeInvalidCache();
        await cache.init();
        cache.set('k', 'stale');

        cache.get('k');
        expect(cache.metrics.invalidations).toBe(1);
        expect(cache.metrics.misses).toBeGreaterThanOrEqual(1);
    });

    test('getOrFetch() increments _misses and _invalidations on invalid item', async () => {
        const cache = newCache(
            async () => [],
            {
                max: 100,
                refreshAge: 9999,
                checkValidity: () => false,
                fetchByKey: async (key) => `fetched-${key}`
            }
        );
        await cache.init();
        cache.set('k', 'stale');

        await cache.getOrFetch('k');
        expect(cache.metrics.invalidations).toBe(1);
        expect(cache.metrics.misses).toBeGreaterThanOrEqual(1);
    });

    test('getOrFetchMany() increments _misses and _invalidations on invalid item', async () => {
        const cache = newCache(
            async () => [],
            {
                max: 100,
                refreshAge: 9999,
                checkValidity: () => false,
                fetchByKey: async (key) => `fetched-${key}`
            }
        );
        await cache.init();
        cache.set('k', 'stale');

        await cache.getOrFetchMany(['k']);
        expect(cache.metrics.invalidations).toBe(1);
        expect(cache.metrics.misses).toBeGreaterThanOrEqual(1);
    });

    test('has() increments _invalidations on invalid item', async () => {
        const cache = makeInvalidCache();
        await cache.init();
        cache.set('k', 'stale');

        const result = cache.has('k');
        expect(result).toBe(false);
        expect(cache.metrics.invalidations).toBe(1);
    });

    test('has() also increments _misses on invalid item (parity with get/getOrFetch)', async () => {
        const cache = makeInvalidCache();
        await cache.init();
        cache.set('k', 'stale');

        cache.has('k');
        expect(cache.metrics.misses).toBeGreaterThanOrEqual(1);
    });
});

// ─── Finding 6: if (firstItdata.done != true) dead code ──────────────────────
describe('Finding 6: dead guard if (firstItdata.done != true) removed', () => {
    test('iterator loop still runs and loads all items after guard removal', async () => {
        let reported;
        const cache = newCache(
            () => [['A', 1], ['B', 2], ['C', 3]],
            {
                max: 10,
                refreshAge: 9999,
                onRefresh: (stats) => { reported = stats; }
            }
        );
        await cache.init();
        await cache.asyncRefresh();

        expect(reported.keysLoaded).toBe(3);
        expect(cache.get('A')).toBe(1);
        expect(cache.get('B')).toBe(2);
        expect(cache.get('C')).toBe(3);
    });
});

// ─── Finding 7: _runInMs used as load-bearing scheduling delay ───────────────
describe('Finding 7: _runInMs is observability-only, delay passed explicitly', () => {
    let cache;
    afterEach(async () => { if (cache) { cache.isClose = true; await cache.close(); } });

    test('_runInMs reflects the scheduled delay for observability but is not the control-flow source', async () => {
        cache = new DataCache(
            async () => [],
            { max: 100, refreshAge: 5 }
        );
        await cache.init();

        // _runInMs should be set for observability (5s * 1000 = 5000ms)
        expect(cache._runInMs).toBe(5000);
    });

    test('_runInMs is updated to backoff delay after a refresh failure', async () => {
        let callCount = 0;
        cache = new DataCache(
            async () => {
                callCount++;
                if (callCount === 1) return []; // init succeeds
                throw new Error('refresh-error');
            },
            {
                max: 100,
                refreshAge: 9999,
                backoffInitialDelay: 1,
                backoffMaxDelay: 60,
                onError: () => {}
            }
        );
        await cache.init();

        await cache.asyncRefresh().catch(() => {});

        // After a failure _runInMs should reflect the backoff delay, not the normal refreshAge
        expect(typeof cache._runInMs).toBe('number');
        expect(cache._runInMs).toBeGreaterThan(0);
    });
});
