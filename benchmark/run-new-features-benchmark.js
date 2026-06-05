const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, measureMemory, percentiles, resetCacheMetrics, logCacheValidation } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');

const TOTAL_DURATION_SEC = parseInt(getArg('duration', '600'), 10);
// Work-box mode: when --requests=<n> is set, the run stops after exactly N requests
// instead of after a fixed duration. Combined with --seed this makes the executed
// workload bit-identical across runs (same keys AND same request count), so DB-query
// counts are directly comparable — true regression diffing. 0 = time-boxed (default).
const TARGET_REQUESTS = parseInt(getArg('requests', '0'), 10);
const WORK_BOX = TARGET_REQUESTS > 0;
const NUM_WORKERS = 4;

// Deterministic PRNG (mulberry32). Seeding the workload per logical request makes
// key selection reproducible across rounds and across code changes, turning this
// from a variance demo into a regression-grade harness. See --seed below.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function median(nums) {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// High connection pool size to prevent connection throttling during benchmark
const sql = postgres(connectionString, { max: 100 });

// Each strategy is isolated in its own process (see lib/isolated-runner.js).
const { LRUCache } = require('lru-cache');
const STRATEGIES = [
    { key: 'direct', label: 'Direct', setup: async () => null },
    {
        key: 'lru-native',
        label: 'lru-cache',
        setup: async (trackedSql) => {
            const lru = new LRUCache({ max: 100000, ttl: 60000 });
            let hits = 0;
            let misses = 0;
            return {
                getOrFetch: async (key) => {
                    let val = lru.get(key);
                    if (val !== undefined) {
                        hits++;
                        return val;
                    }
                    misses++;
                    await sleep(10);
                    const [row] = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                    val = row || undefined;
                    if (val !== undefined) lru.set(key, val);
                    return val;
                },
                getOrFetchMany: async (keys) => {
                    const result = {};
                    const missing = [];
                    for (const k of keys) {
                        const val = lru.get(k);
                        if (val !== undefined) {
                            hits++;
                            result[k] = val;
                        } else {
                            misses++;
                            missing.push(k);
                        }
                    }
                    if (missing.length > 0) {
                        await sleep(10);
                        const rows = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid IN ${trackedSql(missing)}`;
                        for (const r of rows) {
                            lru.set(r.uuid, r);
                            result[r.uuid] = r;
                        }
                    }
                    return result;
                },
                close: async () => {},
                entries: function* () { yield* lru.entries(); },
                get size() { return lru.size; },
                get metrics() { return { hits, misses, coalescedFetches: 0, invalidations: 0, refreshes: 0 }; },
                gain: () => ({ timeSavedMs: 0, hitVsFetchLatencyRatio: 0, activeSize: lru.size, hitSizeRatio: lru.size ? hits / lru.size : 0, code: 'N/A', recommendation: 'N/A' })
            };
        }
    },
    {
        key: 'new',
        label: 'refreshed-cache',
        setup: async (trackedSql) => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 100000,
                    maxAge: 60,
                    refreshAge: 60,
                    resetOnRefresh: false,
                    fetchByKeys: async (keys) => {
                        await sleep(10);
                        const rows = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid IN ${trackedSql(keys)}`;
                        return rows.map(r => [r.uuid, r]);
                    },
                    fetchByKey: async (key) => {
                        await sleep(10);
                        const [row] = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                        return row || undefined;
                    },
                    // Enable Observability Hooks for Performance & Validity checking
                    onRefresh: (stats) => {
                        // Verified refresh callback
                    },
                    onError: (err) => {
                        console.error('[Benchmark Refresher Error]', err);
                    },
                    checkValidity: (key, value) => {
                        // Check cached item has correct user object fields
                        return value && typeof value === 'object' && typeof value.name === 'string';
                    },
                    isEqual: (a, b) => {
                        return a && b && a.name === b.name && a.email === b.email;
                    }
                }
            );
            await cache.init();
            return cache;
        }
    },
];

async function runBenchmarkStrategy(name, setupCacheFn, seedBase) {
    console.log(`\n======================================================`);
    console.log(`RUNNING STRATEGY: ${name}`);
    const box = WORK_BOX ? `${TARGET_REQUESTS} requests` : `${TOTAL_DURATION_SEC}s`;
    console.log(`Work box: ${box} | Cache Ceiling: 100,000 keys | Seed: ${seedBase}`);
    console.log(`======================================================`);

    // Settle the heap before sampling the baseline so memory deltas start from an
    // equal, post-collection state each round (children run with --expose-gc).
    if (global.gc) global.gc();
    const baseMem = await measureMemory();
    console.log(`Base Memory: Heap ${baseMem.heapUsed} MB | RSS ${baseMem.rss} MB`);

    let dbQueryCount = 0;
    let totalDBQueries = 0;
    const trackedSql = (queryParts, ...values) => {
        if (queryParts && Array.isArray(queryParts) && queryParts.raw) {
            dbQueryCount++;
            totalDBQueries++;
        }
        return sql(queryParts, ...values);
    };

    const cache = await setupCacheFn(trackedSql);
    dbQueryCount = 0;
    totalDBQueries = 0;
    resetCacheMetrics(cache);

    // Fetch UUID universe of 150,000 rows to simulate large key space
    const allRows = await sql`SELECT uuid FROM users LIMIT 150000`;
    const uuidsUniverse = allRows.map(r => r.uuid);

    if (uuidsUniverse.length === 0) {
        throw new Error('Database is empty! Run node benchmark/seed.js first.');
    }

    const startTime = Date.now();
    let totalRequests = 0;
    let totalHits = 0;
    let correctnessFailed = false;

    const intervalSec = Math.min(TOTAL_DURATION_SEC, 30);
    const statsHistory = [];

    let isRunning = true;
    let intervalLatencies = [];
    let intervalRequests = 0;

    // Sliding window of hot keys representing shifting traffic (scaled to 120,000 to fill 100,000 cache capacity).
    const windowSize = 120000;
    const windowDenom = Math.max(1, uuidsUniverse.length - windowSize);
    const batchSize = 50; // Requests per batch loop
    const targetQps = 1000;
    const intervalMs = (batchSize / targetQps) * 1000;
    // Total batch loops expected across all workers; drives the window sweep by
    // LOGICAL progress instead of wall-clock so the sweep is reproducible regardless
    // of GC/scheduling jitter.
    const totalBatches = Math.max(1, NUM_WORKERS * Math.round((TOTAL_DURATION_SEC * 1000) / intervalMs));

    // Monotonic counters: every request gets a unique seq → its own seeded PRNG, so
    // key selection depends only on (seedBase, seq), never on async interleaving.
    let batchTick = 0;
    let reqSeq = 0;

    // Background worker simulating concurrent operations
    const runWorker = async () => {
        while (isRunning) {
            const batchStart = Date.now();

            // In work-box mode, stop the moment the global request budget is exhausted,
            // and size the final batch to land on EXACTLY TARGET_REQUESTS (seqs 0..N-1).
            let thisBatch = batchSize;
            if (WORK_BOX) {
                const remaining = TARGET_REQUESTS - reqSeq;
                if (remaining <= 0) { isRunning = false; break; }
                thisBatch = Math.min(batchSize, remaining);
            }

            const tick = batchTick++;
            // Window sweeps by logical progress: request budget in work-box mode,
            // batch budget in time-boxed mode. Either way it's reproducible.
            const progress = WORK_BOX
                ? Math.min(0.999999, reqSeq / TARGET_REQUESTS)
                : tick / totalBatches;
            const windowStart = Math.min(windowDenom - 1, Math.floor(progress * windowDenom));
            const hotPool = uuidsUniverse.slice(windowStart, windowStart + windowSize);

            // Constructing a mixture of individual key lookups and batch requests
            const promises = Array.from({ length: thisBatch }, async () => {
                const seq = reqSeq++;
                const rng = mulberry32((seedBase * 0x9E3779B1 + seq) >>> 0);
                const rand = rng();
                const qStart = process.hrtime.bigint();
                let results = {};

                if (rand < 0.30) {
                    // 30% chance: Batch fetch of 20 keys (representing dashboard loading)
                    const keys = Array.from({ length: 20 }, () => {
                        const r = rng();
                        if (r < 0.85 && hotPool.length > 0) {
                            return hotPool[Math.floor(rng() * hotPool.length)];
                        } else if (r < 0.95) {
                            return uuidsUniverse[Math.floor(rng() * uuidsUniverse.length)];
                        } else {
                            return 'non-existent-' + Math.floor(rng() * 1000000);
                        }
                    });

                    if (cache) {
                        results = await cache.getOrFetchMany(keys);
                    } else {
                        // Direct DB Fallback
                        const rows = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid IN ${sql(keys)}`;
                        rows.forEach(r => { results[r.uuid] = r; });
                    }
                    intervalRequests += keys.length;
                    totalHits += Object.keys(results).length;
                } else {
                    // 70% chance: Single key lookup (with 30% thundering herd chance on same key)
                    let key;
                    const thunderingRand = rng();
                    if (thunderingRand < 0.30 && hotPool.length > 0) {
                        // Thundering herd: Multiple concurrent tasks query the exact same hot key
                        key = hotPool[0];
                    } else {
                        const r = rng();
                        if (r < 0.85 && hotPool.length > 0) {
                            key = hotPool[Math.floor(rng() * hotPool.length)];
                        } else if (r < 0.95) {
                            key = uuidsUniverse[Math.floor(rng() * uuidsUniverse.length)];
                        } else {
                            key = 'non-existent-' + Math.floor(rng() * 1000000);
                        }
                    }

                    let val;
                    if (cache) {
                        val = await cache.getOrFetch(key);
                    } else {
                        const [row] = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                        val = row;
                    }
                    intervalRequests++;
                    if (val !== undefined) {
                        totalHits++;
                        results[key] = val;
                    }
                }

                const qDiff = Number(process.hrtime.bigint() - qStart) / 1e6; // to ms
                intervalLatencies.push(qDiff);
            });

            await Promise.all(promises);

            const sleepTime = intervalMs - (Date.now() - batchStart);
            if (sleepTime > 0) {
                await sleep(sleepTime);
            }
        }
    };

    // Settle the heap once more so the first measurement interval isn't skewed by
    // setup-phase garbage from a GC pause landing inside the window.
    if (global.gc) global.gc();

    // Spawn concurrent load workers
    const workerPromises = Array.from({ length: NUM_WORKERS }, () => runWorker());

    // Monitor loop. Time-boxed mode runs a fixed number of intervals; work-box mode
    // samples on a cadence until the workers exhaust the request budget. Throughput
    // is computed from REAL elapsed time per interval so a short final interval (or a
    // GC-stretched one) isn't misreported.
    const sampleSec = WORK_BOX ? Math.min(5, intervalSec) : intervalSec;
    const totalIntervals = Math.max(1, Math.round(TOTAL_DURATION_SEC / intervalSec));
    let t = 0;
    let lastSample = Date.now();
    while (isRunning) {
        await sleep(sampleSec * 1000);
        t++;

        const now = Date.now();
        const elapsedSec = (now - lastSample) / 1000;
        lastSample = now;

        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const pct = percentiles(snapshotLatencies);

        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const throughput = Math.round(requests / elapsedSec);
        const mem = await measureMemory();
        const intervalDbQueries = dbQueryCount;
        dbQueryCount = 0;

        let metricsStr = '';
        if (cache && cache.metrics) {
            const m = cache.metrics;
            metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`;
        }
        const tag = WORK_BOX ? `${reqSeq}/${TARGET_REQUESTS} req` : `${t * intervalSec}s`;
        console.log(`[${tag}] Cache Size: ${cache ? cache.size : 'N/A'} | Throughput: ${throughput} rps | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${intervalDbQueries}${metricsStr} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);

        statsHistory.push({
            elapsed: Math.round((now - startTime) / 1000),
            throughput,
            avgLatency: pct.avg,
            p50: pct.p50,
            p95: pct.p95,
            p99: pct.p99,
            dbQueries: intervalDbQueries,
            heap: mem.heapUsed,
            rss: mem.rss
        });

        // Time-boxed mode ends after its fixed interval budget; work-box mode keeps
        // sampling until a worker flips isRunning=false on hitting TARGET_REQUESTS.
        if (!WORK_BOX && t >= totalIntervals) isRunning = false;
    }

    isRunning = false;
    await Promise.all(workerPromises);
    totalRequests += intervalRequests;

    // ==========================================
    // VALIDITY OF RESULTS AFTER HEAVY LOAD
    // ==========================================
    console.log('Auditing cache correctness post-load...');
    if (cache) {
        // Query 1,000 random cached items and assert their value is identical to the database values
        let auditSuccessCount = 0;
        let auditTotal = 0;

        // Take sample keys from cache
        const cacheEntries = Array.from(cache.entries()).slice(0, 1000);
        if (cacheEntries.length > 0) {
            const auditPromises = cacheEntries.map(async ([key, cachedVal]) => {
                auditTotal++;
                const [dbVal] = await sql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                if (dbVal && cachedVal && dbVal.name === cachedVal.name && dbVal.email === cachedVal.email) {
                    auditSuccessCount++;
                } else if (!dbVal && !cachedVal) {
                    auditSuccessCount++;
                }
            });
            await Promise.all(auditPromises);
            console.log(`Correctness Audit: verified ${auditSuccessCount} / ${auditTotal} entries successfully.`);
            if (auditSuccessCount !== auditTotal) {
                correctnessFailed = true;
            }
        } else {
            console.log('Audit skipped: Cache contains no entries.');
        }
    } else {
        console.log('Direct DB Strategy (no cache to audit).');
    }

    logCacheValidation(cache, totalRequests, totalDBQueries);
    
    if (cache && name === 'refreshed-cache') {
        const g = cache.gain();
        if (g.code !== 'healthy') {
            console.error(`❌ Assertion Failed: Expected 'healthy' recommendation, got '${g.code}'`);
            correctnessFailed = true;
        } else {
            console.log(`✅ Assertion Passed: 'healthy' recommendation witnessed.`);
        }
    }

    if (cache) {
        await cache.close();
    }
    const finalMem = await measureMemory();

    return {
        name,
        statsHistory,
        finalHitRate: ((totalHits / totalRequests) * 100).toFixed(1),
        totalDBQueries,
        peakHeapMB: Math.max(...statsHistory.map(h => parseFloat(h.heap))).toFixed(2),
        peakRssMB: Math.max(...statsHistory.map(h => parseFloat(h.rss))).toFixed(2),
        baseHeapMB: baseMem.heapUsed,
        baseRssMB: baseMem.rss,
        afterCleanupHeapMB: finalMem.heapUsed,
        afterCleanupRssMB: finalMem.rss,
        p50: statsHistory[statsHistory.length - 1].p50,
        p95: statsHistory[statsHistory.length - 1].p95,
        p99: statsHistory[statsHistory.length - 1].p99,
        correctness: !correctnessFailed ? '✅ PASSED' : '❌ FAILED',
        avgThroughput: Math.round(statsHistory.reduce((a, b) => a + b.throughput, 0) / statsHistory.length)
    };
}

async function warmup() {
    await Promise.all(Array.from({ length: 15 }, () => sql`SELECT 1`));
}

async function main() {
    const rounds = parseInt(getArg('rounds', '1'), 10);

    // CHILD MODE: a single strategy in a fresh, isolated process.
    if (isChild) {
        const key = getArg('strategy');
        const round = parseInt(getArg('round', '1'), 10);
        const strat = STRATEGIES.find(s => s.key === key);
        if (!strat) throw new Error(`Unknown strategy key: ${key}`);
        const prefix = rounds > 1 ? `[Round ${round}] ` : '';
        // Per-round seed: every strategy within a round shares the same key sequence
        // (apples-to-apples), and each round is reproducible across re-invocations.
        // Override the base with --seed=<n> to pin or shift the whole sweep.
        const seedBase = (parseInt(getArg('seed', '1000'), 10) + round) >>> 0;
        await warmup();
        const result = await runBenchmarkStrategy(`${prefix}${strat.label}`, strat.setup, seedBase);
        emitResult(result);
        await sql.end();
        return;
    }

    // PARENT MODE: fork one fresh process per (round, strategy).
    const results = await orchestrate({
        scriptPath: __filename,
        strategyKeys: STRATEGIES.map(s => s.key),
        rounds,
        passArgs: process.argv.slice(2),
    });

    console.log(`\n======================================================`);
    console.log(`NEW VS OLD FEATURES BENCHMARK COMPARISON (${rounds} ROUNDS, process-isolated)`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Avg Throughput': `${r.avgThroughput} rps`,
        'p50 Latency': `${r.p50}ms`,
        'p95 Latency': `${r.p95}ms`,
        'p99 Latency': `${r.p99}ms`,
        'DB Queries': r.totalDBQueries,
        'Peak Heap (MB)': r.peakHeapMB,
        'Base Heap (MB)': r.baseHeapMB,
        'Heap Growth (MB)': (r.peakHeapMB - r.baseHeapMB).toFixed(2),
        'Cleaned Heap (MB)': r.afterCleanupHeapMB,
        'Correctness': r.correctness
    })));

    if (rounds > 1) {
        // Aggregate across rounds per strategy. Median is robust to the single-round
        // GC/scheduling outliers that make raw per-round numbers look unstable; min–max
        // shows the spread so a regression is distinguishable from normal variance.
        const stripRound = (name) => name.replace(/^\[Round \d+\]\s*/, '');
        const byStrategy = new Map();
        for (const r of results) {
            const label = stripRound(r.name);
            if (!byStrategy.has(label)) byStrategy.set(label, []);
            byStrategy.get(label).push(r);
        }

        console.log(`\n======================================================`);
        console.log(`AGGREGATE OVER ${rounds} ROUNDS (median | min–max)`);
        console.log(`======================================================`);
        const fmt = (arr, d = 0) => {
            const med = median(arr);
            const lo = Math.min(...arr);
            const hi = Math.max(...arr);
            return `${med.toFixed(d)} (${lo.toFixed(d)}–${hi.toFixed(d)})`;
        };
        console.table(Array.from(byStrategy.entries()).map(([label, rs]) => ({
            'Strategy': label,
            'Throughput (rps)': fmt(rs.map(r => r.avgThroughput)),
            'p50 (ms)': fmt(rs.map(r => parseFloat(r.p50)), 2),
            'p99 (ms)': fmt(rs.map(r => parseFloat(r.p99)), 2),
            'DB Queries': fmt(rs.map(r => r.totalDBQueries)),
            'Heap Growth (MB)': fmt(rs.map(r => r.peakHeapMB - r.baseHeapMB), 2),
            'Correctness': rs.every(r => r.correctness.includes('PASSED')) ? '✅ PASSED' : '❌ FAILED'
        })));
    }

    await sql.end();
}

main().catch(err => {
    console.error('Benchmark execution error:', err);
    process.exit(1);
});
