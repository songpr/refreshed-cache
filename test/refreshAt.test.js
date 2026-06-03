const { expect } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("fetch at specific time", async () => {
    const fn = () => Object.entries({ a: 1, b: 2, c: 3 });
    const nowMs = Date.now()
    const next1Sec = new Date(nowMs + 1000);
    //run in next secound
    const days = 2;
    const options = { refreshAt: { days, at: `${next1Sec.getHours()}:${next1Sec.getMinutes()}:${next1Sec.getSeconds()}` } }
    console.log(options.refreshAt.at)
    const cache = new (require("../index"))(fn, options);
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.size).toEqual(3);
    console.log("next run at ", cache._runAt);
    //expect next run time to be within +- 1sec of refreshAt.at
    const timeMS = next1Sec.getHours() * 60 * 60 * 1000 + next1Sec.getMinutes() * 60 * 1000 + next1Sec.getSeconds() * 1000;
    const nextTimeMs = cache._runAt.getHours() * 60 * 60 * 1000 + cache._runAt.getMinutes() * 60 * 1000 + cache._runAt.getSeconds() * 1000;
    expect(nextTimeMs).toBeLessThanOrEqual(timeMS + 1000);
    expect(nextTimeMs).toBeGreaterThanOrEqual(timeMS - 1000);
    
});

test("fetch at specific time, maxAge", async () => {
    const fn = () => Object.entries({ a: 1, b: 2, c: 3 });
    const nowMs = Date.now()
    const next1Sec = new Date(nowMs + 1000);
    //run in next secound
    const days = 2;
    const options = { maxAge: 1, refreshAt: { days, at: `${next1Sec.getHours()}:${next1Sec.getMinutes()}:${next1Sec.getSeconds()}` } }
    console.log(options.refreshAt.at)
    const cache = new (require("../index"))(fn, options);
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    expect(cache.get("b")).toEqual(2);
    expect(cache.get("c")).toEqual(3);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    expect(cache.size).toEqual(3);
    await delay(1000);
    //now it should be expired
    expect(cache.get("a")).toEqual(undefined);
    expect(cache.get("b")).toEqual(undefined);
    expect(cache.get("d")).toEqual(undefined);
    expect(cache.get("ee")).toEqual(undefined);
    expect(cache.size).toEqual(1); //c do not called yet so it still in cache
    expect(cache.get("c")).toEqual(undefined);
    expect(cache.size).toEqual(0);
    console.log("next run at ", cache._runAt);
    //expect next run time to be within +- 1sec of refreshAt.at
    const timeMS = next1Sec.getHours() * 60 * 60 * 1000 + next1Sec.getMinutes() * 60 * 1000 + next1Sec.getSeconds() * 1000;
    const nextTimeMs = cache._runAt.getHours() * 60 * 60 * 1000 + cache._runAt.getMinutes() * 60 * 1000 + cache._runAt.getSeconds() * 1000;
    expect(nextTimeMs).toBeLessThanOrEqual(timeMS + 1000);
    expect(nextTimeMs).toBeGreaterThanOrEqual(timeMS - 1000);
    await cache.close();
});

test("fetch at specific time and wait for refresh loop to fire", async () => {
    let round = 1;
    const fn = () => {
        const entries = Object.entries({ a: 1 * round, b: 2 * round });
        round++;
        return entries;
    };
    const cache = new (require("../index"))(fn, { maxAge: 10 });
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    
    // Manually trigger the refreshAtLoop with a short delay (100ms)
    const now = new Date();
    const nowMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    await cache._refreshAtLoop(cache.asyncRefresh, { msFrom00_00: nowMs + 100, daysMs: 100000 }, 0);
    
    // Wait for the timeout to fire (100ms scheduled + buffer)
    await delay(250);
    
    // Cache should have refreshed
    expect(cache.get("a")).toEqual(2);
    await cache.close();
});

test("fetch at specific time with error during refresh loop", async () => {
    let round = 1;
    const fn = () => {
        if (round === 2) {
            round++;
            throw new Error("refreshAt error simulated");
        }
        const entries = Object.entries({ a: 1 * round, b: 2 * round });
        round++;
        return entries;
    };
    const cache = new (require("../index"))(fn, { maxAge: 10 });
    await cache.init();
    expect(cache.get("a")).toEqual(1);
    
    // Manually trigger the refreshAtLoop with a short delay (100ms)
    const now = new Date();
    const nowMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    await cache._refreshAtLoop(cache.asyncRefresh, { msFrom00_00: nowMs + 100, daysMs: 100000 }, 0);
    
    await delay(250);
    
    // It should log the error and handle it without crashing, keeping the cache/scheduling next run
    expect(cache.get("a")).toEqual(1);
    await cache.close();
});

test("fetch at specific time and close during refresh", async () => {
    let round = 1;
    const fn = async () => {
        await delay(100);
        const entries = Object.entries({ a: 1 * round, b: 2 * round });
        round++;
        return entries;
    };
    const cache = new (require("../index"))(fn, { maxAge: 10 });
    await cache.init();
    
    const now = new Date();
    const nowMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    await cache._refreshAtLoop(cache.asyncRefresh, { msFrom00_00: nowMs + 100, daysMs: 100000 }, 0);
    
    // Wait for it to trigger the setTimeout and start asyncRefresh (100ms + buffer)
    await delay(150);
    
    // Now call close while asyncRefresh is executing
    await cache.close();
    
    // Wait for the asyncRefresh promise to resolve
    await delay(150);
});

test("fetch at specific time and throw error and close during refresh", async () => {
    let round = 1;
    const fn = async () => {
        await delay(100);
        if (round === 2) {
            throw new Error("simulated refresh error");
        }
        round++;
        return Object.entries({ a: 1 });
    };
    const cache = new (require("../index"))(fn, { maxAge: 10 });
    await cache.init();
    
    const now = new Date();
    const nowMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    await cache._refreshAtLoop(cache.asyncRefresh, { msFrom00_00: nowMs + 100, daysMs: 100000 }, 0);
    
    await delay(150);
    await cache.close();
    await delay(150);
});

test("unexpected error in catch block of refreshAtLoop", async () => {
    const fn = () => Object.entries({ a: 1 });
    const cache = new (require("../index"))(fn, { maxAge: 10 });
    await cache.init();
    
    const originalConsoleError = console.error;
    
    console.error = (msg) => {
        if (msg === "error when refrech cache") {
            throw new Error("simulated unexpected console error");
        }
    };
    
    try {
        const asyncRefreshFailing = async () => {
            throw new Error("simulated refresh error");
        };
        const now = new Date();
        const nowMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
        cache._refreshAtLoop(asyncRefreshFailing, { msFrom00_00: nowMs + 10, daysMs: 100000 }, 0);
        
        await delay(50);
    } catch (err) {
    } finally {
        console.error = originalConsoleError;
    }
    
    await cache.close();
});