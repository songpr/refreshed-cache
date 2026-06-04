const postgres = require('postgres');
const DataCache = require('../index.js');
const { sleep, percentiles } = require('./lib/bench-utils');
const { getArg, isChild, emitResult, orchestrate } = require('./lib/isolated-runner');

const TOTAL_DURATION_SEC = parseInt(getArg('duration', '30'), 10);
const TARGET_QPS = 1000;

let dbStuttering = false;

// Mock database that starts stuttering halfway through
const mockDb = {
    fetch: async (key) => {
        if (dbStuttering) {
            await sleep(1500); // 1.5s latency during stutter
        } else {
            await sleep(10); // 10ms normal latency
        }
        return { uuid: key, name: 'Test User', email: 'test@example.com' };
    },
    fetchAll: async () => {
        if (dbStuttering) {
            await sleep(1500);
        } else {
            await sleep(100);
        }
        return Array.from({ length: 100 }, (_, i) => [`k${i}`, { uuid: `k${i}`, name: 'Test User', email: 'test@example.com' }]);
    }
};

const STRATEGIES = [
    {
        key: 'lazy',
        label: 'Traditional Lazy Cache (Fails during stutter)',
        setup: async () => {
            const cache = new DataCache(
                async () => [],
                {
                    max: 1000,
                    maxAge: 10,
                    refreshAge: 0, // NO refresh
                    fetchByKey: async (key) => await mockDb.fetch(key)
                }
            );
            await cache.init();
            return cache;
        }
    },
    {
        key: 'refreshed',
        label: 'Refreshed Cache (Serves instantly despite stutter)',
        setup: async () => {
            const cache = new DataCache(
                async () => await mockDb.fetchAll(),
                {
                    max: 1000,
                    maxAge: 20,
                    refreshAge: 5, // Refreshes in background
                }
            );
            await cache.init();
            return cache;
        }
    }
];

async function runStrategy(name, setupCacheFn) {
    dbStuttering = false;
    const cache = await setupCacheFn();
    
    // Stutter schedule
    setTimeout(() => {
        console.log('[Mock DB] Starting stutter (1.5s latency)...');
        dbStuttering = true;
    }, (TOTAL_DURATION_SEC / 3) * 1000);
    
    setTimeout(() => {
        console.log('[Mock DB] Recovering...');
        dbStuttering = false;
    }, (TOTAL_DURATION_SEC * 0.8) * 1000);

    const startTime = Date.now();
    let isRunning = true;
    let timeouts = 0;
    let intervalLatencies = [];
    
    const worker = async () => {
        const intervalMs = 1000 / (TARGET_QPS / 10);
        while (isRunning) {
            const reqStart = process.hrtime.bigint();
            const key = `k${Math.floor(Math.random() * 100)}`;
            
            try {
                // Mock a 500ms client timeout
                const fetchPromise = cache.getOrFetch(key);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500));
                
                await Promise.race([fetchPromise, timeoutPromise]);
                
                const qDiff = Number(process.hrtime.bigint() - reqStart) / 1e6;
                intervalLatencies.push(qDiff);
            } catch (err) {
                timeouts++;
            }
            await sleep(intervalMs);
        }
    };

    const workerPromises = Array.from({ length: 10 }, () => worker());

    for (let t = 1; t <= TOTAL_DURATION_SEC; t++) {
        await sleep(1000);
        const lats = intervalLatencies;
        intervalLatencies = [];
        const pct = percentiles(lats);
        console.log(`[${t}s] p50: ${pct.p50}ms | p99: ${pct.p99}ms | Timeouts: ${timeouts}`);
    }

    isRunning = false;
    await Promise.all(workerPromises);
    
    const pct = percentiles(intervalLatencies);
    await cache.close();
    
    return {
        name,
        p99: pct.p99,
        timeouts
    };
}

async function main() {
    if (isChild) {
        const key = getArg('strategy');
        const strat = STRATEGIES.find(s => s.key === key);
        const result = await runStrategy(strat.label, strat.setup);
        emitResult(result);
        return;
    }

    const results = await orchestrate({
        scriptPath: __filename,
        strategyKeys: STRATEGIES.map(s => s.key),
        rounds: 1,
        passArgs: process.argv.slice(2),
    });

    console.log(`\n======================================================`);
    console.log(`REFRESH VS DIRECT BENCHMARK`);
    console.log(`======================================================`);
    console.table(results.map(r => ({
        'Strategy': r.name,
        'Final P99 (ms)': r.p99,
        'Timeouts Prevented': r.name.includes('Refreshed') ? 'Yes' : 'No',
        'Total Timeouts': r.timeouts
    })));
}

if (require.main === module) {
    main().catch(console.error);
}
