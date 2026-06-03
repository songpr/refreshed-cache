const { expect } = require("@jest/globals");

test("fetch empty", async () => {
    const fn = () => Object.entries({});
    const cache = new (require("../index"))(fn);
    await cache.init();
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    expect(cache.size).toEqual(0);
    for (const entry of cache.entries()) {
        fail('it should not have any cache entry');
    }
    await cache.close();
});

test("fetch only", async () => {
    const fn = () => Object.entries({ a: 1, b: 2, c: 3 });
    const cache = new (require("../index"))(fn);
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    const items = {}
    for (const entry of cache.entries()) {
        items[entry[0]] = entry[1]
    }
    expect(items).toEqual({ a: 1, b: 2, c: 3 });
    expect(cache.size).toEqual(3);
    await cache.close();
});