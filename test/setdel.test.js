const { expect } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("set, set null, del empty", async () => {
    const fn = () => Object.entries({});
    const cache = new (require("../index"))(fn);
    await cache.init();
    expect(cache.get("d")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(0);
    cache.set("d", "dddd");
    expect(cache.get("d")).toEqual("dddd");
    expect(cache.size).toEqual(1);
    cache.set("ee", "eeeee");
    expect(cache.get("ee")).toEqual("eeeee");
    expect(cache.size).toEqual(2);
    cache.delete("ee");
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(1);
    cache.set("null", null);
    expect(cache.get("null")).toBe(null);
    expect(cache.get("null")).not.toBe(undefined);
    expect(cache.size).toEqual(2);
    await cache.close();
    
})
test("fetch only", async () => {
    const fn = () => Object.entries({ a: 1, b: 2, c: 3 });
    const cache = new (require("../index"))(fn);
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    cache.set("ee", "eeeee");
    expect(cache.get("ee")).toEqual("eeeee");
    expect(cache.size).toEqual(4);
    cache.delete("ee");
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    await cache.close();
    
})

test("fetch refresh cache every 1 sec", async () => {
    let round = 1;
    const fn = () => {
        console.log("test fetch", round)
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round })
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { maxAge: 1 });
    await cache.init()
    //loop 3 round
    for (let i = 1; i <= 3; i++) {
        console.log("i", i, "round", round)
        expect(cache.get("a")).toEqual(1 * i);
        expect(cache.get("b")).toEqual(2 * i);
        expect(cache.get("c")).toEqual(3 * i);
        expect(cache.get("d")).toBe(undefined);
        expect(cache.get("ee")).toBe(undefined);
        expect(cache.size).toEqual(3);
        cache.set("ee", 4 * i);
        expect(cache.get("ee")).toEqual(4 * i);
        expect(cache.size).toEqual(4);
        cache.delete("ee");
        expect(cache.get("ee")).toBe(undefined);
        expect(cache.size).toEqual(3);
        await delay(1200);
    }
    console.log("test fetch close")
    await cache.close();
    
})

test("maxAge expired, maxAge < refreshAge", async () => {
    let round = 1;
    const fn = () => {
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round })
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { maxAge: 1, refreshAge: 2 });
    await cache.init()
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    cache.set("ee", "eeee");
    expect(cache.get("ee")).toEqual("eeee");
    expect(cache.size).toEqual(4);
    cache.delete("ee");
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    cache.set("null", null);
    expect(cache.get("null")).toBe(null);
    expect(cache.size).toEqual(4);
    await delay(500);
    cache.set("null", "null");
    expect(cache.size).toEqual(4);
    expect(cache.get("b")).toEqual(2);
    await delay(700);
    //a,c items expired now
    expect(cache.size).toEqual(4);//expired but not get it so size not change, do not include ee since it del explicitly
    expect(cache.get("a")).toBe(undefined);
    expect(cache.get("b")).toBe(undefined);// get update recentness not expired time
    expect(cache.get("null")).toEqual("null");// because we just set it 700 ms ago
    expect(cache.get("c")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(1);//0 because we just get the expired item, so it removed
    await delay(1200);
    //all items refresh now, and expired
    expect(cache.get("a")).toEqual(2);
    expect(cache.get("b")).toEqual(4);
    expect(cache.get("c")).toEqual(6);
    cache.set("ff", "ffff");
    expect(cache.get("ff")).toEqual("ffff");
    expect(cache.size).toEqual(4);
    cache.delete("ff");
    expect(cache.get("ff")).toBe(undefined);
    expect(cache.size).toEqual(3);
    await cache.close();
    
})

test("maxAge expired, maxAge > refreshAge, resetOnRefresh=true", async () => {
    let round = 1;
    const fn = () => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        const entires = Object.entries(obj)
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { maxAge: 2, refreshAge: 1 });
    await cache.init()
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("d")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    cache.set("ee", "eeee");
    expect(cache.get("ee")).toEqual("eeee");
    expect(cache.size).toEqual(4);
    cache.delete("ee");
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    await delay(1200);
    //all items refresh now
    //default resetOnRefresh = true, so remove old items
    expect(cache.size).toEqual(3);//new items
    expect(cache.get("a_1")).toBe(undefined);
    expect(cache.get("b_1")).toBe(undefined);
    expect(cache.get("c_1")).toBe(undefined);
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.size).toEqual(3);
    cache.delete("ff");
    expect(cache.get("ff")).toBe(undefined);
    expect(cache.get("c_2")).toEqual(6);
    cache.delete("c_2");
    expect(cache.get("c_2")).toBe(undefined);
    expect(cache.size).toEqual(2); // unchange
    await delay(1200);
    //all items refresh now
    expect(cache.size).toEqual(3);//new items only
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    await cache.close();
    
})

test("maxAge expired, maxAge > refreshAge, resetOnRefresh = false", async () => {
    let round = 1;
    const fn = () => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        const entires = Object.entries(obj)
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { maxAge: 3, refreshAge: 2, resetOnRefresh: false });
    await cache.init()
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("d")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    cache.set("ee", "eeee");
    expect(cache.get("ee")).toEqual("eeee");
    expect(cache.size).toEqual(4);
    cache.delete("ee");
    expect(cache.get("ee")).toBe(undefined);
    expect(cache.size).toEqual(3);
    cache.set("null", null);
    expect(cache.get("null")).toBe(null);
    cache.set("c_1", "4");
    expect(cache.get("c_1")).toEqual("4");
    expect(cache.size).toEqual(4); //increse by 1, key null
    await delay(2400);
    //all items refresh now
    //default resetOnRefresh = false, so last items are exist
    expect(cache.size).toEqual(7);//new items
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("null")).toBe(null);
    expect(cache.get("c_1")).toEqual("4");
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    await delay(2400);
    //new refresh
    //first round item expired now
    expect(cache.size).toEqual(6);//6 because expired items are prunded after refresh, so have 2 round of items
    expect(cache.get("a_1")).toBe(undefined);
    expect(cache.get("b_1")).toBe(undefined);
    expect(cache.get("c_1")).toBe(undefined);
    expect(cache.get("null")).toBe(undefined);
    expect(cache.size).toEqual(6);//6 because expired items removed
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    await cache.close();
    
});

test("delete and clear with missCache active", async () => {
    const data = { a: 1, b: 2 };
    const fetch = () => Object.entries(data);
    const cache = new (require("../index"))(fetch, {
        max: 3,
        fetchByKey: (key) => data[key],
        maxMiss: 10
    });
    await cache.init();
    
    // Query a missing key to populate _missCache
    expect(await cache.getOrFetch("z")).toBe(undefined);
    expect(cache._missCache.has("z")).toBe(true);
    
    // Delete z from missCache and cache to verify coverage
    cache.delete("z");
    expect(cache._missCache.has("z")).toBe(false);
    
    // Populate z again
    expect(await cache.getOrFetch("z")).toBe(undefined);
    expect(cache._missCache.has("z")).toBe(true);
    
    // Clear everything
    cache.clear();
    expect(cache._missCache.has("z")).toBe(false);
    expect(cache.get("a")).toBe(undefined);
    
    await cache.close();
});

test("timeoutLoop error catch when cache is closed", async () => {
    let round = 1;
    const fn = async () => {
        if (round === 2) {
            await delay(100);
            throw new Error("error during refresh");
        }
        round++;
        return Object.entries({ a: 1 });
    };
    const cache = new (require("../index"))(fn, { maxAge: 1, refreshAge: 1 });
    await cache.init();
    
    // Wait slightly after 1s (refresh round 2 starts)
    await delay(1050);
    // Now the refresh is running (delay 100ms). Let's close the cache immediately.
    await cache.close();
    // Wait for the refresh promise to throw error
    await delay(200);
});