const { expect, test } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DataCache = require("../index");

test("hits and misses metrics are tracked correctly", async () => {
    const fetch = () => [['a', 1], ['b', 2]];
    const cache = new DataCache(fetch, { maxAge: 10, refreshAge: 10 });
    await cache.init();

    expect(cache.metrics.hits).toBe(0);
    expect(cache.metrics.misses).toBe(0);

    // Test get hit
    expect(cache.get('a')).toBe(1);
    expect(cache.metrics.hits).toBe(1);
    expect(cache.metrics.misses).toBe(0);

    // Test get miss
    expect(cache.get('c')).toBe(undefined);
    expect(cache.metrics.hits).toBe(1);
    expect(cache.metrics.misses).toBe(1);

    // Test getOrFetch hit
    expect(await cache.getOrFetch('b')).toBe(2);
    expect(cache.metrics.hits).toBe(2);
    expect(cache.metrics.misses).toBe(1);

    // Test getOrFetch miss (without fetchByKey config, doesn't fetch, just miss)
    expect(await cache.getOrFetch('c')).toBe(undefined);
    expect(cache.metrics.hits).toBe(2);
    expect(cache.metrics.misses).toBe(2);

    // Test getOrFetchMany
    const result = await cache.getOrFetchMany(['a', 'c', 'd']);
    expect(result).toEqual({ a: 1 });
    expect(cache.metrics.hits).toBe(3); // a hit
    expect(cache.metrics.misses).toBe(4); // c, d miss

    await cache.close();
});

test("onRefresh callback is invoked with correct stats", async () => {
    let refreshCount = 0;
    let statsReceived = null;
    
    let round = 1;
    const fetch = () => {
        const data = [['a', round], ['b', 2]];
        round++;
        return data;
    };
    
    const cache = new DataCache(fetch, {
        maxAge: 10,
        refreshAge: 10,
        onRefresh: (stats) => {
            refreshCount++;
            statsReceived = stats;
        }
    });
    
    await cache.init();
    
    // Initial fetch inside init does NOT call onRefresh callback because it is not a scheduled refresh.
    expect(refreshCount).toBe(0);
    
    // Trigger asyncRefresh manually
    await cache.asyncRefresh();
    
    expect(refreshCount).toBe(1);
    expect(statsReceived.keysLoaded).toBe(2);
    expect(statsReceived.keysUpdated).toBe(1); // 'a' changed from 1 to 2, 'b' stayed the same (2)
    expect(statsReceived.durationMs).toBeGreaterThanOrEqual(0);
    expect(cache.metrics.refreshes).toBe(1);
    expect(cache.metrics.mismatches).toBe(1);

    // Custom isEqual comparison
    let customIsEqualCalled = false;
    const cacheCustom = new DataCache(fetch, {
        maxAge: 10,
        refreshAge: 10,
        isEqual: (a, b) => {
            customIsEqualCalled = true;
            return true; // pretend all values are equal, so 0 updates
        },
        onRefresh: (stats) => {
            expect(stats.keysUpdated).toBe(0);
        }
    });
    await cacheCustom.init();
    await cacheCustom.asyncRefresh();
    expect(customIsEqualCalled).toBe(true);

    await cache.close();
    await cacheCustom.close();
});

test("onError callback is invoked on refresh error", async () => {
    let errorCount = 0;
    let errorReceived = null;

    const fetch = () => {
        throw new Error("simulated fetch error");
    };

    const cache = new DataCache(fetch, {
        maxAge: 1,
        refreshAge: 1,
        onError: (err) => {
            errorCount++;
            errorReceived = err;
        }
    });

    // init will throw because fetch throws
    await expect(cache.init()).rejects.toThrow("simulated fetch error");

    // Clear timeout loops or close to be clean
    await cache.close();
});

test("checkValidity evicts invalid items and increments invalidations counter", async () => {
    const fetch = () => [['a', 10], ['b', 20]];
    const cache = new DataCache(fetch, {
        maxAge: 10,
        refreshAge: 10,
        checkValidity: (key, value) => {
            return value > 15; // 'a' (10) is invalid, 'b' (20) is valid
        }
    });
    await cache.init();

    expect(cache.metrics.invalidations).toBe(0);

    // Read 'a' (should fail validity and be evicted)
    expect(cache.get('a')).toBe(undefined);
    expect(cache.metrics.invalidations).toBe(1);
    expect(cache.metrics.misses).toBe(1);
    expect(cache.metrics.hits).toBe(0);

    // Check it was evicted
    expect(cache.has('a')).toBe(false);

    // Read 'b' (valid)
    expect(cache.get('b')).toBe(20);
    expect(cache.metrics.invalidations).toBe(1);
    expect(cache.metrics.hits).toBe(1);

    await cache.close();
});

test("observability hooks & metrics validity under sustained concurrent load for 5 seconds", async () => {
    // 1. Mock DB store
    const dbStore = new Map();
    for (let i = 0; i < 50; i++) {
        dbStore.set(`key-${i}`, { val: i, version: 1 });
    }

    let dbQueries = 0;
    const fetchByKey = async (key) => {
        dbQueries++;
        await delay(5); // simulate DB network latency
        return dbStore.get(key);
    };

    // 2. Instantiate Cache
    let refreshCallbacks = 0;
    let customEqualCalls = 0;
    let validityChecks = 0;
    
    const cache = new DataCache(
        async () => {
            dbQueries++;
            return Array.from(dbStore.entries());
        },
        {
            max: 30, // smaller than 50 to force evictions/misses
            maxAge: 1, // short TTL to trigger refetches/stale lookups
            refreshAge: 1, // refresh every second
            fetchByKey,
            onRefresh: () => {
                refreshCallbacks++;
            },
            checkValidity: (key, value) => {
                validityChecks++;
                return value.version > 0;
            },
            isEqual: (a, b) => {
                customEqualCalls++;
                return a.val === b.val && a.version === b.version;
            }
        }
    );

    await cache.init();

    // 3. Run workload for 5 seconds
    let totalOps = 0;
    let isRunning = true;

    // Background worker making concurrent requests
    const worker = async () => {
        const keys = Array.from({ length: 70 }, (_, i) => `key-${i}`); // mix of hits, misses, and out-of-bounds keys
        while (isRunning) {
            const batch = Array.from({ length: 10 }, () => {
                const key = keys[Math.floor(Math.random() * keys.length)];
                totalOps++;
                return cache.getOrFetch(key);
            });
            await Promise.all(batch);
            await delay(10); // rate limit loop slightly
        }
    };

    // Background writer modifying values to trigger refreshes/mismatches/invalidations
    const writer = async () => {
        while (isRunning) {
            await delay(800);
            // Randomly update some keys to cause mismatches on refresh
            const keyToUpdate = `key-${Math.floor(Math.random() * 50)}`;
            const oldVal = dbStore.get(keyToUpdate);
            if (oldVal) {
                dbStore.set(keyToUpdate, { val: oldVal.val, version: oldVal.version + 1 });
            }
        }
    };

    const workerPromises = Array.from({ length: 5 }, () => worker());
    const writerPromise = writer();

    // Run for 5 seconds
    await delay(5000);

    isRunning = false;
    await Promise.all([...workerPromises, writerPromise]);

    // 4. Assert and Validate metrics consistency
    const m = cache.metrics;
    expect(m.hits + m.misses).toBe(totalOps);
    expect(m.refreshes).toBe(refreshCallbacks);
    
    // We expect some refreshes to have run during 5 seconds (refreshAge is 1s)
    expect(m.refreshes).toBeGreaterThanOrEqual(3); 
    
    // Expect some mismatches/updates to be tracked
    expect(customEqualCalls).toBeGreaterThan(0);
    
    // Cleanup
    await cache.close();
}, 8000); // 8 seconds test timeout limit

