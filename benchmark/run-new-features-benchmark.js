const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, measureMemory, percentiles, resetCacheMetrics, logCacheValidation } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');

const TOTAL_DURATION_SEC = parseInt(getArg('duration', '600'), 10);

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// High connection pool size to prevent connection throttling during benchmark
const sql = postgres(connectionString, { max: 100 });

// Bypassed cache subclass that disables promise coalescing (representing old caching logic)
class DataCacheNoCoalescing extends DataCache {
    async getOrFetch(key, _trackMetrics = true) {
        const value = this._cache.get(key);
        if (value !== undefined) {
            if (_trackMetrics) this._hits++;
            return value;
        }

        if (_trackMetrics) this._misses++;
        if (this._fetchByKey !== undefined) {
            if (this._missCache.peek(key) !== undefined) return undefined;

            // Direct call to database bypasses coalescing map entirely
            const newValue = this._isAsyncFetchByKey ? await this._fetchByKey(key) : this._fetchByKey(key);
            if (newValue !== undefined) {
                this._cache.set(key, newValue);
            } else {
                this._missCache.set(key, true);
            }
            return newValue;
        }
    }

    async getOrFetchMany(keys) {
        if (!Array.isArray(keys)) throw new Error("keys must be an array");
        const result = {};
        const missingKeys = [];

        for (const key of keys) {
            const val = this._cache.get(key);
            if (val !== undefined) {
                this._hits++;
                result[key] = val;
            } else {
                this._misses++;
                missingKeys.push(key);
            }
        }

        if (missingKeys.length > 0) {
            // Force individual getOrFetch (no batching)
            const promises = missingKeys.map(async (key) => {
                const val = await this.getOrFetch(key, false);
                return [key, val];
            });
            const resolved = await Promise.all(promises);
            for (const [k, v] of resolved) {
                if (v !== undefined) {
                    result[k] = v;
                }
            }
        }
        return result;
    }
}

// Each strategy is isolated in its own process (see lib/isolated-runner.js).
const STRATEGIES = [
    { key: 'direct', label: 'Direct Prepared Statements (No Cache)', setup: async () => null },
    {
        key: 'old',
        label: 'Old Caching Logic (No Coalescing, Individual Miss Fetches)',
        setup: async (trackedSql) => {
            const cache = new DataCacheNoCoalescing(
                async () => [],
                {
                    max: 100000,
                    maxAge: 60,
                    refreshAge: 60,
                    resetOnRefresh: false,
                    fetchByKey: async (key) => {
                        await sleep(10); // Simulate DB response delay
                        const [row] = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                        return row || undefined;
                    }
                }
            );
            await cache.init();
            return cache;
        }
    },
    {
        key: 'new',
        label: 'New Caching Logic (Single-flight Coalescing & Batch Loading enabled)',
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

async function runBenchmarkStrategy(name, setupCacheFn) {
    console.log(`\n======================================================`);
    console.log(`RUNNING STRATEGY: ${name}`);
    console.log(`Duration: ${TOTAL_DURATION_SEC}s | Cache Ceiling: 100,000 keys`);
    console.log(`======================================================`);

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

    // Background worker simulating concurrent operations
    const runWorker = async () => {
        const batchSize = 50; // Requests per batch loop
        const targetQps = 1000;
        const intervalMs = (batchSize / targetQps) * 1000;

        while (isRunning) {
            const batchStart = Date.now();
            const elapsedTimeSec = (Date.now() - startTime) / 1000;

            // Sliding window of hot keys representing shifting traffic (scaled to 120,000 to fill 100,000 cache capacity)
            const windowSize = 120000;
            const windowStart = Math.floor(elapsedTimeSec * 1000) % (uuidsUniverse.length - windowSize);
            const hotPool = uuidsUniverse.slice(windowStart, windowStart + windowSize);

            // Constructing a mixture of individual key lookups and batch requests
            const promises = Array.from({ length: batchSize }, async () => {
                const rand = Math.random();
                const qStart = process.hrtime.bigint();
                let results = {};

                if (rand < 0.30) {
                    // 30% chance: Batch fetch of 20 keys (representing dashboard loading)
                    const keys = Array.from({ length: 20 }, () => {
                        const r = Math.random();
                        if (r < 0.85 && hotPool.length > 0) {
                            return hotPool[Math.floor(Math.random() * hotPool.length)];
                        } else if (r < 0.95) {
                            return uuidsUniverse[Math.floor(Math.random() * uuidsUniverse.length)];
                        } else {
                            return 'non-existent-' + Math.floor(Math.random() * 1000000);
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
                    const thunderingRand = Math.random();
                    if (thunderingRand < 0.30 && hotPool.length > 0) {
                        // Thundering herd: Multiple concurrent tasks query the exact same hot key
                        key = hotPool[0];
                    } else {
                        const r = Math.random();
                        if (r < 0.85 && hotPool.length > 0) {
                            key = hotPool[Math.floor(Math.random() * hotPool.length)];
                        } else if (r < 0.95) {
                            key = uuidsUniverse[Math.floor(Math.random() * uuidsUniverse.length)];
                        } else {
                            key = 'non-existent-' + Math.floor(Math.random() * 1000000);
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

    // Spawn concurrent load workers
    const workerPromises = Array.from({ length: 4 }, () => runWorker());

    // Monitor loop
    const totalIntervals = Math.max(1, Math.round(TOTAL_DURATION_SEC / intervalSec));
    for (let t = 1; t <= totalIntervals; t++) {
        await sleep(intervalSec * 1000);

        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const pct = percentiles(snapshotLatencies);

        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const throughput = Math.round(requests / intervalSec);
        const mem = await measureMemory();
        const intervalDbQueries = dbQueryCount;
        dbQueryCount = 0;

        let metricsStr = '';
        if (cache && cache.metrics) {
            const m = cache.metrics;
            metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`;
        }
        console.log(`[${t * intervalSec}s] Cache Size: ${cache ? cache.size : 'N/A'} | Throughput: ${throughput} rps | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${intervalDbQueries}${metricsStr} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);

        statsHistory.push({
            elapsed: t * intervalSec,
            throughput,
            avgLatency: pct.avg,
            p50: pct.p50,
            p95: pct.p95,
            p99: pct.p99,
            dbQueries: intervalDbQueries,
            heap: mem.heapUsed,
            rss: mem.rss
        });
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
        await warmup();
        const result = await runBenchmarkStrategy(`${prefix}${strat.label}`, strat.setup);
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

    await sql.end();
}

main().catch(err => {
    console.error('Benchmark execution error:', err);
    process.exit(1);
});
