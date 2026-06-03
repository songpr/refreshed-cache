const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, measureMemory, percentiles } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');

const TOTAL_DURATION_SEC = parseInt(getArg('duration', '600'), 10); // Default 10 mins (600s)

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// Higher pool size to support concurrent pipelined load test
const sql = postgres(connectionString, { max: 100 });

// Each strategy is isolated in its own process (see lib/isolated-runner.js).
const STRATEGIES = [
    { key: 'direct', label: 'Direct Prepared Statements (No Cache)', setup: async () => null },
    {
        key: 'lazy',
        label: 'Lazy Fetch-on-Miss (max: 100000)',
        setup: async (trackedSql) => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 100000,
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
    },
    {
        key: 'active',
        label: 'Active-Only Refresh Cache (max: 100000)',
        setup: async (trackedSql) => {
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
    },
];

async function runLoadTestStrategy(name, setupCacheFn) {
    console.log(`\n======================================================`);
    console.log(`LOAD TEST STRATEGY: ${name}`);
    console.log(`Duration: ${TOTAL_DURATION_SEC}s | Interval stats: 30s | Ceiling: 100,000 keys`);
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

    // Load UUID universe
    const allRows = await sql`SELECT uuid FROM users LIMIT 150000`;
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
            const windowSize = 120000;
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
    const totalIntervals = Math.max(1, Math.round(TOTAL_DURATION_SEC / intervalSec));
    for (let t = 1; t <= totalIntervals; t++) {
        await sleep(intervalSec * 1000);

        const snapshotLatencies = intervalLatencies;
        intervalLatencies = [];
        const pct = percentiles(snapshotLatencies);

        const hits = intervalHits;
        const requests = intervalRequests;
        intervalHits = 0;
        intervalRequests = 0;

        totalHits += hits;
        totalRequests += requests;

        const throughput = Math.round(requests / intervalSec);
        const mem = await measureMemory();
        const intervalDbQueries = dbQueryCount;
        dbQueryCount = 0;

        // NOTE: "Hit Rate" here is the row-EXISTENCE rate (key was found in DB or cache),
        // NOT the pure cache-hit rate. See benchmark/README.md §8 (methodology audit).
        console.log(`[${t * intervalSec}s] Cache Size: ${cache ? cache.size : 'N/A'} | Ops: ${throughput}/sec | Row-Exist Rate: ${((hits / requests) * 100).toFixed(1)}% | p50: ${pct.p50}ms, p95: ${pct.p95}ms, p99: ${pct.p99}ms | DB Queries: ${intervalDbQueries} | Heap: ${mem.heapUsed} MB | RSS: ${mem.rss} MB`);

        statsHistory.push({
            elapsed: t * intervalSec,
            throughput,
            hitRate: ((hits / requests) * 100).toFixed(1),
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
        correctness: !correctnessFailed ? 'PASSED' : 'FAILED',
        avgThroughput: Math.round(statsHistory.reduce((a, b) => a + b.throughput, 0) / statsHistory.length)
    };
}

async function warmup() {
    await Promise.all(Array.from({ length: 10 }, () => sql`SELECT 1`));
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
        const result = await runLoadTestStrategy(`${prefix}${strat.label}`, strat.setup);
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
    console.log(`LOAD TEST RESULTS & ROI ANALYSIS (${rounds} ROUNDS, process-isolated)`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Avg Throughput': `${r.avgThroughput} rps`,
        'p50 Latency': `${r.p50}ms`,
        'p95 Latency': `${r.p95}ms`,
        'p99 Latency': `${r.p99}ms`,
        'Row-Exist Rate': `${r.finalHitRate}%`,
        'DB Queries': r.totalDBQueries,
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
