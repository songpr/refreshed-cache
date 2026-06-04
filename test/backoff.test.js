const { expect, test } = require("@jest/globals");
const DataCache = require("../index");
const { flushPromises, trackCaches } = require("./helpers");
const newCache = trackCaches();

test("exponential backoff with jitter on refresh errors", async () => {
    jest.useFakeTimers();

    let fail = false;
    const fetch = () => {
        if (fail) throw new Error("fetch failure");
        return [['a', 1]];
    };

    const cache = newCache(fetch, {
        maxAge: 10,
        refreshAge: 10,
        backoffInitialDelay: 1, // 1s
        backoffMaxDelay: 5,     // 5s
        onError: () => {}       // silence logs
    });

    await cache.init();

    // Normal run scheduled
    expect(cache._runInMs).toBe(10000);

    // Make fetch fail
    fail = true;

    // Fast-forward to trigger the refresh
    jest.advanceTimersByTime(10000);
    // Let any unresolved microtasks run (since asyncRefresh returns a promise)
    await flushPromises();

    // First failure: expected delay base is 1000ms (jitter adds up to 20%)
    expect(cache._runInMs).toBeGreaterThanOrEqual(1000);
    expect(cache._runInMs).toBeLessThanOrEqual(1200);

    const firstDelay = cache._runInMs;

    // Fast-forward to trigger first retry
    jest.advanceTimersByTime(firstDelay);
    await flushPromises();

    // Second failure: expected delay base is 2000ms (jitter adds up to 20%)
    expect(cache._runInMs).toBeGreaterThanOrEqual(2000);
    expect(cache._runInMs).toBeLessThanOrEqual(2400);

    const secondDelay = cache._runInMs;

    // Fast-forward to trigger second retry
    jest.advanceTimersByTime(secondDelay);
    await flushPromises();

    // Third failure: expected delay base is 4000ms (jitter adds up to 20%)
    expect(cache._runInMs).toBeGreaterThanOrEqual(4000);
    expect(cache._runInMs).toBeLessThanOrEqual(4800);

    const thirdDelay = cache._runInMs;

    // Fast-forward to trigger third retry
    jest.advanceTimersByTime(thirdDelay);
    await flushPromises();

    // Fourth failure: expected delay base is 8000ms, capped at maxDelay 5000ms (jitter adds up to 1000ms max)
    expect(cache._runInMs).toBeGreaterThanOrEqual(5000);
    expect(cache._runInMs).toBeLessThanOrEqual(6000);

    const fourthDelay = cache._runInMs;

    // Make fetch succeed again
    fail = false;

    // Fast-forward to trigger fourth retry (which will succeed)
    jest.advanceTimersByTime(fourthDelay);
    await flushPromises();

    // Success! Delay resets back to normal refreshAge (10000ms)
    expect(cache._runInMs).toBe(10000);

    await cache.close();
    jest.useRealTimers();
});
