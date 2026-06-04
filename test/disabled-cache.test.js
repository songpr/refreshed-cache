// Contract: when max <= 0 the cache is disabled and stores NOTHING (per the
// `max` option docs: "Setting it to 0 then no data will be cached"). Fetches
// still return their value — they just are not cached.
const { trackCaches } = require('./helpers');

const newCache = trackCaches();

describe('disabled cache (max <= 0) stores nothing', () => {
    test('set() on a max:0 cache does not store', async () => {
        const cache = newCache(() => [], { max: 0 });
        await cache.init();

        cache.set('a', 1);

        expect(cache.size).toBe(0);
        expect(cache.get('a')).toBeUndefined();
        expect(cache.has('a')).toBe(false);
    });

    test('getOrFetch() returns the fetched value but does not cache it', async () => {
        let calls = 0;
        const cache = newCache(() => [], {
            max: 0,
            fetchByKey: async (k) => { calls++; return `v-${k}`; }
        });
        await cache.init();

        expect(await cache.getOrFetch('a')).toBe('v-a'); // value still returned
        expect(cache.size).toBe(0);                       // but not stored

        await cache.getOrFetch('a');
        expect(calls).toBe(2);                            // refetched -> proves no caching
    });

    test('getOrFetchMany() returns values but does not cache them', async () => {
        let batchCalls = 0;
        const cache = newCache(() => [], {
            max: 0,
            fetchByKeys: async (keys) => { batchCalls++; return keys.map(k => [k, `v-${k}`]); }
        });
        await cache.init();

        expect(await cache.getOrFetchMany(['a', 'b'])).toEqual({ a: 'v-a', b: 'v-b' });
        expect(cache.size).toBe(0);

        await cache.getOrFetchMany(['a', 'b']);
        expect(batchCalls).toBe(2); // refetched -> proves no caching
    });
});
