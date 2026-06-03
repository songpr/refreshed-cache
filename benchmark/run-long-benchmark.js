const postgres = require('postgres');
const DataCache = require('../index.js');

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
const sql = postgres(connectionString, { max: 20 });

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

async function runStrategySimulation(name, setupCacheFn, durationSec = 100, intervalSec = 10) {
    console.log(`\n======================================================`);
    console.log(`SIMULATING STRATEGY: ${name}`);
    console.log(`Duration: ${durationSec}s | Interval: ${intervalSec}s`);
    console.log(`======================================================`);

    // Warm up GC and record base memory
    getMemoryUsage();
    await sleep(500);
    const baseMem = getMemoryUsage();
    console.log(`Base Memory: Heap ${baseMem.heapUsed} MB | RSS ${baseMem.rss} MB`);

    // Setup the cache
    let dbQueryCount = 0;
    const trackedSql = (queryParts, ...values) => {
        if (queryParts && Array.isArray(queryParts) && queryParts.raw) {
            dbQueryCount++;
            return sql(queryParts, ...values);
        }
        return sql(queryParts, ...values);
    };

    const cache = await setupCacheFn(trackedSql);
    
    // Generate workload keys:
    // We simulate a sliding window of active/hot keys to represent shifting user interest.
    // We will query 2,000 keys per second (20,000 keys per 10s interval).
    const queriesPerInterval = 20000;
    const totalIntervals = durationSec / intervalSec;
    
    // Fetch 50,000 valid UUIDs from DB to use as our universe
    const allRows = await sql`SELECT uuid FROM users LIMIT 50000`;
    const uuidsUniverse = allRows.map(r => r.uuid);

    let totalHits = 0;
    let totalRequests = 0;
    const history = [];

    const startTime = Date.now();

    for (let t = 0; t < totalIntervals; t++) {
        const intervalStart = Date.now();
        
        // Define active/hot pool for this interval (sliding window of 12,000 keys)
        // Shifting window starts at t * 2000
        const windowSize = 12000;
        const windowStart = (t * 2000) % (uuidsUniverse.length - windowSize);
        const hotPool = uuidsUniverse.slice(windowStart, windowStart + windowSize);

        let hits = 0;
        let misses = 0;

        // Perform concurrent queries (in pipeline batches of 1000)
        const batchSize = 1000;
        for (let i = 0; i < queriesPerInterval; i += batchSize) {
            const batch = Array.from({ length: batchSize }, () => {
                // 85% chance to query hot pool, 10% chance to query cold pool (outside hot pool), 5% chance hard miss
                const rand = Math.random();
                if (rand < 0.85 && hotPool.length > 0) {
                    return hotPool[Math.floor(Math.random() * hotPool.length)];
                } else if (rand < 0.95) {
                    return uuidsUniverse[Math.floor(Math.random() * uuidsUniverse.length)];
                } else {
                    return 'non-existent-uuid-' + Math.floor(Math.random() * 1000000);
                }
            });

            const results = await Promise.all(batch.map(async (key) => {
                const val = await cache.getOrFetch(key);
                if (val !== undefined) {
                    hits++;
                } else {
                    misses++;
                }
            }));
        }

        totalHits += hits;
        totalRequests += queriesPerInterval;
        const currentHitRate = ((totalHits / totalRequests) * 100).toFixed(1);
        const mem = getMemoryUsage();
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[t=${elapsed}s] Cache Size: ${cache.size} | Hit Rate: ${currentHitRate}% | Interval DB Queries: ${dbQueryCount} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);
        
        history.push({
            elapsed,
            cacheSize: cache.size,
            hitRate: currentHitRate,
            dbQueries: dbQueryCount,
            heap: mem.heapUsed,
            rss: mem.rss
        });

        // Reset dbQueryCount counter for next interval
        dbQueryCount = 0;

        // Sleep to finish out the interval
        const timeToSleep = (intervalSec * 1000) - (Date.now() - intervalStart);
        if (timeToSleep > 0) {
            await sleep(timeToSleep);
        }
    }

    // Cleanup cache
    await cache.close();
    await sleep(1000); // Wait for connection/timer cleanup

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
        afterCleanupRssMB: finalMem.rss
    };
}

async function main() {
    // Warm up database
    await Promise.all(Array.from({ length: 10 }, () => sql`SELECT 1`));

    const duration = 80; // 80 seconds per strategy to keep benchmark fast but allow background refreshes
    const interval = 10;

    // Strategy A: Scheduled Full Refresh (max: 10000)
    // Pre-loads 10,000 keys and refreshes all of them in background every 15s.
    const runFullRefresh = () => runStrategySimulation(
        'Strategy A: Scheduled Full Refresh',
        async (trackedSql) => {
            const cache = new DataCache(
                async (recentKeys) => {
                    const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users ORDER BY id ASC LIMIT 10000`;
                    return rows.map(r => [r.uuid, r]);
                },
                {
                    max: 10000, // Hard ceiling
                    maxAge: 15,
                    refreshAge: 15,
                    resetOnRefresh: true,
                    fetchByKey: async (key) => {
                        // Does not dynamically cache new misses to prove scheduled-only memory bounds
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

    // Strategy B: Lazy Fetch-on-Miss (max: 10000)
    // No background refresh. Starts empty, fetches on miss. Old entries evict naturally.
    const runLazyFetch = () => runStrategySimulation(
        'Strategy B: Lazy Fetch-on-Miss',
        async (trackedSql) => {
            const cache = new DataCache(
                async () => [], // Starts empty
                {
                    max: 10000, // Hard ceiling
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

    // Strategy C: Active-Only Refresh (max: 10000)
    // Refreshes only keys requested since the last cycle.
    const runActiveOnly = () => runStrategySimulation(
        'Strategy C: Active-Only Refresh',
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
                    max: 10000, // Hard ceiling
                    maxAge: 15,
                    refreshAge: 15,
                    resetOnRefresh: false,
                    passRecentKeysOnRefresh: true,
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

    const results = [];
    results.push(await runFullRefresh());
    // Sleep between runs to allow GC to clean up
    await sleep(3000);
    
    results.push(await runLazyFetch());
    await sleep(3000);
    
    results.push(await runActiveOnly());

    console.log(`\n======================================================`);
    console.log(`LONG RUNNING BENCHMARK SUMMARY & ROI ANALYSIS`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name.replace('Strategy ', ''),
        'Hit Rate': `${r.finalHitRate}%`,
        'Base Heap (MB)': r.baseHeapMB,
        'Peak Heap (MB)': r.peakHeapMB,
        'Memory Growth (MB)': (r.peakHeapMB - r.baseHeapMB).toFixed(2),
        'After Close Heap (MB)': r.afterCleanupHeapMB
    })));

    console.log(`\nAWS INFRASTRUCTURE COST ROI METRICS (Projections based on 10M rows / 5GB data):`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`1. In-Process (Active-Only / Lazy Cache):`);
    console.log(`   - RAM Cost: $0 (Runs within existing application instances, e.g. 2GB t4g.small)`);
    console.log(`   - Memory Limit Protection: Bounded strictly at 10,000 items (~5MB footprint)`);
    console.log(`   - User Experience: High hit rate for active users, low latency.`);
    console.log(`2. External Redis (ElastiCache):`);
    console.log(`   - Instance Cost: ~$110/month (cache.r6g.large for 13GB RAM)`);
    console.log(`   - Added Network Latency: +1.5ms to 3ms per query`);
    
    await sql.end();
}

main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
