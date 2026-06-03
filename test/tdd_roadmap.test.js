const DataCache = require('../index.js');

describe('TDD Roadmap / Future Features Verification', () => {

    test('Promise Coalescing (Single-flight) - should only call fetchByKey once for concurrent requests on the same key', async () => {
        let callCount = 0;
        const cache = new DataCache(
            async () => [],
            {
                max: 100,
                fetchByKey: async (key) => {
                    callCount++;
                    // Introduce artificial delay to simulate database request
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return `value-for-${key}`;
                }
            }
        );
        await cache.init();

        try {
            // Concurrently query the same missing key 10 times
            const queries = Array.from({ length: 10 }, () => cache.getOrFetch('user-1'));
            const results = await Promise.all(queries);

            // Verify all requests got the correct value
            results.forEach(res => {
                expect(res).toBe('value-for-user-1');
            });

            // TDD EXPECTATION: fetchByKey must only be invoked ONCE
            expect(callCount).toBe(1);
        } finally {
            await cache.close();
        }
    });

    test('Batch Loading on Miss - should support getOrFetchMany and fetch missing keys in a single batch call', async () => {
        // Assert that the API method exists
        expect(typeof DataCache.prototype.getOrFetchMany).toBe('function');

        let batchCallCount = 0;
        const batchKeysRequested = [];

        const cache = new DataCache(
            async () => [],
            {
                max: 100,
                // Proposed batch fetch options key
                fetchByKeys: async (keys) => {
                    batchCallCount++;
                    keys.forEach(k => batchKeysRequested.push(k));
                    return keys.map(k => [k, `val-${k}`]); // Returns iterable of key-value pairs
                }
            }
        );
        await cache.init();

        try {
            // Query multiple keys at once
            const results = await cache.getOrFetchMany(['k1', 'k2', 'k3']);

            expect(results).toEqual({
                k1: 'val-k1',
                k2: 'val-k2',
                k3: 'val-k3'
            });

            // TDD EXPECTATION: fetchByKeys must be invoked exactly once for the batch
            expect(batchCallCount).toBe(1);
            expect(batchKeysRequested).toEqual(['k1', 'k2', 'k3']);
        } finally {
            await cache.close();
        }
    });
});
