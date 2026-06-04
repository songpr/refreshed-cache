const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, measureMemory, percentiles } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');
const { makeBogusPool, selectKey, validateAttackConfig } = require('./lib/miss-cache-workload');

// Measures the DB-query reduction from miss-cache (Pattern D: Cache Penetration Protection).
//
// Workload (cache-penetration ATTACK): a fixed pool of bogus keys (non-existent in DB) is
// hammered alongside valid traffic. The bogus pool is deliberately small relative to the
// number of bogus requests, so each bogus key is requested many times — this is what gives
// miss-cache something to absorb. The valid set is PRE-WARMED before measurement so valid
// lookups are pure cache hits and the miss-cache signal is not drowned by ordinary warmup.
//
// Without miss-cache (maxMiss: 0) every bogus lookup fires a DB query. With miss-cache
// enabled, only the first lookup per bogus key hits the DB; the rest are absorbed in memory.
//
// Knobs (all overridable via --flag=value):
//   --bogusRatio=0.5   fraction of requests targeting non-existent keys (attack intensity)
//   --bogusPool=1000   number of distinct bogus keys
//   --validPool=10000  number of valid keys (pre-warmed before measurement)
//   --duration=30      measured seconds per strategy
//
// Strategies compared:
//   "direct"         — no cache, every request hits the DB (baseline)
//   "no-miss-cache"  — maxMiss: 0 (disabled, every hard miss hits the DB)
//   "miss-cache"     — maxMiss: 10000, maxAgeMiss: 60 (absorbs repeat bogus lookups)

const TOTAL_DURATION_SEC = parseInt(getArg('duration', '60'), 10);
const BOGUS_POOL_SIZE = parseInt(getArg('bogusPool', '1000'), 10);
const BOGUS_RATIO = parseFloat(getArg('bogusRatio', '0.5'));
const VALID_POOL_SIZE = parseInt(getArg('validPool', '10000'), 10);
const MAX_AGE_MISS = parseInt(getArg('maxAgeMiss', '20'), 10);

// Workers are rate-limited to ~2000 rps total (4 workers x 500 qps); use that to estimate
// total request volume and reject workloads where bogus lookups can't repeat (see module).
const EST_TOTAL_REQUESTS = 2000 * TOTAL_DURATION_SEC;

// Guard: the run duration must exceed 2× the miss-cache TTL so expiry+refill cycles are observed.
// Without this, zero-query plateaus are artifacts of the run ending before TTL fires.
if (TOTAL_DURATION_SEC < 2 * MAX_AGE_MISS) {
    throw new Error(
        `Duration ${TOTAL_DURATION_SEC}s < 2 × maxAgeMiss ${MAX_AGE_MISS}s. ` +
        `Increase duration to see full miss-cache lifecycle (fill → absorb → expire → refill cycles). ` +
        `Or shrink maxAgeMiss. Recommended: duration ≥ ${2 * MAX_AGE_MISS}s.`
    );
}

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
        label: `Cache — Miss Protection Disabled (maxMiss: 0)`,
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
                    onRefresh: (stats) => {},
                    onError: (err) => { console.error(err); },
                    checkValidity: (key, value) => {
                        return value && typeof value === 'object' && typeof value.name === 'string';
                    },
                    isEqual: (a, b) => {
                        return a && b && a.name === b.name;
                    }
                }
            );
            await cache.init();
            return cache;
        },
    },
    {
        key: 'miss-cache',
        label: `Cache — Miss Protection Enabled (maxMiss: 10000, maxAgeMiss: ${MAX_AGE_MISS})`,
        setup: async (trackedSql) => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 100000,
                    maxAge: 300,
                    refreshAge: 300,
                    resetOnRefresh: false,
                    maxMiss: 10000,
                    maxAgeMiss: MAX_AGE_MISS,
                    fetchByKey: async (key) => {
                        const [row] = await trackedSql`SELECT uuid, name FROM users WHERE uuid = ${key}`;
                        return row || undefined;
                    },
                    onRefresh: (stats) => {},
                    onError: (err) => { console.error(err); },
                    checkValidity: (key, value) => {
                        return value && typeof value === 'object' && typeof value.name === 'string';
                    },
                    isEqual: (a, b) => {
                        return a && b && a.name === b.name;
                    }
                }
            );
            await cache.init();
            return cache;
        },
    },
];

async function runBenchmarkStrategy(name, setupCacheFn) {
    const guard = validateAttackConfig({
        totalRequests: EST_TOTAL_REQUESTS,
        bogusRatio: BOGUS_RATIO,
        bogusPool: BOGUS_POOL_SIZE,
    });
    if (!guard.ok) throw new Error(`Invalid miss-cache workload — ${guard.message}`);

    console.log(`\n======================================================`);
    console.log(`RUNNING STRATEGY: ${name}`);
    console.log(`Duration: ${TOTAL_DURATION_SEC}s | Bogus: ${(BOGUS_RATIO * 100).toFixed(0)}% over ${BOGUS_POOL_SIZE} keys (${guard.repeatFactor.toFixed(1)}x repeats) | Valid pool: ${VALID_POOL_SIZE}`);
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

    // Fetch the valid key pool and build a fixed pool of bogus keys.
    const allRows = await sql`SELECT uuid FROM users LIMIT ${VALID_POOL_SIZE}`;
    const validUuids = allRows.map(r => r.uuid);
    const bogusKeys = makeBogusPool(BOGUS_POOL_SIZE);

    if (validUuids.length === 0) throw new Error('Database empty — run seed.js first.');

    // Pre-warm the valid set so valid lookups are pure cache hits during measurement.
    // This isolates the miss-cache signal from ordinary cache warmup. DB queries spent
    // here are reset out below so they don't count against the measured window.
    if (cache) {
        const batch = 200;
        for (let i = 0; i < validUuids.length; i += batch) {
            await Promise.all(validUuids.slice(i, i + batch).map(k => cache.getOrFetch(k)));
        }
        dbQueryCount = 0;
        totalDBQueries = 0;
        cache._hits = 0;
        cache._misses = 0;
        cache._refreshes = 0;
        cache._coalescedFetches = 0;
        cache._mismatches = 0;
        cache._invalidations = 0;
    }

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

                // Attack traffic mix: BOGUS_RATIO of requests target the bounded bogus pool
                // (repeated penetration attempts), the rest hit the pre-warmed valid set.
                const { key } = selectKey(Math.random, {
                    validKeys: validUuids,
                    bogusKeys,
                    bogusRatio: BOGUS_RATIO,
                });

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

        let metricsStr = '';
        if (cache && cache.metrics) {
            const m = cache.metrics;
            metricsStr = ` | Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`;
        }
        console.log(`[${t * intervalSec}s] Throughput: ${throughput} rps | p50: ${pct.p50}ms | p95: ${pct.p95}ms | p99: ${pct.p99}ms | DB Queries: ${intervalDbQueries}${metricsStr} | Heap: ${mem.heapUsed} MB`);

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
    totalRequests += intervalRequests;

    if (cache) {
        const m = cache.metrics;
        const isOpsValid = (m.hits + m.misses === totalRequests);
        console.log(`[Metrics Validation] Total Ops: ${totalRequests} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);
        console.log(`[Metrics Validation] Metrics: Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations} | Refreshes: ${m.refreshes}`);
    }

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
    console.log(`Attack: ${(BOGUS_RATIO * 100).toFixed(0)}% bogus traffic over ${BOGUS_POOL_SIZE} fixed keys | Valid pool: ${VALID_POOL_SIZE} (pre-warmed)`);
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
