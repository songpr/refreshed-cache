const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, measureMemory, percentiles } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');

// Measures the DB-query reduction from miss-cache (Pattern D: Cache Penetration Protection).
//
// Workload: a fixed pool of 5,000 bogus keys (non-existent in DB) is repeatedly requested
// alongside 95% valid-key traffic. Without miss-cache, every bogus lookup fires a DB query.
// With miss-cache enabled, the second and subsequent lookups for each bogus key are absorbed
// in memory — zero DB queries.
//
// Two strategies are compared:
//   "no-miss-cache"  — maxMiss: 0 (disabled, every hard miss hits the DB)
//   "miss-cache"     — maxMiss: 10000, maxAgeMiss: 60 (absorbs repeat bogus lookups)

const TOTAL_DURATION_SEC = parseInt(getArg('duration', '30'), 10);
const BOGUS_POOL_SIZE = 5000;

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
const sql = postgres(connectionString, { max: 50 });

const STRATEGIES = [
    {
        key: 'direct',
        label: 'Direct Prepared Statements (No Cache)',
        setup: async () => null,
    },
    {
        key: 'no-miss-cache',
        label: 'Cache — Miss Protection Disabled (maxMiss: 0)',
        setup: async (trackedSql) => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 100000,
                    maxAge: 300,
                    refreshAge: 300,
                    resetOnRefresh: false,
                    maxMiss: 0,
                    fetchByKey: async (key) => {
                        const [row] = await trackedSql`SELECT uuid, name FROM users WHERE uuid = ${key}`;
                        return row || undefined;
                    },
                }
            );
            await cache.init();
            return cache;
        },
    },
    {
        key: 'miss-cache',
        label: 'Cache — Miss Protection Enabled (maxMiss: 10000, maxAgeMiss: 60)',
        setup: async (trackedSql) => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 100000,
                    maxAge: 300,
                    refreshAge: 300,
                    resetOnRefresh: false,
                    maxMiss: 10000,
                    maxAgeMiss: 60,
                    fetchByKey: async (key) => {
                        const [row] = await trackedSql`SELECT uuid, name FROM users WHERE uuid = ${key}`;
                        return row || undefined;
                    },
                }
            );
            await cache.init();
            return cache;
        },
    },
];

async function runBenchmarkStrategy(name, setupCacheFn) {
    console.log(`\n======================================================`);
    console.log(`RUNNING STRATEGY: ${name}`);
    console.log(`Duration: ${TOTAL_DURATION_SEC}s | Bogus pool: ${BOGUS_POOL_SIZE} keys`);
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

    // Fetch 50,000 real UUIDs and build a fixed pool of bogus keys.
    const allRows = await sql`SELECT uuid FROM users LIMIT 50000`;
    const validUuids = allRows.map(r => r.uuid);
    const bogusKeys = Array.from({ length: BOGUS_POOL_SIZE }, (_, i) => `bogus-key-${i}`);

    if (validUuids.length === 0) throw new Error('Database empty — run seed.js first.');

    const startTime = Date.now();
    let totalRequests = 0;
    let isRunning = true;
    let intervalLatencies = [];
    let intervalRequests = 0;

    const statsHistory = [];

    const runWorker = async () => {
        const batchSize = 50;
        const targetQps = 500;
        const intervalMs = (batchSize / targetQps) * 1000;

        while (isRunning) {
            const batchStart = Date.now();

            const promises = Array.from({ length: batchSize }, async () => {
                const qStart = process.hrtime.bigint();

                // Traffic mix: 5% bogus (penetration attack pattern — always same bounded pool),
                // 95% valid keys.
                const isBogus = Math.random() < 0.05;
                const key = isBogus
                    ? bogusKeys[Math.floor(Math.random() * bogusKeys.length)]
                    : validUuids[Math.floor(Math.random() * validUuids.length)];

                if (cache) {
                    await cache.getOrFetch(key);
                } else {
                    await trackedSql`SELECT uuid, name FROM users WHERE uuid = ${key}`;
                }

                const qDiff = Number(process.hrtime.bigint() - qStart) / 1e6;
                intervalLatencies.push(qDiff);
                intervalRequests++;
            });

            await Promise.all(promises);

            const sleepTime = intervalMs - (Date.now() - batchStart);
            if (sleepTime > 0) await sleep(sleepTime);
        }
    };

    const workerPromises = Array.from({ length: 4 }, () => runWorker());

    const totalIntervals = Math.max(1, Math.round(TOTAL_DURATION_SEC / 10));
    const intervalSec = Math.floor(TOTAL_DURATION_SEC / totalIntervals);

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

        console.log(`[${t * intervalSec}s] Throughput: ${throughput} rps | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${intervalDbQueries} | Heap: ${mem.heapUsed} MB`);

        statsHistory.push({
            elapsed: t * intervalSec,
            throughput,
            p50: pct.p50,
            p95: pct.p95,
            p99: pct.p99,
            dbQueries: intervalDbQueries,
            heap: mem.heapUsed,
        });
    }

    isRunning = false;
    await Promise.all(workerPromises);

    if (cache) await cache.close();

    const finalMem = await measureMemory();

    return {
        name,
        statsHistory,
        totalDBQueries,
        peakHeapMB: Math.max(...statsHistory.map(h => parseFloat(h.heap))).toFixed(2),
        baseHeapMB: baseMem.heapUsed,
        afterCleanupHeapMB: finalMem.heapUsed,
        p50: statsHistory[statsHistory.length - 1].p50,
        p95: statsHistory[statsHistory.length - 1].p95,
        p99: statsHistory[statsHistory.length - 1].p99,
        avgThroughput: Math.round(statsHistory.reduce((a, b) => a + b.throughput, 0) / statsHistory.length),
    };
}

async function warmup() {
    await Promise.all(Array.from({ length: 10 }, () => sql`SELECT 1`));
}

async function main() {
    const rounds = parseInt(getArg('rounds', '1'), 10);

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

    const results = await orchestrate({
        scriptPath: __filename,
        strategyKeys: STRATEGIES.map(s => s.key),
        rounds,
        passArgs: process.argv.slice(2),
    });

    console.log(`\n======================================================`);
    console.log(`MISS CACHE BENCHMARK (${rounds} ROUNDS, process-isolated)`);
    console.log(`Bogus key pool: ${BOGUS_POOL_SIZE} fixed keys | 5% bogus traffic`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Avg Throughput': `${r.avgThroughput} rps`,
        'p50 Latency': `${r.p50}ms`,
        'p95 Latency': `${r.p95}ms`,
        'p99 Latency': `${r.p99}ms`,
        'Total DB Queries': r.totalDBQueries,
        'Peak Heap (MB)': r.peakHeapMB,
        'Base Heap (MB)': r.baseHeapMB,
        'Heap Growth (MB)': (r.peakHeapMB - r.baseHeapMB).toFixed(2),
    })));

    await sql.end();
}

main().catch(err => {
    console.error('Benchmark execution error:', err);
    process.exit(1);
});
