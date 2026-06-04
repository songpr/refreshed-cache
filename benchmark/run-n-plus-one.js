const DataCache = require('../index.js');
const { sleep } = require('./lib/bench-utils');

async function main() {
    console.log("=========================================");
    console.log(" N+1 Query Collapse Benchmark            ");
    console.log("=========================================\n");

    let coalescedFetchCount = 0;
    const cache = new DataCache(
        async () => [],
        {
            max: 1000,
            fetchByKey: async (k) => {
                coalescedFetchCount++;
                await sleep(50); // Simulate database delay
                return `Value for ${k}`;
            }
        }
    );
    await cache.init();

    console.log("Simulating 50 concurrent requests for the exact same missing key...");
    console.log("A naive cache would invoke fetchByKey 50 times.");
    
    // Simulate Naive Cache
    let simulatedNaiveFetches = 0;
    const promisesNaive = Array.from({ length: 50 }, async () => {
        // Naive cache doesn't coalesce, so each checks cache, misses, and fetches independently.
        simulatedNaiveFetches++;
        await sleep(50);
        return 'value';
    });
    
    const promisesRefreshed = Array.from({ length: 50 }, () => cache.getOrFetch('hot-key-123'));
    
    await Promise.all(promisesNaive);
    await Promise.all(promisesRefreshed);

    console.log(`\nResults:`);
    console.log(`- Naive Cache Invocations: ${simulatedNaiveFetches}`);
    console.log(`- Refreshed Cache Invocations: ${coalescedFetchCount} (Coalesced ${cache.metrics.coalescedFetches} duplicate fetches)`);
    
    const dbCallsSaved = simulatedNaiveFetches - coalescedFetchCount;
    console.log(`\n✅ Database calls saved: ${dbCallsSaved}`);
    await cache.close();
}

if (require.main === module) {
    main().catch(console.error);
}
