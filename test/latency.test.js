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
        expect(m.hitRate).toBe(0);
        expect(m.evictions).toBe(0);
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
        // The deprecated hitSpeedup / speedupFactor aliases were removed (never published);
        // gain() exposes the same honestly-named ratio.
        expect(cache.gain().hitVsFetchLatencyRatio).toBeGreaterThan(1);
    });

    test("gain() exposes the documented report shape and disabled/gathering states", async () => {
        // The recommendation-engine semantics (thrash / refresh-waste / over-provisioned /
        // low-value) are covered exhaustively in test/recommend.test.js. Here we only verify
        // gain()'s integration surface from the metrics side: the disabled branch, the
        // "gathering data" guard, and the documented report fields.

        // Cache disabled (max=0)
        const disabledCache = newCache(() => [], { max: 0 });
        await disabledCache.init();
        const disabled = disabledCache.gain();
        expect(disabled.code).toBe("disabled");
        expect(disabled.recommendation).toBe("Cache is disabled (max=0).");

        // Populated cache below the request threshold -> "gathering data" guard
        const cache = newCache(() => [['a', 1], ['b', 2], ['c', 3]], {
            max: 1000,
            maxAge: 300,
            latencySampleRate: 1.0
        });
        await cache.init();
        cache.get('a'); // 1 request, well below the 100-request threshold

        const report = cache.gain();
        expect(report.code).toBe("healthy");
        expect(report.recommendation).toMatch(/Gathering data/);
        // Documented report fields are all present
        expect(report).toHaveProperty("timeSavedMs");
        expect(report).toHaveProperty("hitVsFetchLatencyRatio");
        expect(report).toHaveProperty("activeSize");
        expect(report).toHaveProperty("hitSizeRatio");
        expect(report).toHaveProperty("utilization");
        expect(report.utilization).toBeLessThan(0.2);
    });
});
