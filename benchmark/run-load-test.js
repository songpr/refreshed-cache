const postgres = require('postgres');
const DataCache = require('../index.js');

// Parse duration from args (e.g., node run-load-test.js --duration=600)
const args = process.argv.slice(2);
const durationArg = args.find(arg => arg.startsWith('--duration='));
const TOTAL_DURATION_SEC = durationArg ? parseInt(durationArg.split('=')[1], 10) : 600; // Default 10 mins (600s)

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// Higher pool size to support concurrent pipelined load test
const sql = postgres(connectionString, { max: 100 });

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

async function runLoadTestStrategy(name, setupCacheFn) {
    console.log(`\n======================================================`);
    console.log(`LOAD TEST STRATEGY: ${name}`);
    console.log(`Duration: ${TOTAL_DURATION_SEC}s | Interval stats: 30s`);
    console.log(`======================================================`);

    getMemoryUsage();
    await sleep(500);
    const baseMem = getMemoryUsage();
    console.log(`Base Memory: Heap ${baseMem.heapUsed} MB | RSS ${baseMem.rss} MB`);

    let dbQueryCount = 0;
    const trackedSql = (queryParts, ...values) => {
        if (queryParts && Array.isArray(queryParts) && queryParts.raw) {
            dbQueryCount++;
            return sql(queryParts, ...values);
        }
        return sql(queryParts, ...values);
    };

    const cache = await setupCacheFn(trackedSql);

    // Load UUID universe
    const allRows = await sql`SELECT uuid FROM users LIMIT 100000`;
    const uuidsUniverse = allRows.map(r => r.uuid);

    const startTime = Date.now();
    let totalRequests = 0;
    let totalHits = 0;
    let correctnessFailed = false;

    const intervalSec = 30;
    const statsHistory = [];

    // Run query generation loop
    let isRunning = true;
    let intervalLatencies = [];
    let intervalHits = 0;
    let intervalRequests = 0;

    // A background worker loop pushing constant traffic
    const runWorker = async () => {
        const batchSize = 100;
        const targetQps = 1500; // Simulating 1,500 requests per second
        const intervalMs = (batchSize / targetQps) * 1000;

        while (isRunning) {
            const batchStart = Date.now();

            // Sliding window of hot keys (simulates real shifting traffic over 10 minutes)
            const elapsedTimeSec = (Date.now() - startTime) / 1000;
            const windowSize = 15000;
            const windowStart = Math.floor(elapsedTimeSec * 100) % (uuidsUniverse.length - windowSize);
            const hotPool = uuidsUniverse.slice(windowStart, windowStart + windowSize);

            const promises = Array.from({ length: batchSize }, async () => {
                const rand = Math.random();
                let key;
                if (rand < 0.80 && hotPool.length > 0) {
                    key = hotPool[Math.floor(Math.random() * hotPool.length)];
                } else if (rand < 0.95) {
                    key = uuidsUniverse[Math.floor(Math.random() * uuidsUniverse.length)];
                } else {
                    key = 'non-existent-uuid-' + Math.floor(Math.random() * 1000000);
                }

                const qStart = process.hrtime.bigint();
                let val;
                
                if (cache) {
                    val = await cache.getOrFetch(key);
                } else {
                    // Direct Prepared Statement query
                    const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                    val = row;
                }

                const qDiff = Number(process.hrtime.bigint() - qStart) / 1e6; // Convert nanoseconds to milliseconds
                intervalLatencies.push(qDiff);
                
                intervalRequests++;
                if (val !== undefined) {
                    intervalHits++;
                    
                    // Periodic sample correctness check (0.1% of queries)
                    if (Math.random() < 0.001) {
                        const [dbVal] = await sql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                        if (!dbVal || dbVal.name !== val.name || dbVal.email !== val.email) {
                            correctnessFailed = true;
                        }
                    }
                }
            });

            await Promise.all(promises);

            const sleepTime = intervalMs - (Date.now() - batchStart);
            if (sleepTime > 0) {
                await sleep(sleepTime);
            }
        }
    };

    // Start worker(s)
    const workerPromises = Array.from({ length: 4 }, () => runWorker());

    // Monitor loop reporting stats every 30s
    const totalIntervals = TOTAL_DURATION_SEC / intervalSec;
    for (let t = 1; t <= totalIntervals; t++) {
        await sleep(intervalSec * 1000);

        const latencies = [...intervalLatencies].sort((a, b) => a - b);
        intervalLatencies = [];

        const hits = intervalHits;
        const requests = intervalRequests;
        intervalHits = 0;
        intervalRequests = 0;

        totalHits += hits;
        totalRequests += requests;

        const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.50)].toFixed(2) : '0.00';
        const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)].toFixed(2) : '0.00';
        const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)].toFixed(2) : '0.00';
        const avg = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2) : '0.00';
        const throughput = Math.round(requests / intervalSec);
        const mem = getMemoryUsage();

        console.log(`[${t * intervalSec}s] Ops: ${throughput}/sec | Hit Rate: ${((hits / requests) * 100).toFixed(1)}% | p50: ${p50}ms, p95: ${p95}ms, p99: ${p99}ms | DB Queries: ${dbQueryCount} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);

        statsHistory.push({
            elapsed: t * intervalSec,
            throughput,
            hitRate: ((hits / requests) * 100).toFixed(1),
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
        correctness: !correctnessFailed ? 'PASSED' : 'FAILED',
        avgThroughput: Math.round(statsHistory.reduce((a, b) => a + b.throughput, 0) / statsHistory.length)
    };
}

async function main() {
    // Warm up DB
    await Promise.all(Array.from({ length: 10 }, () => sql`SELECT 1`));

    const results = [];

    // Strategy 1: Direct Prepared Statements (No Cache)
    results.push(await runLoadTestStrategy(
        'Direct Prepared Statements (No Cache)',
        async () => null
    ));
    await sleep(5000);

    // Strategy 2: Lazy Fetch-on-Miss (max: 10000)
    results.push(await runLoadTestStrategy(
        'Lazy Fetch-on-Miss (max: 10000)',
        async (trackedSql) => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 10000,
                    maxAge: 30,
                    refreshAge: 30,
                    resetOnRefresh: false,
                    fetchByKey: async (key) => {
                        const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                        return row || undefined;
                    }
                }
            );
            await cache.init();
            return cache;
        }
    ));
    await sleep(5000);

    // Strategy 3: Active-Only Refresh Cache (max: 10000)
    results.push(await runLoadTestStrategy(
        'Active-Only Refresh Cache (max: 10000)',
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
                    max: 10000,
                    maxAge: 30,
                    refreshAge: 30,
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
        }
    ));

    console.log(`\n======================================================`);
    console.log(`LOAD TEST RESULTS & ROI ANALYSIS`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Avg Throughput': `${r.avgThroughput} rps`,
        'p50 Latency': `${r.p50}ms`,
        'p95 Latency': `${r.p95}ms`,
        'p99 Latency': `${r.p99}ms`,
        'Hit Rate': `${r.finalHitRate}%`,
        'Peak Heap (MB)': r.peakHeapMB,
        'Base Heap (MB)': r.baseHeapMB,
        'Heap Growth (MB)': (r.peakHeapMB - r.baseHeapMB).toFixed(2),
        'Correctness': r.correctness
    })));

    await sql.end();
}

main().catch(err => {
    console.error('Load test failed:', err);
    process.exit(1);
});
