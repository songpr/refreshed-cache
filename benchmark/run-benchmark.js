const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, measureMemory } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// Increase max connections for higher concurrency pipelining in postgres driver
const sql = postgres(connectionString, { max: 50 });

const DB_ROWS = 10000000;

// Each scenario is isolated in its own process (see lib/isolated-runner.js).
const SCENARIOS = [
    { key: 'small', label: 'Small Cache (1% coverage)', cacheSize: 10000 },
    { key: 'medium', label: 'Medium Cache (10% coverage)', cacheSize: 100000 },
    { key: 'large', label: 'Large Cache (50% coverage)', cacheSize: 500000 },
];

async function runScenario(scenarioName, cacheSize, dbRowsCount, totalQueries = 50000, batchConcurrency = 1000) {
    console.log(`\n======================================================`);
    console.log(`SCENARIO: ${scenarioName}`);
    console.log(`Cache Size: ${cacheSize} | DB Rows: ${dbRowsCount}`);
    console.log(`======================================================`);

    // 1. Fetch keys from DB to construct our query sets
    console.log('Fetching keys for queries...');

    // We get keys that are definitely cached (within the first `cacheSize` records)
    const cachedRows = await sql`SELECT uuid FROM users ORDER BY id ASC LIMIT ${cacheSize}`;
    const cachedKeys = cachedRows.map(r => r.uuid);

    // We get keys that exist in DB but are not cached (after `cacheSize`)
    const uncachedRows = await sql`SELECT uuid FROM users WHERE id > ${cacheSize} ORDER BY id ASC LIMIT ${cacheSize}`;
    const uncachedKeys = uncachedRows.map(r => r.uuid);

    // Generate random queries mix: 70% cache hits, 25% cache misses (exist in DB), 5% hard misses (not in DB)
    const queryKeys = [];
    for (let i = 0; i < totalQueries; i++) {
        const rand = Math.random();
        if (rand < 0.70 && cachedKeys.length > 0) {
            queryKeys.push(cachedKeys[Math.floor(Math.random() * cachedKeys.length)]);
        } else if (rand < 0.95 && uncachedKeys.length > 0) {
            queryKeys.push(uncachedKeys[Math.floor(Math.random() * uncachedKeys.length)]);
        } else {
            // Hard miss
            queryKeys.push('non-existent-uuid-' + Math.floor(Math.random() * 1000000));
        }
    }

    // Define query tracking logic
    let dbQueryCount = 0;
    const trackedSql = (queryParts, ...values) => {
        if (queryParts && Array.isArray(queryParts) && queryParts.raw) {
            dbQueryCount++;
        }
        return sql(queryParts, ...values);
    };

    // 2. Initialize Cache
    console.log('Initializing Cache...');
    const memBeforeCache = await measureMemory();

    const cache = new DataCache(
        async (recentKeys) => {
            if (recentKeys && recentKeys.length > 0) {
                // Batch fetch recent keys
                const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid IN ${sql(recentKeys)}`;
                return rows.map(r => [r.uuid, r]);
            } else {
                // Initial load
                const rows = await trackedSql`SELECT uuid, name, email, metadata FROM users ORDER BY id ASC LIMIT ${cacheSize}`;
                return rows.map(r => [r.uuid, r]);
            }
        },
        {
            max: cacheSize,
            maxAge: 300,
            refreshAge: 300,
            resetOnRefresh: false,
            passRecentKeysOnRefresh: true,
            fetchByKey: async (uuid) => {
                const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${uuid}`;
                return row || undefined;
            },
            onRefresh: (stats) => {},
            onError: (err) => { console.error(err); },
            checkValidity: (key, value) => {
                return value && typeof value === 'object' && typeof value.name === 'string';
            },
            isEqual: (a, b) => {
                return a && b && a.name === b.name && a.email === b.email;
            }
        }
    );

    const initStart = process.hrtime.bigint();
    await cache.init();
    const initDuration = Number(process.hrtime.bigint() - initStart) / 1e6;
    const memAfterCache = await measureMemory();

    console.log(`Cache initialized in ${initDuration.toFixed(0)}ms. Memory overhead: Heap +${(memAfterCache.heapUsed - memBeforeCache.heapUsed).toFixed(2)} MB, RSS +${(memAfterCache.rss - memBeforeCache.rss).toFixed(2)} MB`);

    // 3. Run Benchmark against Direct DB (No Cache)
    console.log(`\nRunning Direct Prepared Statements (No Cache) with ${totalQueries} operations...`);
    dbQueryCount = 0;
    const dbStart = process.hrtime.bigint();
    let dbSuccessCount = 0;

    // We execute queries in batches using Promise.all to leverage pipelining
    for (let i = 0; i < queryKeys.length; i += batchConcurrency) {
        const batch = queryKeys.slice(i, i + batchConcurrency);
        const promises = batch.map(async (key) => {
            const [row] = await trackedSql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
            return row;
        });
        const results = await Promise.all(promises);
        dbSuccessCount += results.filter(Boolean).length;
    }
    const dbDuration = Number(process.hrtime.bigint() - dbStart) / 1e6;
    const dbOpsPerSec = Math.round((totalQueries / dbDuration) * 1000);
    const dbQueriesDirect = dbQueryCount;

    console.log(`Direct Prepared Statements (No Cache): ${dbDuration.toFixed(0)}ms (${dbOpsPerSec} ops/sec) | Hits found: ${dbSuccessCount} | DB Queries: ${dbQueriesDirect}`);

    // 4. Run Benchmark against Cache
    console.log(`\nRunning Cache queries with ${totalQueries} operations...`);
    dbQueryCount = 0;
    const cacheStart = process.hrtime.bigint();
    let cacheSuccessCount = 0;
    let correctnessFailed = false;

    for (let i = 0; i < queryKeys.length; i += batchConcurrency) {
        const batch = queryKeys.slice(i, i + batchConcurrency);
        const promises = batch.map(async (key) => {
            const cachedVal = await cache.getOrFetch(key);

            // Correctness check: verify against DB on a sample basis (1% of queries)
            if (Math.random() < 0.01) {
                const [dbVal] = await sql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
                if (dbVal && !cachedVal) {
                    correctnessFailed = true;
                } else if (!dbVal && cachedVal) {
                    correctnessFailed = true;
                } else if (dbVal && cachedVal && (dbVal.name !== cachedVal.name || dbVal.email !== cachedVal.email)) {
                    correctnessFailed = true;
                }
            }
            return cachedVal;
        });
        const results = await Promise.all(promises);
        cacheSuccessCount += results.filter(Boolean).length;
    }
    const cacheDuration = Number(process.hrtime.bigint() - cacheStart) / 1e6;
    const cacheOpsPerSec = Math.round((totalQueries / cacheDuration) * 1000);
    const dbQueriesCache = dbQueryCount;

    console.log(`Cache: ${cacheDuration.toFixed(0)}ms (${cacheOpsPerSec} ops/sec) | Hits found: ${cacheSuccessCount} | DB Queries: ${dbQueriesCache}`);
    console.log(`Correctness Check: ${correctnessFailed ? '❌ FAILED' : '✅ PASSED'}`);

    const m = cache.metrics;
    const isOpsValid = (m.hits + m.misses === totalQueries);
    const expectedDBQueries = (m.refreshes || 0) + (m.misses - m.coalescedFetches);
    const isDbQueriesValid = (dbQueriesCache <= expectedDBQueries);
    console.log(`[Metrics Validation] Total Ops: ${totalQueries} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);
    console.log(`[Metrics Validation] DB Queries: ${dbQueriesCache} | Expected: ${expectedDBQueries} (Match: ${isDbQueriesValid ? '✅' : '❌'}, saved ${expectedDBQueries - dbQueriesCache} by miss-cache)`);
    console.log(`[Metrics Validation] Metrics: Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations}`);

    // Clean up
    await cache.close();

    return {
        scenario: scenarioName,
        cacheSize,
        initDurationMs: Math.round(initDuration),
        dbDurationMs: Math.round(dbDuration),
        dbOpsPerSec,
        dbQueriesDirect,
        cacheDurationMs: Math.round(cacheDuration),
        cacheOpsPerSec,
        dbQueriesCache,
        speedup: (dbDuration / cacheDuration).toFixed(2),
        correctness: !correctnessFailed ? 'PASSED' : 'FAILED',
        cacheMemoryHeapMB: (memAfterCache.heapUsed - memBeforeCache.heapUsed).toFixed(2),
        cacheMemoryRssMB: (memAfterCache.rss - memBeforeCache.rss).toFixed(2)
    };
}

async function warmup() {
    let retries = 5;
    while (retries > 0) {
        try {
            await sql`SELECT 1`;
            break;
        } catch (e) {
            console.log('Waiting for database connection...');
            await sleep(2000);
            retries--;
        }
    }
    console.log('Warming up connections...');
    await Promise.all(Array.from({ length: 30 }, () => sql`SELECT 1`));
}

async function main() {
    const rounds = parseInt(getArg('rounds', '1'), 10);

    // CHILD MODE: a single scenario in a fresh, isolated process.
    if (isChild) {
        const key = getArg('strategy');
        const round = parseInt(getArg('round', '1'), 10);
        const sc = SCENARIOS.find(s => s.key === key);
        if (!sc) throw new Error(`Unknown scenario key: ${key}`);
        const prefix = rounds > 1 ? `[Round ${round}] ` : '';
        await warmup();
        const result = await runScenario(`${prefix}${sc.label}`, sc.cacheSize, DB_ROWS);
        emitResult(result);
        await sql.end();
        return;
    }

    // PARENT MODE: fork one fresh process per (round, scenario).
    const results = await orchestrate({
        scriptPath: __filename,
        strategyKeys: SCENARIOS.map(s => s.key),
        rounds,
        passArgs: process.argv.slice(2),
    });

    console.log(`\n======================================================`);
    console.log(`SUMMARY RESULTS (${rounds} ROUNDS, process-isolated)`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Scenario': r.scenario,
        'Cache Size': r.cacheSize,
        'Init Time (ms)': r.initDurationMs,
        'DB Ops/sec': r.dbOpsPerSec,
        'DB Queries Direct': r.dbQueriesDirect,
        'Cache Ops/sec': r.cacheOpsPerSec,
        'DB Queries Cache': r.dbQueriesCache,
        'Speedup': `${r.speedup}x`,
        'Correctness': r.correctness,
        'Heap Mem (MB)': r.cacheMemoryHeapMB,
        'RSS Mem (MB)': r.cacheMemoryRssMB
    })));

    await sql.end();
}

main().catch(err => {
    console.error('Benchmark error:', err);
    process.exit(1);
});
