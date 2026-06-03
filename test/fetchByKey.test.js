const { expect } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("fetchByKey", async () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const fetch = () => Object.entries(data);
    const cache = new (require("../index"))(fetch, { max: 3, fetchByKey: (key) => data[key] });
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("e")).toEqual(undefined);
    expect(cache.size).toEqual(3);
    //get or fetch
    expect(await cache.getOrFetch("d")).toEqual(4);
    expect(await cache.getOrFetch("e")).toEqual(5);
    expect(cache.size).toEqual(3);
    expect(cache.get("b")).toEqual(undefined);//have been replaced
    expect(cache.get("c")).toEqual(3);
    //now in cache
    expect(cache.get("d")).toEqual(4);
    expect(cache.get("e")).toEqual(5);
    //check item not found
    expect(await cache.getOrFetch("z")).toEqual(undefined);
    //recheck
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(4);
    expect(cache.get("e")).toEqual(5);
    expect(cache.size).toEqual(3);
    await cache.close();
    
})

test("fetch refresh cache every 1 sec", async () => {
    let round = 1;
    const fetch = () => {
        console.log("test fetch", round)
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round, d: 4 * round, e: 5 * round, f: 6 * round })
        round++
        return entires;
    };
    const fetchByKey = (key) => {
        return { a: 1 * round, b: 2 * round, c: 3 * round, d: 4 * round, e: 5 * round, f: 6 * round }[key]
    };
    const cache = new (require("../index"))(fetch, { max: 3, maxAge: 1, fetchByKey });
    await cache.init();
    expect(cache.size).toEqual(3);
    for (let i = 1; i <= 3; i++) {
        console.log("i", i, "round", round)
        //after refresh have no d,e
        expect(cache.get("a")).toEqual(1 * i);
        expect(cache.get("b")).toEqual(2 * i);
        expect(cache.get("c")).toEqual(3 * i);
        expect(cache.get("d")).toEqual(undefined);
        expect(cache.size).toEqual(3);
        expect(await cache.getOrFetch("d")).toEqual(4 * round);
        expect(await cache.getOrFetch("e")).toEqual(5 * round);
        expect(cache.get("ee")).toEqual(undefined);
        expect(cache.size).toEqual(3);
        await delay(1100);
    }
    await cache.close();
    
})

test("maxAge expired, maxAge < refreshAge", async () => {
    let round = 1;
    const fetch = () => {
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round, d: 4 * round, e: 5 * round, f: 6 * round })
        round++
        return entires;
    };
    const fetchByKey = (key) => {
        return { a: 1 * round, b: 2 * round, c: 3 * round, d: 4 * round, e: 5 * round, f: 6 * round }[key]
    };
    const cache = new (require("../index"))(fetch, { maxAge: 1, refreshAge: 2, fetchByKey });
    await cache.init()
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(4);
    expect(cache.get("ee")).toEqual(undefined);
    expect(cache.size).toEqual(6);
    await delay(1050);
    //all items expired now
    expect(cache.get("a")).toEqual(undefined);
    expect(cache.get("b")).toEqual(undefined);
    expect(cache.get("c")).toEqual(undefined);
    expect(cache.get("f")).toEqual(undefined);
    expect(cache.size).toEqual(2);//6-4 = 2. because we just get 4 expired items, so them removed
    expect(await cache.getOrFetch("a")).toEqual(1 * round);//fetch a
    expect(cache.size).toEqual(3);//fetch a again so 2+1 = 3
    await delay(1050);
    //all items refresh now
    expect(cache.get("a")).toEqual(2);
    expect(cache.get("b")).toEqual(4);
    expect(cache.get("c")).toEqual(6);
    expect(cache.get("e")).toEqual(10);
    expect(cache.size).toEqual(6);
    await cache.close();
    
})

test("maxAge expired, maxAge > refreshAge, resetOnRefresh = false", async () => {
    let round = 1;
    const fetch = () => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        const entires = Object.entries(obj)
        round++
        return entires;
    };
    const fetchByKey = (key) => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        return obj[key];
    };
    const cache = new (require("../index"))(fetch, { maxAge: 2, refreshAge: 1, resetOnRefresh: false, fetchByKey });
    await cache.init()
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.size).toEqual(3);
    expect(await cache.getOrFetch("a_1")).toEqual(1); //from cache
    expect(await cache.getOrFetch("a_2")).toEqual(2);
    expect(cache.size).toEqual(4);//add a_2
    await delay(1200);
    //all items refresh now
    //default resetOnRefresh = false, so last items are exist
    expect(cache.size).toEqual(6);//3 from round 1, 3 from round 2 (a_2 is the same in round 2)
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    await delay(1200);
    //new refresh
    //first round item expired now
    expect(cache.size).toEqual(6);//6 because expired items are prunded after refresh, so have 2 round of items
    expect(cache.get("a_1")).toEqual(undefined);
    expect(cache.get("b_1")).toEqual(undefined);
    expect(cache.get("c_1")).toEqual(undefined);
    expect(cache.size).toEqual(6);//6 because expired items removed
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    //round is 4 now
    expect(await cache.getOrFetch("b_4")).toEqual(8);
    expect(cache.size).toEqual(7);
    await cache.close();
    
})

test("fetchByKey, with missing key", async () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const fetch = () => Object.entries(data);
    const cache = new (require("../index"))(fetch, {
        max: 3, maxAge: 10, refreshAge: 1,
        fetchByKey: async (key) => {
            await delay(200);//delay to simulate long time to fetch
            return data[key];
        }, maxMiss: 10
    });
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("e")).toEqual(undefined);
    expect(cache.size).toEqual(3);
    //get or fetch
    expect(await cache.getOrFetch("d")).toEqual(4);
    expect(await cache.getOrFetch("e")).toEqual(5);
    expect(cache._missCache.size).toEqual(0);
    expect(cache.size).toEqual(3);
    expect(cache.get("b")).toEqual(undefined);//have been replaced
    expect(cache.get("c")).toEqual(3);
    //now in cache
    expect(cache.get("d")).toEqual(4);
    expect(cache.get("e")).toEqual(5);
    //try to fetch miss cache repeatly
    expect(await cache.getOrFetch("z")).toEqual(undefined);
    for (let i = 0; i < 10; i++) {
        await cache.getOrFetch("z");
    }
    //do not refresh yet due to _missCache prevent repeat fetchs
    expect(cache._missCache.size).toEqual(1);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(4);
    expect(cache.get("e")).toEqual(5);
    expect(cache.size).toEqual(3);
    await delay(400)// 200 * 3 (3 fetchs) + 400 = 1000 ms
    //refresh now
    expect(cache._missCache.size).toEqual(1);//miss cache is not expire yet
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("e")).toEqual(undefined);
    expect(cache.size).toEqual(3);
    expect(await cache.getOrFetch("d")).toEqual(4);
    expect(cache.get("d")).toEqual(4);
    expect(cache.get("a")).toEqual(undefined); //replace by "d" due to reach max size
    await delay(800)// 200 (fetch d)+800 =1000
    expect(cache._missCache.size).toEqual(0);//miss cache is expired
    //refresh now - also miss key z is now
    await cache.close();
    
}, 10000);

test("fetchByKey, with missing key check repeatly", async () => {
    const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const fetch = () => Object.entries(data);
    const cache = new (require("../index"))(fetch, {
        max: 3, maxAge: 10, refreshAge: 4,
        fetchByKey: async (key) => {
            await delay(200);//delay to simulate long time to fetch
            return data[key];
        }, maxMiss: 10, maxAgeMiss: 1
    });
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("e")).toEqual(undefined);
    expect(cache.size).toEqual(3);
    //try to fetch miss cache repeatly
    expect(await cache.getOrFetch("z")).toEqual(undefined);
    expect(cache._missCache.size).toEqual(1);//miss cache is expired
    await delay(1010)// miss cache expired
    const start = Date.now();
    expect(await cache.getOrFetch("z")).toEqual(undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(200); // fetch again
    const startLoopWithMissCache = Date.now()
    for (let i = 0; i < 100; i++) {
        await cache.getOrFetch("z");
    }
    expect(Date.now() - startLoopWithMissCache).toBeLessThan(100); // do not fetch again
    await delay(800);//miss cache z donot expired yet
    const startWithMissCache1 = Date.now()
    expect(await cache.getOrFetch("z")).toEqual(undefined); //this must not update recentness of z miss cache
    expect(Date.now() - startWithMissCache1).toBeLessThan(50); // do not fetch again
    await delay(200);//miss cache z must expired now
    const startWithoutMissCache = Date.now()
    expect(await cache.getOrFetch("z")).toEqual(undefined);
    expect(Date.now() - startWithoutMissCache).toBeGreaterThanOrEqual(200); // do fetch again
    
}, 10000);