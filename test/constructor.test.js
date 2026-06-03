const { expect } = require("@jest/globals");

test("fetch only", () => {
    expect(() => {
        new (require("../index"))();
    }).toThrow("fetch must be function/async function");
    const fn = () => { };
    const dataCache = new (require("../index"))(fn);
    expect(dataCache._fetch).toBe(fn);
})
/**
    maxAge - seconds before cache are expired and return undefined, default = 600s,
    refreshAge - seconds before fetch new values, default = maxAge,
    resetOnRefresh - true reset all cached data and replace with the new fetched data, false replace values with same keys from the new fetched data, default = true,
    fetchMissCache - true fecth miss cache with fetch(key) - fetch function must support get individual data by key, where key is the key that no cache data, false do not fetch miss cache. default = false.
    max - max of cache items, default = 10000.
*/
test("maxAge,refreshAge,resetOnRefresh,fetchMissCache,max initiate", () => {
    const fn = () => { };
    const dataCache = new (require("../index"))(fn);
    expect(dataCache.maxAge).toBe(600);
    expect(dataCache.refreshAge).toBe(600);
    expect(dataCache.resetOnRefresh).toBe(true);
    expect(dataCache.max).toBe(10000);
    dataCache.maxAge = 10000;
    dataCache.refreshAge = 10000;
    dataCache.resetOnRefresh = false;
    dataCache.fetchMissCache = true;
    dataCache.max = 20000;
    //options can not change after instantiated
    expect(dataCache.maxAge).toBe(600);
    expect(dataCache.refreshAge).toBe(600);
    expect(dataCache.resetOnRefresh).toBe(true);
    expect(dataCache.max).toBe(10000);
})

test("check maxAge,refreshAge,resetOnRefresh,fetchMissCache,max initiate", () => {
    const fn = () => { };
    expect(() => {
        new (require("../index"))(fn, { maxAge: "100" });
    }).toThrow("Invalid maxAge");
    expect(() => {
        new (require("../index"))(fn, { refreshAge: {} });
    }).toThrow("Invalid refreshAge");
    expect(() => {
        new (require("../index"))(fn, { resetOnRefresh: 500 });
    }).toThrow("Invalid resetOnRefresh");
    expect(() => {
        new (require("../index"))(fn, { max: (new Date()) });
    }).toThrow("Invalid max");
    expect(() => {
        new (require("../index"))(fn, { refreshAt: { days: 0, at: "10:00:00" } });
    }).toThrow("Invalid refreshAt.days, support 1-14");
})

test("list options", () => {
    const fn = () => { };
    const dataCache = new (require("../index"))(fn);
    const options = Object.keys(dataCache);
    expect(options.length).toEqual(6);
    expect(options).toEqual(expect.arrayContaining(["maxAge", "refreshAge", "resetOnRefresh", "max", "size", "passRecentKeysOnRefresh"]))
})

test("maxAge: 0 is honoured (no TTL)", () => {
    const fn = () => [];
    const dataCache = new (require("../index"))(fn, { maxAge: 0 });
    expect(dataCache.maxAge).toBe(0);
})

test("refreshAge: 0 is honoured", () => {
    const fn = () => [];
    const dataCache = new (require("../index"))(fn, { refreshAge: 0 });
    expect(dataCache.refreshAge).toBe(0);
})

test("maxMiss: 0 disables miss cache — fetchByKey still works but repeated misses always query", async () => {
    let calls = 0;
    const data = { a: 1 };
    const fn = () => [];
    const cache = new (require("../index"))(fn, {
        maxMiss: 0,
        fetchByKey: async (key) => { calls++; return data[key]; }
    });
    await cache.init();
    expect(cache.maxMiss).toBe(0);
    // _missCache must not exist when maxMiss === 0
    expect(cache._missCache).toBeUndefined();
    // 'z' does not exist — should call fetchByKey every time (no miss-cache to short-circuit)
    expect(await cache.getOrFetch('z')).toBeUndefined();
    expect(await cache.getOrFetch('z')).toBeUndefined();
    expect(calls).toBe(2);
    await cache.close();
})

test("maxMiss: 0 disables miss cache — fetchByKeys path", async () => {
    let calls = 0;
    const fn = () => [];
    const cache = new (require("../index"))(fn, {
        maxMiss: 0,
        fetchByKeys: async (keys) => { calls++; return []; }
    });
    await cache.init();
    expect(cache.maxMiss).toBe(0);
    expect(cache._missCache).toBeUndefined();
    await cache.getOrFetchMany(['z']);
    await cache.getOrFetchMany(['z']);
    expect(calls).toBe(2);
    await cache.close();
})

test("maxAgeMiss: 0 is honoured (miss entries never expire)", () => {
    const fn = () => [];
    const cache = new (require("../index"))(fn, {
        fetchByKey: async (key) => undefined,
        maxAgeMiss: 0
    });
    expect(cache.maxAgeMiss).toBe(0);
})