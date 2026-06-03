const postgres = require('postgres');
const DataCache = require('../index.js');

const connectionString = 'postgres://benchmark_user:benchmark_password@localhost:5439/benchmark_db';
// Increase max connections for higher concurrency pipelining in postgres driver
const sql = postgres(connectionString, { max: 50 });

// Helper to get memory usage in MB
function getMemoryUsage() {
    global.gc && global.gc();
    const mem = process.memoryUsage();
    return {
        heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
        rss: (mem.rss / 1024 / 1024).toFixed(2)
    };
}

// Helper to delay
const sleep = ms => new Promise(res => setTimeout(res, ms));

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

    // 2. Initialize Cache
    console.log('Initializing Cache...');
    const memBeforeCache = getMemoryUsage();
    
    const cache = new DataCache(
        async (recentKeys) => {
            if (recentKeys && recentKeys.length > 0) {
                // Batch fetch recent keys
                const rows = await sql`SELECT uuid, name, email, metadata FROM users WHERE uuid IN ${sql(recentKeys)}`;
                return rows.map(r => [r.uuid, r]);
            } else {
                // Initial load
                const rows = await sql`SELECT uuid, name, email, metadata FROM users ORDER BY id ASC LIMIT ${cacheSize}`;
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
                const [row] = await sql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${uuid}`;
                return row || undefined;
            }
        }
    );

    const initStart = Date.now();
    await cache.init();
    const initDuration = Date.now() - initStart;
    const memAfterCache = getMemoryUsage();
    
    console.log(`Cache initialized in ${initDuration}ms. Memory overhead: Heap +${(memAfterCache.heapUsed - memBeforeCache.heapUsed).toFixed(2)} MB, RSS +${(memAfterCache.rss - memBeforeCache.rss).toFixed(2)} MB`);

    // 3. Run Benchmark against Direct DB (No Cache)
    console.log(`\nRunning direct DB queries (No Cache) with ${totalQueries} operations...`);
    const dbStart = Date.now();
    let dbSuccessCount = 0;
    
    // We execute queries in batches using Promise.all to leverage pipelining
    for (let i = 0; i < queryKeys.length; i += batchConcurrency) {
        const batch = queryKeys.slice(i, i + batchConcurrency);
        const promises = batch.map(async (key) => {
            const [row] = await sql`SELECT uuid, name, email, metadata FROM users WHERE uuid = ${key}`;
            return row;
        });
        const results = await Promise.all(promises);
        dbSuccessCount += results.filter(Boolean).length;
    }
    const dbDuration = Date.now() - dbStart;
    const dbOpsPerSec = Math.round((totalQueries / dbDuration) * 1000);
    const dbMem = getMemoryUsage();
    
    console.log(`Direct DB: ${dbDuration}ms (${dbOpsPerSec} ops/sec) | Hits found: ${dbSuccessCount}`);

    // 4. Run Benchmark against Cache
    console.log(`\nRunning Cache queries with ${totalQueries} operations...`);
    const cacheStart = Date.now();
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
    const cacheDuration = Date.now() - cacheStart;
    const cacheOpsPerSec = Math.round((totalQueries / cacheDuration) * 1000);
    const cacheMem = getMemoryUsage();

    console.log(`Cache: ${cacheDuration}ms (${cacheOpsPerSec} ops/sec) | Hits found: ${cacheSuccessCount}`);
    console.log(`Correctness Check: ${correctnessFailed ? '❌ FAILED' : '✅ PASSED'}`);

    // Clean up
    await cache.close();
    
    return {
        scenario: scenarioName,
        cacheSize,
        initDurationMs: initDuration,
        dbDurationMs: dbDuration,
        dbOpsPerSec,
        cacheDurationMs: cacheDuration,
        cacheOpsPerSec,
        speedup: (dbDuration / cacheDuration).toFixed(2),
        correctness: !correctnessFailed ? 'PASSED' : 'FAILED',
        cacheMemoryHeapMB: (memAfterCache.heapUsed - memBeforeCache.heapUsed).toFixed(2),
        cacheMemoryRssMB: (memAfterCache.rss - memBeforeCache.rss).toFixed(2)
    };
}

async function main() {
    // Wait for DB connection
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

    // Warm up the database connections
    console.log('Warming up connections...');
    await Promise.all(Array.from({ length: 30 }, () => sql`SELECT 1`));

    const results = [];

    // Scenario 1: Cache 10,000 for 1,000,000 rows
    results.push(await runScenario('Small Cache (1% coverage)', 10000, 1000000));

    // Scenario 2: Cache 100,000 for 1,000,000 rows
    results.push(await runScenario('Medium Cache (10% coverage)', 100000, 1000000));

    // Scenario 3: Cache 500,000 for 1,000,000 rows
    results.push(await runScenario('Large Cache (50% coverage)', 500000, 1000000));

    console.log(`\n======================================================`);
    console.log(`SUMMARY RESULTS`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Scenario': r.scenario,
        'Cache Size': r.cacheSize,
        'Init Time (ms)': r.initDurationMs,
        'DB Ops/sec': r.dbOpsPerSec,
        'Cache Ops/sec': r.cacheOpsPerSec,
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
