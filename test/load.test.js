const { expect } = require("@jest/globals");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only run if specifically enabled via environment variable to avoid slowing down standard unit tests
const runLoadTest = process.env.RUN_LOAD_TEST === "true";
const testFn = runLoadTest ? test : test.skip;

testFn("5-minute high load and memory stability test", async () => {
    console.log("\nStarting 5-minute high load test...");
    
    let round = 1;
    const data = {};
    for (let i = 0; i < 1000; i++) {
        data[`key_${i}`] = `val_${i}`;
    }
    
    const fetch = () => {
        round++;
        return Object.entries(data);
    };
    
    const cache = new (require("../index"))(fetch, { 
        max: 5000, 
        maxAge: 2, 
        refreshAge: 1,
        fetchByKey: (key) => `val_${key}`
    });
    
    await cache.init();
    
    const startTime = Date.now();
    const duration = 5 * 60 * 1000; // 5 minutes (300,000 ms)
    
    let operationsCount = 0;
    let errorsCount = 0;
    
    const initialHeap = process.memoryUsage().heapUsed;
    console.log(`Initial heap usage: ${(initialHeap / 1024 / 1024).toFixed(2)} MB`);
    
    // Periodically log memory usage
    const logInterval = setInterval(() => {
        const heap = process.memoryUsage().heapUsed;
        const elapsedSecs = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[${elapsedSecs}s elapsed] Heap: ${(heap / 1024 / 1024).toFixed(2)} MB | Ops: ${operationsCount} | Cache Size: ${cache.size}`);
    }, 10000);
    
    // Simulate concurrent workers reading and writing to cache
    const workers = [];
    const numWorkers = 10;
    
    for (let w = 0; w < numWorkers; w++) {
        workers.push((async () => {
            while (Date.now() - startTime < duration) {
                try {
                    const keyId = Math.floor(Math.random() * 8000);
                    const opType = Math.random();
                    
                    if (opType < 0.7) {
                        // 70% Reads
                        await cache.getOrFetch(`key_${keyId}`);
                    } else if (opType < 0.9) {
                        // 20% Writes
                        cache.set(`key_${keyId}`, `manual_val_${keyId}`);
                    } else {
                        // 10% Deletes
                        cache.delete(`key_${keyId}`);
                    }
                    
                    operationsCount++;
                } catch (err) {
                    errorsCount++;
                }
                // Yield thread
                await delay(1);
            }
        })());
    }
    
    await Promise.all(workers);
    clearInterval(logInterval);
    
    const finalHeap = process.memoryUsage().heapUsed;
    console.log(`Load test completed.`);
    console.log(`- Total operations: ${operationsCount}`);
    console.log(`- Total errors: ${errorsCount}`);
    console.log(`- Final heap usage: ${(finalHeap / 1024 / 1024).toFixed(2)} MB`);
    console.log(`- Memory diff: ${((finalHeap - initialHeap) / 1024 / 1024).toFixed(2)} MB`);
    
    expect(errorsCount).toEqual(0);
    await cache.close();
}, 310000); // 310 seconds timeout for 300 seconds test
