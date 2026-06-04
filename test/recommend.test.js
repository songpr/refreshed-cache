const DataCache = require('../index');
const { performance } = require('perf_hooks');

let activeCaches = [];
afterEach(async () => {
    for (const cache of activeCaches) {
        try {
            await cache.close();
        } catch (e) {}
    }
    activeCaches = [];
});

function newCache(fetch, options) {
    const cache = new DataCache(fetch, options);
    activeCaches.push(cache);
    return cache;
}

describe('gain() recommendation engine', () => {
    it('returns disabled when max is 0', () => {
        const cache = newCache(() => [], { max: 0 });
        const res = cache.gain();
        expect(res.code).toBe('disabled');
    });

    it('returns healthy when not enough total requests', async () => {
        const cache = newCache(() => [['a', 1]], { max: 100 });
        await cache.init();
        cache.get('a'); // 1 request
        const res = cache.gain();
        expect(res.code).toBe('healthy');
        expect(res.recommendation).toMatch(/Gathering data/);
    });

    it('returns thrash when hitRate low, utilization high, and evictChurn high', async () => {
        const cache = newCache(() => [], { max: 10 });
        await cache.init();
        
        // Fill cache, 10 hits
        for (let i = 0; i < 10; i++) cache.set(`k${i}`, i);
        for (let i = 0; i < 10; i++) cache.get(`k${i}`);

        // Force evictions with misses
        for (let i = 10; i < 150; i++) {
            cache.set(`k${i}`, i); // evicts old keys
            cache.get(`unknown${i}`); // misses
        }
        
        // window hits=10, window misses=140 => reqs=150
        // evictions=140
        // evictChurn = 140 / 150 = 0.93 > 0.1
        // hitRate = 10 / 150 < 0.5
        // util = 10 / 10 = 1.0 > 0.8
        
        const res = cache.gain();
        expect(res.code).toBe('thrash');
    });

    it('returns refresh-waste when utilization high, windowReuseRatio low, evictChurn low', async () => {
        const cache = newCache(() => [], { max: 10 });
        await cache.init();

        for (let i = 0; i < 10; i++) cache.set(`k${i}`, i);
        
        // Simulate >100 requests to bypass gathering data check
        for (let i = 0; i < 100; i++) {
            cache.get('k0'); // hit one key a lot
        }

        // Simulating the next window by triggering a refresh manually or just checking
        // Actually, windowReuseRatio is windowHits / activeSize.
        // windowHits is 100, activeSize is 10. ratio = 10. Not < 0.1.
        
        // Let's manually set internal counters for the sake of the test or simulate it:
        cache._windowHits = 0; 
        cache._windowMisses = 101; 
        cache._windowEvictions = 0;
        cache._hits = 10;
        cache._misses = 100; // hitRate < 0.5, but wait, refresh-waste requires hitRate > 0.5?
        // Ah! refresh-waste doesn't check hitRate, just utilization > 0.8, windowReuseRatio < 0.1, evictChurn < 0.05
        
        const res = cache.gain();
        expect(res.code).toBe('refresh-waste');
    });

    it('returns over-provisioned when hitRate high and utilization low', async () => {
        const cache = newCache(() => [], { max: 100 });
        await cache.init();
        
        cache.set('a', 1);
        for (let i = 0; i < 150; i++) {
            cache.get('a'); // hits
        }
        
        // util = 1 / 100 = 0.01
        // hitRate = 150 / 150 = 1.0
        const res = cache.gain();
        expect(res.code).toBe('over-provisioned');
    });
    
    it('returns low-value when hitRate low and utilization low', async () => {
        const cache = newCache(() => [], { max: 100 });
        await cache.init();
        
        cache.set('a', 1);
        for (let i = 0; i < 150; i++) {
            cache.get(`miss${i}`); // misses
        }
        
        // util = 1 / 100 = 0.01
        // hitRate = 0 / 150 = 0
        const res = cache.gain();
        expect(res.code).toBe('low-value');
    });
});
