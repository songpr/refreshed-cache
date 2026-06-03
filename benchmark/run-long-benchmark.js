const postgres = require('postgres');
const DataCache = require('../index.js');

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
const sql = postgres(connectionString, { max: 50 });

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

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function runStrategySimulation(name, setupCacheFn, durationSec = 80, intervalSec = 10) {
    console.log(`\n======================================================`);
    console.log(`SIMULATING STRATEGY: ${name}`);
    console.log(`Duration: ${durationSec}s | Interval: ${intervalSec}s | Ceiling: 100,000 keys`);
    console.log(`======================================================`);

    // Warm up GC and record base memory
    getMemoryUsage();
    await sleep(500);
    const baseMem = getMemoryUsage();
    console.log(`Base Memory: Heap ${baseMem.heapUsed} MB | RSS ${baseMem.rss} MB`);

    // Setup the cache
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
    
    // Fetch 150,000 valid UUIDs from DB to use as our universe
    const allRows = await sql`SELECT uuid FROM users LIMIT 150000`;
    const uuidsUniverse = allRows.map(r => r.uuid);

    if (uuidsUniverse.length === 0) {
        throw new Error('Database is empty! Run node benchmark/seed.js first.');
    }

    let totalHits = 0;
    let totalRequests = 0;
    let correctnessFailed = false;
    const history = [];

    const startTime = Date.now();
    const totalIntervals = durationSec / intervalSec;

    let intervalLatencies = [];
    let intervalRequests = 0;
    let intervalHits = 0;

    for (let t = 0; t < totalIntervals; t++) {
        const intervalStart = Date.now();
        
        // Define active/hot pool for this interval (sliding window of 120,000 keys to fill the 100,000 cache capacity)
        const windowSize = 120000;
        const windowStart = (t * 2000) % (uuidsUniverse.length - windowSize);
        const hotPool = uuidsUniverse.slice(windowStart, windowStart + windowSize);

        // Perform concurrent query batches
        // We query 20,000 keys per 10s interval in batches of 100
        const queriesPerInterval = 20000;
        const batchSize = 100;
        
        for (let i = 0; i < queriesPerInterval; i += batchSize) {
            const batch = Array.from({ length: batchSize }, () => {
                const rand = Math.random();
                if (rand < 0.85 && hotPool.length > 0) {
                    return hotPool[Math.floor(Math.random() * hotPool.length)];
                } else if (rand < 0.95) {
                    return uuidsUniverse[Math.floor(Math.random() * uuidsUniverse.length)];
                } else {
                    return 'non-existent-uuid-' + Math.floor(Math.random() * 1000000);
                }
            });

            const qStart = process.hrtime.bigint();
            let results;
            if (cache) {
                results = await cache.getOrFetchMany(batch);
            } else {
                // Direct Prepared Statement query (batch select)
                const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid IN ${sql(batch)}`;
                results = {};
                rows.forEach(r => { results[r.uuid] = r; });
            }
            const qDiff = Number(process.hrtime.bigint() - qStart) / 1e6; // to ms
            
            // Storing approximate single-query latency from batch
            intervalLatencies.push(...Array(batch.length).fill(qDiff / batch.length));
            
            const hitCount = Object.keys(results).length;
            intervalHits += hitCount;
            intervalRequests += batch.length;
        }

        totalHits += intervalHits;
        totalRequests += intervalRequests;

        const currentHitRate = ((totalHits / totalRequests) * 100).toFixed(1);
        const latencies = [...intervalLatencies].sort((a, b) => a - b);
        intervalLatencies = [];

        const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.50)].toFixed(2) : '0.00';
        const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)].toFixed(2) : '0.00';
        const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)].toFixed(2) : '0.00';
        const throughput = Math.round(intervalRequests / intervalSec);
        
        intervalHits = 0;
        intervalRequests = 0;
        
        const mem = getMemoryUsage();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const cacheSizeStr = cache ? cache.size : 'N/A';
        console.log(`[t=${elapsed}s] Cache Size: ${cacheSizeStr} | Throughput: ${throughput} rps | Hit Rate: ${currentHitRate}% | p50: ${p50}ms, p95: ${p95}ms, p99: ${p99}ms | DB Queries: ${dbQueryCount} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);
        
        history.push({
            elapsed,
            cacheSize: cacheSizeStr,
            hitRate: currentHitRate,
            throughput,
            p50,
            p95,
            p99,
            dbQueries: dbQueryCount,
            heap: mem.heapUsed,
            rss: mem.rss
        });

        dbQueryCount = 0;

        const timeToSleep = (intervalSec * 1000) - (Date.now() - intervalStart);
        if (timeToSleep > 0) {
            await sleep(timeToSleep);
        }
    }

    // Correctness validation after heavy load
    if (cache) {
        console.log('Auditing cache correctness post-load...');
        let auditSuccessCount = 0;
        let auditTotal = 0;
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

    // Cleanup cache
    if (cache) {
        await cache.close();
    }
    await sleep(1500);

    const finalMem = getMemoryUsage();
    return {
        name,
        history,
        finalHitRate: ((totalHits / totalRequests) * 100).toFixed(1),
        peakHeapMB: Math.max(...history.map(h => parseFloat(h.heap))).toFixed(2),
        peakRssMB: Math.max(...history.map(h => parseFloat(h.rss))).toFixed(2),
        baseHeapMB: baseMem.heapUsed,
        baseRssMB: baseMem.rss,
        afterCleanupHeapMB: finalMem.heapUsed,
        afterCleanupRssMB: finalMem.rss,
        p50: history[history.length - 1].p50,
        p95: history[history.length - 1].p95,
        p99: history[history.length - 1].p99,
        avgThroughput: Math.round(history.reduce((a, b) => a + b.throughput, 0) / history.length),
        totalDBQueries,
        correctness: !correctnessFailed ? '✅ PASSED' : '❌ FAILED'
    };
}

async function main() {
    // Parse arguments
    const args = process.argv.slice(2);
    const roundsArg = args.find(arg => arg.startsWith('--rounds='));
    const rounds = roundsArg ? parseInt(roundsArg.split('=')[1], 10) : 1;

    const durationArg = args.find(arg => arg.startsWith('--duration='));
    const duration = durationArg ? parseInt(durationArg.split('=')[1], 10) : 80;
    const interval = Math.min(10, duration);

    // Warm up database
    await Promise.all(Array.from({ length: 15 }, () => sql`SELECT 1`));

    const results = [];

    for (let r = 1; r <= rounds; r++) {
        const prefix = rounds > 1 ? `[Round ${r}] ` : '';
        console.log(`\n\n=== ROUND ${r} OF ${rounds} ===`);

        // Direct Prepared Statements (No Cache)
        const runBaseline = () => runStrategySimulation(
            `${prefix}Direct Prepared Statements (No Cache)`,
            async () => null,
            duration,
            interval
        );

        // Strategy A: Scheduled Full Refresh (max: 100000)
        const runFullRefresh = () => runStrategySimulation(
            `${prefix}Strategy A: Scheduled Full Refresh`,
            async (trackedSql) => {
                const cache = new DataCache(
                    async (recentKeys) => {
                        const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users ORDER BY id ASC LIMIT 100000`;
                        return rows.map(r => [r.uuid, r]);
                    },
                    {
                        max: 100000,
                        maxAge: 15,
                        refreshAge: 15,
                        resetOnRefresh: true,
                        fetchByKey: async (key) => {
                            const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                            return row || undefined;
                        }
                    }
                );
                await cache.init();
                return cache;
            },
            duration,
            interval
        );

        // Strategy B: Lazy Fetch-on-Miss (max: 100000)
        const runLazyFetch = () => runStrategySimulation(
            `${prefix}Strategy B: Lazy Fetch-on-Miss`,
            async (trackedSql) => {
                const cache = new DataCache(
                    async () => [],
                    {
                        max: 100000,
                        maxAge: 15,
                        refreshAge: 15,
                        resetOnRefresh: false,
                        fetchByKey: async (key) => {
                            const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                            return row || undefined;
                        }
                    }
                );
                await cache.init();
                return cache;
            },
            duration,
            interval
        );

        // Strategy C: Active-Only Refresh (max: 100000)
        const runActiveOnly = () => runStrategySimulation(
            `${prefix}Strategy C: Active-Only Refresh`,
            async (trackedSql) => {
                const cache = new DataCache(
                    async (recentKeys) => {
                        if (recentKeys && recentKeys.length > 0) {
                            const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid IN ${trackedSql(recentKeys)}`;
                            return rows.map(r => [r.uuid, r]);
                        }
                        return [];
                    },
                    {
                        max: 100000,
                        maxAge: 15,
                        refreshAge: 15,
                        resetOnRefresh: false,
                        passRecentKeysOnRefresh: true,
                        fetchByKeys: async (keys) => {
                            const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid IN ${trackedSql(keys)}`;
                            return rows.map(r => [r.uuid, r]);
                        },
                        fetchByKey: async (key) => {
                            const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                            return row || undefined;
                        }
                    }
                );
                await cache.init();
                return cache;
            },
            duration,
            interval
        );

        results.push(await runBaseline());
        await sleep(3000);

        results.push(await runFullRefresh());
        await sleep(3000);
        
        results.push(await runLazyFetch());
        await sleep(3000);
        
        results.push(await runActiveOnly());

        if (r < rounds) {
            await sleep(5000);
        }
    }

    console.log(`\n======================================================`);
    console.log(`LONG RUNNING BENCHMARK SUMMARY & ROI ANALYSIS (${rounds} ROUNDS)`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Hit Rate': r.name.includes('No Cache') ? '0%' : `${r.finalHitRate}%`,
        'Avg Throughput': `${r.avgThroughput} rps`,
        'p50 Latency': `${r.p50}ms`,
        'p95 Latency': `${r.p95}ms`,
        'p99 Latency': `${r.p99}ms`,
        'DB Queries': r.totalDBQueries,
        'Peak Heap (MB)': r.peakHeapMB,
        'Base Heap (MB)': r.baseHeapMB,
        'Heap Growth (MB)': (r.peakHeapMB - r.baseHeapMB).toFixed(2),
        'Cleaned Heap (MB)': r.afterCleanupHeapMB,
        'Correctness': r.name.includes('No Cache') ? 'N/A' : r.correctness
    })));

    await sql.end();
}

main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
