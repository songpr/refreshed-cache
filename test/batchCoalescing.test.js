const { expect, test } = require("@jest/globals");
const DataCache = require("../index");
const { delay, trackCaches } = require("./helpers");
const newCache = trackCaches();

test("getOrFetchMany coalesces concurrent overlapping batch fetches", async () => {
    let fetchCount = 0;
    const fetchByKeys = async (keys) => {
        fetchCount++;
        await delay(50);
        return keys.map(k => [k, k + "-val"]);
    };

    const cache = newCache(() => [], {
        maxAge: 10,
        refreshAge: 10,
        fetchByKeys
    });
    await cache.init();

    // Trigger two concurrent getOrFetchMany calls with overlapping keys
    const [res1, res2] = await Promise.all([
        cache.getOrFetchMany(['a', 'b']),
        cache.getOrFetchMany(['b', 'c'])
    ]);

    expect(res1).toEqual({ a: 'a-val', b: 'b-val' });
    expect(res2).toEqual({ b: 'b-val', c: 'c-val' });
    expect(fetchCount).toBe(2); // ['a', 'b'] and ['c']
    expect(cache.metrics.coalescedFetches).toBe(1); // 'b' in the second request was coalesced!

    await cache.close();
});

test("getOrFetch and getOrFetchMany coalesce keys seamlessly", async () => {
    let singleFetchCount = 0;
    let batchFetchCount = 0;

    const fetchByKey = async (key) => {
        singleFetchCount++;
        await delay(50);
        return key + "-val";
    };

    const fetchByKeys = async (keys) => {
        batchFetchCount++;
        await delay(50);
        return keys.map(k => [k, k + "-val"]);
    };

    const cache = newCache(() => [], {
        maxAge: 10,
        refreshAge: 10,
        fetchByKey,
        fetchByKeys
    });
    await cache.init();

    // Start single-key fetch for 'a'
    const p1 = cache.getOrFetch('a');

    // Start concurrent batch fetch for ['a', 'b']
    const p2 = cache.getOrFetchMany(['a', 'b']);

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toBe('a-val');
    expect(res2).toEqual({ a: 'a-val', b: 'b-val' });

    expect(singleFetchCount).toBe(1); // fetched 'a'
    expect(batchFetchCount).toBe(1);  // fetched 'b' (since 'a' was coalesced from single fetch)
    expect(cache.metrics.coalescedFetches).toBe(1); // 'a' in the batch request was coalesced!

    await cache.close();
});
