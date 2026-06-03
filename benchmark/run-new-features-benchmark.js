const postgres = require('postgres');
const DataCache = require('../index.js');

// Parse duration from args (default to 600s / 10 minutes)
const args = process.argv.slice(2);
const durationArg = args.find(arg => arg.startsWith('--duration='));
const TOTAL_DURATION_SEC = durationArg ? parseInt(durationArg.split('=')[1], 10) : 600;

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// High connection pool size to prevent connection throttling during benchmark
const sql = postgres(connectionString, { max: 100 });

// Helper to delay
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Helper to get memory usage in MB
function getMemoryUsage() {
    if (global.gc) {
        try {
            global.gc();
        } catch (e) {}
    }
    const mem = process.memoryUsage();
    return {
        heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
        rss: (mem.rss / 1024 / 1024).toFixed(2)
    };
}

// Bypassed cache subclass that disables promise coalescing (representing old caching logic)
class DataCacheNoCoalescing extends DataCache {
    async getOrFetch(key) {
        const value = this._cache.get(key);
        if (value !== undefined) return value;

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
                result[key] = val;
            } else {
                missingKeys.push(key);
            }
        }

        if (missingKeys.length > 0) {
            // Force individual getOrFetch (no batching)
            const promises = missingKeys.map(async (key) => {
                const val = await this.getOrFetch(key);
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

async function runBenchmarkStrategy(name, setupCacheFn) {
    console.log(`\n======================================================`);
    console.log(`RUNNING STRATEGY: ${name}`);
    console.log(`Duration: ${TOTAL_DURATION_SEC}s | Cache Ceiling: 100,000 keys`);
    console.log(`======================================================`);

    getMemoryUsage();
    await sleep(500);
    const baseMem = getMemoryUsage();
    console.log(`Base Memory: Heap ${baseMem.heapUsed} MB | RSS ${baseMem.rss} MB`);

    let dbQueryCount = 0;
    const trackedSql = (queryParts, ...values) => {
        if (queryParts && Array.isArray(queryParts) && queryParts.raw) {
            dbQueryCount++;
        }
        return sql(queryParts, ...values);
    };

    const cache = await setupCacheFn(trackedSql);

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

        const latencies = [...intervalLatencies].sort((a, b) => a - b);
        intervalLatencies = [];

        const requests = intervalRequests;
        intervalRequests = 0;
        totalRequests += requests;

        const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.50)].toFixed(2) : '0.00';
        const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)].toFixed(2) : '0.00';
        const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)].toFixed(2) : '0.00';
        const avg = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2) : '0.00';
        const throughput = Math.round(requests / intervalSec);
        const mem = getMemoryUsage();

        console.log(`[${t * intervalSec}s] Cache Size: ${cache ? cache.size : 'N/A'} | Throughput: ${throughput} rps | p50: ${p50}ms | p95: ${p95}ms | p99: ${p99}ms | DB Queries: ${dbQueryCount} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);

        statsHistory.push({
            elapsed: t * intervalSec,
            throughput,
            avgLatency: avg,
            p50,
            p95,
            p99,
            dbQueries: dbQueryCount,
            heap: mem.heapUsed,
            rss: mem.rss
        });

        dbQueryCount = 0;
    }

    isRunning = false;
    await Promise.all(workerPromises);

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

    if (cache) {
        await cache.close();
    }
    await sleep(2000);
    const finalMem = getMemoryUsage();

    return {
        name,
        statsHistory,
        finalHitRate: ((totalHits / totalRequests) * 100).toFixed(1),
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

async function main() {
    // Parse arguments
    const args = process.argv.slice(2);
    const roundsArg = args.find(arg => arg.startsWith('--rounds='));
    const rounds = roundsArg ? parseInt(roundsArg.split('=')[1], 10) : 1;

    // Warm up connections
    await Promise.all(Array.from({ length: 15 }, () => sql`SELECT 1`));

    const results = [];

    for (let r = 1; r <= rounds; r++) {
        const prefix = rounds > 1 ? `[Round ${r}] ` : '';
        console.log(`\n\n=== ROUND ${r} OF ${rounds} ===`);

        // Strategy A: Direct Postgres (No Cache)
        results.push(await runBenchmarkStrategy(
            `${prefix}Direct Prepared Statements (No Cache)`,
            async () => null
        ));
        await sleep(5000);

        // Strategy B: Caching without New Features (Old Fallback Logic)
        results.push(await runBenchmarkStrategy(
            `${prefix}Old Caching Logic (No Coalescing, Individual Miss Fetches)`,
            async (trackedSql) => {
                const cache = new DataCacheNoCoalescing(
                    async () => [],
                    {
                        max: 100000,
                        maxAge: 60,
                        refreshAge: 60,
                        resetOnRefresh: false,
                        fetchByKey: async (key) => {
                            // Simulate DB response delay
                            await sleep(10);
                            const [row] = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                            return row || undefined;
                        }
                    }
                );
                await cache.init();
                return cache;
            }
        ));
        await sleep(5000);

        // Strategy C: Caching with New Features (Single-flight Coalescing & Batch Loading)
        results.push(await runBenchmarkStrategy(
            `${prefix}New Caching Logic (Single-flight Coalescing & Batch Loading enabled)`,
            async (trackedSql) => {
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
                        }
                    }
                );
                await cache.init();
                return cache;
            }
        ));

        if (r < rounds) {
            await sleep(5000);
        }
    }

    console.log(`\n======================================================`);
    console.log(`NEW VS OLD FEATURES BENCHMARK COMPARISON (${rounds} ROUNDS)`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Avg Throughput': `${r.avgThroughput} rps`,
        'p50 Latency': `${r.p50}ms`,
        'p95 Latency': `${r.p95}ms`,
        'p99 Latency': `${r.p99}ms`,
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
