const { expect } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("refreshed only by fetched key.", async () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const fn = (recentKeys) => {
        if (recentKeys && recentKeys.length > 0) {
            return recentKeys.map((key) => [key, data[key]])
        }
        return Object.entries({}) //empty data
    };
    const cache = new (require("../index"))(fn, { max: 10, maxAge: 2, passRecentKeysOnRefresh: true, refreshAge: 1, fetchByKey: (key) => data[key] });
    await cache.init();
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    expect(await cache.getOrFetch("d")).toBe(4);
    expect(await cache.getOrFetch("e")).toBe(5);
    expect(cache.size).toEqual(2);
    await delay(1100);//refreshed only by fetched key.
    expect(await cache.get("d")).toBe(4);
    expect(await cache.get("e")).toBe(5);
    expect(await cache.get("a")).toBe(undefined);
    expect(cache.size).toEqual(2);
    await cache.close();
    
})


test("refreshed only by fetched key, only non expired cached are in next fetch", async () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const fn = (recentKeys) => {
        if (recentKeys && recentKeys.length > 0) {
            return recentKeys.map((key) => [key, data[key]])
        }
        return Object.entries({}) //empty data
    };
    const cache = new (require("../index"))(fn, { max: 10, maxAge: 1, passRecentKeysOnRefresh: true, refreshAge: 2, fetchByKey: (key) => data[key] });
    await cache.init();
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    expect(await cache.getOrFetch("d")).toBe(4);
    expect(await cache.getOrFetch("e")).toBe(5);
    await delay(1200);//d,e expired by now
    expect(cache.size).toEqual(2);
    expect(await cache.getOrFetch("a")).toBe(1);
    expect(cache.size).toEqual(3);
    await delay(900);//refreshed only by non expired fetched key.
    expect(await cache.get("d")).toBe(undefined);
    expect(await cache.get("e")).toBe(undefined);
    expect(await cache.get("a")).toBe(1);
    expect(cache.size).toEqual(1);
    await cache.close();
    
})

test("refreshed only by fetched key, only non expired cached and exists", async () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const fn = (recentKeys) => {
        console.log(recentKeys)
        if (recentKeys && recentKeys.length > 0) {
            //do not refresh c
            const keys = recentKeys.filter(key => key != "c");
            console.log(`keys`, keys)
            return keys.map((key) => [key, data[key]])
        }
        return Object.entries({}) //empty data
    };
    const cache = new (require("../index"))(fn, { max: 10, maxAge: 1, passRecentKeysOnRefresh: true, refreshAge: 2, resetOnRefresh: false, fetchByKey: (key) => data[key] });
    await cache.init();
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    expect(await cache.getOrFetch("d")).toBe(4);
    expect(await cache.getOrFetch("e")).toBe(5);
    await delay(1400);//d,e expired by now
    expect(cache.size).toEqual(2);
    expect(await cache.getOrFetch("a")).toBe(1);
    expect(await cache.getOrFetch("c")).toBe(3);
    expect(cache.size).toEqual(4);
    await delay(700);//refreshed only by non expired fetched key.
    expect(await cache.get("d")).toBe(undefined);
    expect(await cache.get("e")).toBe(undefined);
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("c")).toBe(3);
    expect(cache.size).toEqual(2);
    await delay(400);//c should be expired by now since it have not been refresh
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("c")).toBe(undefined);
    await cache.close();
    
})