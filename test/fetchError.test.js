const { expect } = require("@jest/globals");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("fetch refresh cache every 1 sec", async () => {
    let round = 1;
    const fn = () => {
        if (round % 2 == 0) {
            throw Error(`fetch error at round ${round++}`);
        }
        const entires = Object.entries({ a: 1 * round, b: 2 * round, c: 3 * round })
        round++;
        return entires;
    };
    const cache = new (require("../index"))(fn, { maxAge: 2, refreshAge: 1 });
    await cache.init()
    //loop 3 round
    for (let i = 1; i <= 3; i++) {
        console.log("i", i, "round", round)
        if ((round - 1) % 2 == 0) {
            //error then key is the non expired cache
            expect(cache.get("a")).toEqual(1 * (i - 1));
            expect(cache.get("b")).toEqual(2 * (i - 1));
            expect(cache.get("c")).toEqual(3 * (i - 1));
            expect(cache.get("d")).toEqual(undefined);
            expect(cache.get("ee")).toEqual(undefined);
        } else {
            expect(cache.get("a")).toEqual(1 * i);
            expect(cache.get("b")).toEqual(2 * i);
            expect(cache.get("c")).toEqual(3 * i);
            expect(cache.get("d")).toEqual(undefined);
            expect(cache.get("ee")).toEqual(undefined);
            expect(cache.size).toEqual(3);
        }
        await delay(1200);
    }
    console.log("test fetch close")
    await cache.close();
    
});

test("unexpected error in catch block of timeoutLoop", async () => {
    const fn = () => {
        throw new Error("simulated initial fetch error");
    };
    const cache = new (require("../index"))(fn, { maxAge: 1, refreshAge: 1 });
    
    const originalConsoleError = console.error;
    
    // Override console.error to throw an error when called
    console.error = (msg) => {
        if (msg === "error when refrech cache") {
            throw new Error("simulated unexpected console error");
        }
    };
    
    try {
        const asyncRefreshFailing = async () => {
            throw new Error("simulated refresh error");
        };
        cache._timeoutLoop(asyncRefreshFailing, 10);
        
        // Wait for timeout to fire and throw
        await delay(30);
    } catch (err) {
        // Unexpected catch
    } finally {
        console.error = originalConsoleError;
    }
    
    await cache.close();
});
