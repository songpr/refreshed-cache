//testing max and lru when having max
const { expect } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("fetch exceed max, keep first max entries - make sure the most important entry is the first one", async () => {
    const max = 3;
    const fn = () => Object.entries({ a: 1, b: 2, c: 3, d: 4 });
    const cache = new (require("../index"))(fn, { max: max });
    await cache.init();
    expect(cache.size).toEqual(max);
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toBe(undefined);;
    expect(cache.get("ee")).toBe(undefined);;
    
})

test("fetch exceed max, keep first max entries - the least recently get/set will be removed first", async () => {
    const max = 3;
    const fn = () => Object.entries({ a: 1, b: 2, c: 3, d: 4 });
    const cache = new (require("../index"))(fn, { max: max });
    await cache.init();
    expect(cache.size).toEqual(max);
    cache.set("e", 5);
    expect(cache.get("e")).toEqual(5 );
    expect(cache.get("a")).toBe(undefined); //First in first out
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("b")).toEqual(2);
    cache.set("f", 6);
    expect(cache.get("e")).toBe(undefined); //just get b,c so e is least recently use
    expect(cache.get("d")).toBe(undefined);
    expect(cache.get("ee")).toBe(undefined);
    
})

const ntest = () => { };
test("fetch exceed max, refresh cache every 1 sec", async () => {
    const max = 3;
    let round = 1;
    const fn = () => {
        console.log("test fetch", round)
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round, d: 4 * round })
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { max, maxAge: 1 });
    await cache.init()
    //loop 3 round
    for (let i = 1; i <= 3; i++) {
        console.log("i", i, "round", round)
        expect(cache.get("a")).toEqual(1 * i);
        expect(cache.get("b")).toEqual(2 * i);
        expect(cache.get("c")).toEqual(3 * i);
        expect(cache.get("d")).toBe(undefined);;
        expect(cache.get("ee")).toBe(undefined);;
        cache.set("e", 5 * i);
        expect(cache.get("e")).toEqual(5 * i);
        expect(cache.get("a")).toBe(undefined);;// oldest get remove first
        expect(cache.size).toEqual(max);
        await delay(1200);
    }
    console.log("test fetch close")
    await cache.close();
    
})

test("fetch exceed max, maxAge expired, maxAge < refreshAge", async () => {
    const max = 3;
    let round = 1;
    const fn = () => {
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round, d: 4 * round })
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { max, maxAge: 1, refreshAge: 2 });
    await cache.init()
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toBe(undefined);;
    expect(cache.get("ee")).toBe(undefined);;
    expect(cache.size).toEqual(max);
    await delay(1200);
    //all items expired now
    expect(cache.size).toEqual(max);//expired but not get it so size not change
    expect(cache.get("a")).toBe(undefined);;
    expect(cache.get("b")).toBe(undefined);;
    expect(cache.get("c")).toBe(undefined);;
    expect(cache.size).toEqual(0);//0 because we just get the expired item, so it removed
    await delay(1200);
    //all items refresh now
    expect(cache.size).toEqual(max);
    expect(cache.get("a")).toEqual(2);
    expect(cache.get("b")).toEqual(4);
    expect(cache.get("c")).toEqual(6);
    expect(cache.get("d")).toBe(undefined);;
    await cache.close();
    
})

test("fetch exceed max ,maxAge expired, maxAge > refreshAge, resetOnRefresh=true", async () => {
    const max = 3;
    let round = 1;
    const fn = () => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        obj[`d_${round}`] = 4 * round;
        const entires = Object.entries(obj)
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { max, maxAge: 2, refreshAge: 1 });
    await cache.init()
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("d_1")).toBe(undefined);;
    expect(cache.get("ee")).toBe(undefined);;
    expect(cache.size).toEqual(3);
    await delay(1200);
    //all items refresh now
    //default resetOnRefresh = true, so remove old items
    expect(cache.size).toEqual(3);//new items
    expect(cache.get("a_1")).toBe(undefined);;
    expect(cache.get("b_1")).toBe(undefined);;
    expect(cache.get("c_1")).toBe(undefined);;
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.size).toEqual(3);
    await delay(1200);
    //all items refresh now
    expect(cache.size).toEqual(3);//new items only
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    expect(cache.get("d_3")).toBe(undefined);;
    await cache.close();
    
})
//new fetch more important than old items
test("fetch size < max ,maxAge expired, maxAge > refreshAge, resetOnRefresh=true", async () => {
    const max = 6;
    let round = 1;
    const fn = () => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        obj[`d_${round}`] = 4 * round;
        const entires = Object.entries(obj)
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { max, maxAge: 2, refreshAge: 1 });
    await cache.init()
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("d_1")).toEqual(4);
    expect(cache.get("ee")).toBe(undefined);;
    expect(cache.size).toEqual(4);
    await delay(1200);
    //all items refresh now
    //default resetOnRefresh = true, so remove old items
    expect(cache.size).toEqual(4);//new items
    expect(cache.get("a_1")).toBe(undefined);;
    expect(cache.get("b_1")).toBe(undefined);;
    expect(cache.get("c_1")).toBe(undefined);;
    expect(cache.get("d_1")).toBe(undefined);;
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.get("d_2")).toEqual(8);
    expect(cache.size).toEqual(4);
    await delay(1200);
    //all items refresh now
    expect(cache.size).toEqual(4);//new items only
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    expect(cache.get("d_3")).toEqual(12);
    await cache.close();
    
})
//if max > size of new fetch, here are priority of cache -> new fetch > old fetch priority recently use > old fetch with no used > expired items.

test("fetch size < max, maxAge expired, maxAge > refreshAge, resetOnRefresh = false", async () => {
    const max = 10;
    let round = 1;
    const fn = () => {
        const obj = {};
        obj[`a_${round}`] = 1 * round;
        obj[`b_${round}`] = 2 * round;
        obj[`c_${round}`] = 3 * round;
        obj[`d_${round}`] = 4 * round;
        const entires = Object.entries(obj)
        round++
        return entires;
    };
    const cache = new (require("../index"))(fn, { max, maxAge: 3, refreshAge: 1, resetOnRefresh: false });
    await cache.init()
    expect(cache.get("a_1")).toEqual(1);
    expect(cache.get("a_1")).toEqual(1);//a have been called twice
    expect(cache.get("c_1")).toEqual(3);
    expect(cache.get("d_1")).toEqual(4);

    expect(cache.size).toEqual(4);//new items
    expect(cache.get("ee")).toBe(undefined);;
    await delay(1200);
    //new 4 item, no old item have to be removed
    //default resetOnRefresh = false, so last items are exist
    expect(cache.size).toEqual(8);//new items + old items
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.get("d_2")).toEqual(8);
    expect(cache.get("b_1")).toEqual(2);
    await delay(1200);
    //new 4 item, 2 no old item have to be removed
    expect(cache.size).toEqual(max);
    expect(cache.get("a_1")).toBe(undefined);;
    expect(cache.get("c_1")).toBe(undefined);;
    expect(cache.get("a_2")).toEqual(2);
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.get("d_2")).toEqual(8);
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    expect(cache.has("d_3")).toBe(true);
    //last 2 recent call of round 1
    expect(cache.get("d_1")).toEqual(4);
    expect(cache.get("b_1")).toEqual(2);
    expect(cache.size).toEqual(max);
    await delay(1200);
    //now first round is expired (even d_1,b_1 have recently call) and have 4 new fecth + 4*2 of round(2,3)
    expect(cache.size).toEqual(max);
    //expired items
    expect(cache.get("d_1")).toBe(undefined);;
    expect(cache.get("b_1")).toBe(undefined);;
    //priority of cache
    expect(cache.get("a_4")).toEqual(4);
    expect(cache.get("b_4")).toEqual(8);
    expect(cache.get("c_4")).toEqual(12);
    expect(cache.get("d_4")).toEqual(16);
    //recency but not expried
    expect(cache.get("b_2")).toEqual(4);
    expect(cache.get("c_2")).toEqual(6);
    expect(cache.get("d_2")).toEqual(8);
    expect(cache.get("a_3")).toEqual(3);
    expect(cache.get("b_3")).toEqual(6);
    expect(cache.get("c_3")).toEqual(9);
    //old fetch but not recently use
    expect(cache.get("d_3")).toBe(undefined);;

    await cache.close();
    
});