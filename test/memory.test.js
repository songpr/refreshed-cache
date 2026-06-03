const { expect } = require("@jest/globals");

test("calculate memory usage vs cache stored", async () => {
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
    const initialMemory = process.memoryUsage().heapUsed;

    const count = 50000;
    const data = {};
    for (let i = 0; i < count; i++) {
        data[`key_${i}`] = `value_${i}_some_reasonably_long_string_to_simulate_realistic_payloads_in_production`;
    }
    
    const fetch = () => Object.entries(data);
    const cache = new (require("../index"))(fetch, { max: count, maxAge: 3600 });
    await cache.init();

    if (global.gc) {
        global.gc();
    }
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryUsed = finalMemory - initialMemory;
    const bytesPerItem = memoryUsed / count;

    console.log(`\nMemory Footprint Report:`);
    console.log(`- Cache entries stored: ${count}`);
    console.log(`- Heap memory used: ${(memoryUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`- Average memory per cache item: ${bytesPerItem.toFixed(1)} bytes`);

    expect(cache.size).toEqual(count);
    await cache.close();
});
