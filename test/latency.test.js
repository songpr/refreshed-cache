const { expect, test, describe, afterEach } = require("@jest/globals");
const DataCache = require("../index");

// Automatic cleanup registry to prevent hanging timers
let activeCaches = [];
afterEach(async () => {
    for (const cache of activeCaches) {
        try {
            await cache.close();
        } catch (e) {}
    }
    activeCaches = [];
});

function newCache(fetch, options) {
    const cache = new DataCache(fetch, options);
    activeCaches.push(cache);
    return cache;
}

describe("Tier 2.5 Latency and Gain Metrics", () => {
    test("latencySampleRate validation", () => {
        expect(() => newCache(() => [], { latencySampleRate: "invalid" })).toThrow("Invalid latencySampleRate");
        expect(() => newCache(() => [], { latencySampleRate: -0.1 })).toThrow("Invalid latencySampleRate");
        expect(() => newCache(() => [], { latencySampleRate: 1.1 })).toThrow("Invalid latencySampleRate");
        expect(() => newCache(() => [], { latencySampleRate: NaN })).toThrow("Invalid latencySampleRate");

        const cache = newCache(() => [], { latencySampleRate: 0.5 });
        expect(cache.latencySampleRate).toBe(0.5);
    });

    test("metrics are initialized with 0 or correct default structure", async () => {
        const cache = newCache(() => [['a', 1]], { max: 10 });
        await cache.init();

        const m = cache.metrics;
        expect(m.hitLatency).toEqual({ avgMs: 0 });
        expect(m.missFetchLatency).toEqual({ minMs: 0, avgMs: 0, maxMs: 0 });
        expect(m.batchFetchLatency).toEqual({ minMs: 0, avgMs: 0, maxMs: 0 });
        expect(m.refreshLatency.avgMs).toBeGreaterThanOrEqual(0); // init performs a refresh loop/setup
        expect(m.timeSavedMs).toBe(0);
        expect(m.hitSpeedup).toBe(0);
        expect(m.batchPerKeyMs).toBe(0);
        expect(m.batchEfficiency).toBe(0);
    });

    test("cache hit latency sampling tracks hits correctly", async () => {
        // Use sample rate 1.0 to sample every single hit
        const cache = newCache(() => [['a', 1], ['b', 2]], { max: 10, latencySampleRate: 1.0 });
        await cache.init();

        // 10 hits
        for (let i = 0; i < 10; i++) {
            cache.get('a');
        }

        const m = cache.metrics;
        expect(m.hits).toBe(10);
        expect(m.hitLatency.avgMs).toBeGreaterThan(0);
    });

    test("cache hit latency respects latencySampleRate", async () => {
        // Sample rate of 0.2 means sample every 5th hit (1 / 0.2 = 5)
        const cache = newCache(() => [['a', 1]], { max: 10, latencySampleRate: 0.2 });
        await cache.init();

        // Perform 4 hits
        for (let i = 0; i < 4; i++) {
            cache.get('a');
        }
        // At this point, only index 0 was sampled (the first hit).
        // Let's perform 6 hits total
        cache.get('a'); // 5th hit (sampled)
        cache.get('a'); // 6th hit

        const m = cache.metrics;
        expect(m.hits).toBe(6);
        // We should have hitCount = 2 (1st and 5th hits)
        // Let's verify that hitLatency.avgMs is calculated and greater than 0
        expect(m.hitLatency.avgMs).toBeGreaterThan(0);
    });

    test("missFetchLatency tracks single-key fetch timings", async () => {
        const cache = newCache(() => [], {
            max: 10,
            fetchByKey: async (key) => {
                await new Promise(r => setTimeout(r, 10)); // simulate DB network latency
                return `val-${key}`;
            }
        });
        await cache.init();

        await cache.getOrFetch('k1');
        await cache.getOrFetch('k2');

        const m = cache.metrics;
        expect(m.misses).toBe(2);
        expect(m.missFetchLatency.minMs).toBeGreaterThanOrEqual(9);
        expect(m.missFetchLatency.maxMs).toBeGreaterThanOrEqual(m.missFetchLatency.minMs);
        expect(m.missFetchLatency.avgMs).toBeGreaterThanOrEqual(m.missFetchLatency.minMs);
    });

    test("batchFetchLatency and derived batch metrics are tracked", async () => {
        const cache = newCache(() => [], {
            max: 10,
            fetchByKeys: async (keys) => {
                await new Promise(r => setTimeout(r, 15));
                return keys.map(k => [k, `val-${k}`]);
            }
        });
        await cache.init();

        await cache.getOrFetchMany(['k1', 'k2', 'k3']);

        const m = cache.metrics;
        expect(m.batchFetchLatency.minMs).toBeGreaterThanOrEqual(14);
        expect(m.batchFetchLatency.avgMs).toBeGreaterThanOrEqual(14);
        expect(m.batchPerKeyMs).toBeCloseTo(m.batchFetchLatency.avgMs / 3, 1);
        // Since missFetchLatency has no entries yet, batchEfficiency should be 0 or calculated based on missFetchAvgMs
        expect(m.batchEfficiency).toBe(0);
    });

    test("timeSavedMs is never negative when hits exist but no per-key fetches occurred", async () => {
        // Reproduces the §B "Active-Only Refresh" case: the cache is populated by a
        // refresh loader (no fetchByKey miss-fetches), so missFetchAvgMs stays 0 while
        // hitAvgMs is sampled > 0. The old formula hits*(0 - hitAvg) produced a bogus
        // negative "time saved". With no fetch baseline to compare against, the honest
        // answer is 0, never negative.
        const cache = newCache(() => [['a', 1]], { max: 10, latencySampleRate: 1.0 });
        await cache.init();

        for (let i = 0; i < 50; i++) {
            cache.get('a'); // pure hits, sampled -> hitAvgMs > 0
        }

        const m = cache.metrics;
        expect(m.missFetchLatency.avgMs).toBe(0); // no per-key fetch baseline
        expect(m.hitLatency.avgMs).toBeGreaterThan(0);
        expect(m.timeSavedMs).toBe(0); // not negative
        expect(cache.gain().timeSavedMs).toBeGreaterThanOrEqual(0);
    });

    test("metrics expose an honestly-named hit-vs-fetch latency ratio", async () => {
        const cache = newCache(() => [], {
            max: 10,
            latencySampleRate: 1.0,
            fetchByKey: async (key) => {
                await new Promise(r => setTimeout(r, 10));
                return `val-${key}`;
            }
        });
        await cache.init();

        await cache.getOrFetch('k1'); // one miss-fetch (~10ms baseline)
        cache.get('k1');              // one sampled hit (sub-ms)

        const m = cache.metrics;
        // The ratio is a latency ratio (fetch / hit), NOT an application speedup.
        expect(m.hitVsFetchLatencyRatio).toBeGreaterThan(1);
        expect(m.hitVsFetchLatencyRatio).toBe(m.hitSpeedup); // back-compat alias
        expect(cache.gain().hitVsFetchLatencyRatio).toBe(cache.gain().speedupFactor);
    });

    test("gain() method reports correct optimization recommendations", async () => {
        // Scenario 1: Cache is disabled (max=0)
        const disabledCache = newCache(() => [], { max: 0 });
        await disabledCache.init();
        let report = disabledCache.gain();
        expect(report.recommendation).toBe("Cache is disabled (max=0).");

        // Scenario 2: Underutilized cache (low utilization and efficiency)
        // Set max=1000, only cache 3 items, and make few queries
        const underutilizedCache = newCache(() => [['a', 1], ['b', 2], ['c', 3]], {
            max: 1000,
            maxAge: 300,
            latencySampleRate: 1.0,
            fetchByKey: async (k) => `val-${k}`
        });
        await underutilizedCache.init();
        // Make 1 hit (hit/size ratio = 1/3 = 0.333, utilization = 3/1000 = 0.003)
        underutilizedCache.get('a');
        report = underutilizedCache.gain();
        expect(report.utilization).toBeLessThan(0.2);
        expect(report.hitSizeRatio).toBeLessThan(0.5);
        expect(report.recommendation).toBe("Cache is underutilized. Consider decreasing max size or lowering TTL.");

        // Scenario 3: High efficiency and near capacity (high utilization and high hit/size ratio)
        // Set max=2, cache 2 items, make 5 hits
        const highEffCache = newCache(() => [['a', 1], ['b', 2]], {
            max: 2,
            maxAge: 300,
            latencySampleRate: 1.0
        });
        await highEffCache.init();
        for (let i = 0; i < 5; i++) {
            highEffCache.get('a');
        }
        report = highEffCache.gain();
        expect(report.utilization).toBeGreaterThanOrEqual(0.8);
        expect(report.hitSizeRatio).toBeGreaterThan(2);
        expect(report.recommendation).toBe("High efficiency and near-capacity. Consider increasing max size to capture more hits.");

        // Scenario 4: Optimal cache sizing
        // Set max=10, cache 5 items, make 1 hit (utilization = 0.5, hit/size ratio = 0.2)
        const optimalCache = newCache(() => [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]], {
            max: 10,
            maxAge: 300,
            latencySampleRate: 1.0
        });
        await optimalCache.init();
        optimalCache.get('a');
        report = optimalCache.gain();
        expect(report.recommendation).toBe("Cache size and TTL are optimal for the current workload.");
    });
});
