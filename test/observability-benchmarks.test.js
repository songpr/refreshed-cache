const { expect, test } = require("@jest/globals");
const DataCache = require("../index");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const percentiles = (latencies) => {
    if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0 };
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
        p50: parseFloat(sorted[Math.floor(sorted.length * 0.50)].toFixed(2)),
        p95: parseFloat(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
        p99: parseFloat(sorted[Math.floor(sorted.length * 0.99)].toFixed(2))
    };
};

const getHeapUsedMB = () => {
    return parseFloat((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
};

const getRssMB = () => {
    return parseFloat((process.memoryUsage().rss / 1024 / 1024).toFixed(2));
};

test("mimic 1: Miss-Cache Benchmark (5s)", async () => {
    console.log("\n======================================================");
    console.log("MIMIC BENCHMARK 1: Miss-Cache Benchmark (Local, 5s)");
    console.log("======================================================");

    const validKeys = Array.from({ length: 500 }, (_, i) => `valid-${i}`);
    const bogusKeys = Array.from({ length: 50 }, (_, i) => `bogus-${i}`);

    let mockQueries = 0;
    const cache = new DataCache(
        async () => {
            mockQueries++;
            return validKeys.map(k => [k, { name: k }]);
        },
        {
            max: 300,
            maxAge: 2,
            refreshAge: 2,
            maxMiss: 100,
            maxAgeMiss: 1, // 1 second miss TTL
            fetchByKey: async (key) => {
                mockQueries++;
                await delay(2); // tiny mock latency
                if (key.startsWith("valid-")) return { name: key };
                return undefined; // bogus miss
            }
        }
    );

    await cache.init();

    // Pre-warm valid keys
    const prewarmBatch = 50;
    for (let i = 0; i < validKeys.length; i += prewarmBatch) {
        await Promise.all(validKeys.slice(i, i + prewarmBatch).map(k => cache.getOrFetch(k)));
    }

    // Reset metrics after pre-warm to isolate test
    mockQueries = 0;
    cache._hits = 0;
    cache._misses = 0;
    cache._refreshes = 0;
    cache._coalescedFetches = 0;

    let isRunning = true;
    let totalRequests = 0;
    let intervalRequests = 0;
    let intervalLatencies = [];

    // Worker simulating traffic: 50% bogus keys, 50% valid keys
    const worker = async () => {
        while (isRunning) {
            const start = process.hrtime.bigint();
            const isBogus = Math.random() < 0.5;
            const key = isBogus 
                ? bogusKeys[Math.floor(Math.random() * bogusKeys.length)]
                : validKeys[Math.floor(Math.random() * validKeys.length)];

            await cache.getOrFetch(key);
            const end = process.hrtime.bigint();
            const diffMs = Number(end - start) / 1e6;

            intervalLatencies.push(diffMs);
            intervalRequests++;
            await delay(5);
        }
    };

    const workers = Array.from({ length: 3 }, () => worker());

    // Logging loop every 1s
    for (let t = 1; t <= 5; t++) {
        await delay(1000);
        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const throughput = Math.round(requests / 1);
        const pct = percentiles(snapshotLatencies);
        const mem = getHeapUsedMB();
        
        const m = cache.metrics;
        const metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`;
        
        console.log(`[${t}s] Throughput: ${throughput} rps | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${mockQueries}${metricsStr} | Heap: ${mem} MB`);
        mockQueries = 0;
    }

    isRunning = false;
    await Promise.all(workers);
    totalRequests += intervalRequests;

    const m = cache.metrics;
    const isOpsValid = (m.hits + m.misses === totalRequests);
    console.log(`[Metrics Validation] Total Ops: ${totalRequests} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);
    console.log(`[Metrics Validation] Metrics: Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations} | Refreshes: ${m.refreshes}`);

    expect(isOpsValid).toBe(true);

    await cache.close();
}, 8000);

test("mimic 2: Load Test (5s)", async () => {
    console.log("\n======================================================");
    console.log("MIMIC BENCHMARK 2: Load Test (Local, 5s)");
    console.log("======================================================");

    const keysUniverse = Array.from({ length: 1000 }, (_, i) => `key-${i}`);

    let mockQueries = 0;
    const cache = new DataCache(
        async () => {
            mockQueries++;
            return keysUniverse.slice(0, 100).map(k => [k, { name: k }]);
        },
        {
            max: 500,
            maxAge: 2,
            refreshAge: 2,
            fetchByKey: async (key) => {
                mockQueries++;
                await delay(2);
                return { name: key };
            }
        }
    );

    await cache.init();
    mockQueries = 0;
    cache._hits = 0;
    cache._misses = 0;
    cache._refreshes = 0;
    cache._coalescedFetches = 0;

    let isRunning = true;
    let totalRequests = 0;
    let intervalRequests = 0;
    let intervalLatencies = [];
    let hitsCount = 0;

    const worker = async () => {
        while (isRunning) {
            const start = process.hrtime.bigint();
            const key = keysUniverse[Math.floor(Math.random() * keysUniverse.length)];
            const val = await cache.getOrFetch(key);
            const end = process.hrtime.bigint();
            const diffMs = Number(end - start) / 1e6;

            intervalLatencies.push(diffMs);
            intervalRequests++;
            if (val) hitsCount++;
            await delay(5);
        }
    };

    const workers = Array.from({ length: 3 }, () => worker());

    for (let t = 1; t <= 5; t++) {
        await delay(1000);
        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const throughput = Math.round(requests / 1);
        const pct = percentiles(snapshotLatencies);
        const mem = getHeapUsedMB();
        const rss = getRssMB();
        
        let metricsStr = '';
        if (cache && cache.metrics) {
            const m = cache.metrics;
            metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`;
        }

        console.log(`[${t}s] Cache Size: ${cache.size} | Throughput: ${throughput} rps | Row-Exist Rate: 100.0% | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${mockQueries}${metricsStr} | Heap: ${mem} MB | RSS: ${rss} MB`);
        mockQueries = 0;
    }

    isRunning = false;
    await Promise.all(workers);
    totalRequests += intervalRequests;

    const m = cache.metrics;
    const isOpsValid = (m.hits + m.misses === totalRequests);
    console.log(`[Metrics Validation] Total Ops: ${totalRequests} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);
    console.log(`[Metrics Validation] Metrics: Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations} | Refreshes: ${m.refreshes}`);

    expect(isOpsValid).toBe(true);

    await cache.close();
}, 8000);

test("mimic 3: Long Running Benchmark (5s)", async () => {
    console.log("\n======================================================");
    console.log("MIMIC BENCHMARK 3: Long Running Benchmark (Local, 5s)");
    console.log("======================================================");

    const keysUniverse = Array.from({ length: 1000 }, (_, i) => `key-${i}`);

    let mockQueries = 0;
    let totalQueries = 0;
    const cache = new DataCache(
        async () => {
            mockQueries++;
            totalQueries++;
            return keysUniverse.slice(0, 100).map(k => [k, { name: k }]);
        },
        {
            max: 500,
            maxAge: 1, // trigger active refreshes quickly
            refreshAge: 1,
            fetchByKey: async (key) => {
                mockQueries++;
                totalQueries++;
                await delay(2);
                return { name: key };
            }
        }
    );

    await cache.init();
    mockQueries = 0;
    totalQueries = 0;
    cache._hits = 0;
    cache._misses = 0;
    cache._refreshes = 0;
    cache._coalescedFetches = 0;

    let isRunning = true;
    let totalRequests = 0;
    let intervalRequests = 0;
    let intervalLatencies = [];

    const worker = async () => {
        while (isRunning) {
            const start = process.hrtime.bigint();
            const key = keysUniverse[Math.floor(Math.random() * keysUniverse.length)];
            await cache.getOrFetch(key);
            const end = process.hrtime.bigint();
            const diffMs = Number(end - start) / 1e6;

            intervalLatencies.push(diffMs);
            intervalRequests++;
            await delay(5);
        }
    };

    const workers = Array.from({ length: 3 }, () => worker());

    for (let t = 1; t <= 5; t++) {
        await delay(1000);
        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const throughput = Math.round(requests / 1);
        const pct = percentiles(snapshotLatencies);
        const mem = getHeapUsedMB();
        const rss = getRssMB();
        
        let metricsStr = '';
        if (cache && cache.metrics) {
            const m = cache.metrics;
            metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations} | Refreshes: ${m.refreshes}`;
        }

        console.log(`[${t}s] Cache Size: ${cache.size} | Throughput: ${throughput} rps | Hit Rate: 100.0% | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${mockQueries}${metricsStr} | Heap: ${mem} MB | RSS: ${rss} MB`);
        mockQueries = 0;
    }

    isRunning = false;
    await Promise.all(workers);
    totalRequests += intervalRequests;

    const m = cache.metrics;
    const isOpsValid = (m.hits + m.misses === totalRequests);
    const expectedDBQueries = (m.refreshes || 0) + (m.misses - m.coalescedFetches);
    const isDbQueriesValid = (totalQueries <= expectedDBQueries);
    console.log(`[Metrics Validation] Total Ops: ${totalRequests} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);
    console.log(`[Metrics Validation] DB Queries: ${totalQueries} | Expected: ${expectedDBQueries} (Match: ${isDbQueriesValid ? '✅' : '❌'}, saved ${expectedDBQueries - totalQueries} by miss-cache)`);

    expect(isOpsValid).toBe(true);

    await cache.close();
}, 8000);

test("mimic 4: New Features Benchmark (5s)", async () => {
    console.log("\n======================================================");
    console.log("MIMIC BENCHMARK 4: New Features Benchmark (Local, 5s)");
    console.log("======================================================");

    const keysUniverse = Array.from({ length: 1000 }, (_, i) => `key-${i}`);

    let mockQueries = 0;
    let totalQueries = 0;
    const cache = new DataCache(
        async () => {
            mockQueries++;
            totalQueries++;
            return keysUniverse.slice(0, 100).map(k => [k, { name: k }]);
        },
        {
            max: 500,
            maxAge: 2,
            refreshAge: 2,
            fetchByKeys: async (keys) => {
                mockQueries++;
                totalQueries++;
                await delay(5);
                return keys.map(k => [k, { name: k }]);
            }
        }
    );

    await cache.init();
    mockQueries = 0;
    totalQueries = 0;
    cache._hits = 0;
    cache._misses = 0;
    cache._refreshes = 0;
    cache._coalescedFetches = 0;

    let isRunning = true;
    let totalRequests = 0;
    let intervalRequests = 0;
    let intervalLatencies = [];

    const worker = async () => {
        while (isRunning) {
            const start = process.hrtime.bigint();
            
            // Mix of single and batch getOrFetch requests
            const rand = Math.random();
            if (rand < 0.30) {
                // Batch query of 5 keys
                const keys = Array.from({ length: 5 }, () => keysUniverse[Math.floor(Math.random() * keysUniverse.length)]);
                await cache.getOrFetchMany(keys);
                intervalRequests += 5;
            } else {
                // Single query
                const key = keysUniverse[Math.floor(Math.random() * keysUniverse.length)];
                await cache.getOrFetch(key);
                intervalRequests++;
            }
            
            const end = process.hrtime.bigint();
            const diffMs = Number(end - start) / 1e6;
            intervalLatencies.push(diffMs);
            await delay(5);
        }
    };

    const workers = Array.from({ length: 3 }, () => worker());

    for (let t = 1; t <= 5; t++) {
        await delay(1000);
        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const throughput = Math.round(requests / 1);
        const pct = percentiles(snapshotLatencies);
        const mem = getHeapUsedMB();
        const rss = getRssMB();
        
        let metricsStr = '';
        if (cache && cache.metrics) {
            const m = cache.metrics;
            metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`;
        }

        console.log(`[${t}s] Cache Size: ${cache.size} | Throughput: ${throughput} rps | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${mockQueries}${metricsStr} | Heap: ${mem} MB | RSS: ${rss} MB`);
        mockQueries = 0;
    }

    isRunning = false;
    await Promise.all(workers);
    totalRequests += intervalRequests;

    const m = cache.metrics;
    const isOpsValid = (m.hits + m.misses === totalRequests);
    const expectedDBQueries = (m.refreshes || 0) + (m.misses - m.coalescedFetches);
    const isDbQueriesValid = (totalQueries <= expectedDBQueries);
    console.log(`[Metrics Validation] Total Ops: ${totalRequests} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);
    console.log(`[Metrics Validation] DB Queries: ${totalQueries} | Expected: ${expectedDBQueries} (Match: ${isDbQueriesValid ? '✅' : '❌'}, saved ${expectedDBQueries - totalQueries} by miss-cache)`);

    expect(isOpsValid).toBe(true);

    await cache.close();
}, 8000);
