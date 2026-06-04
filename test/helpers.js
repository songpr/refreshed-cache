// Shared test utilities: timing helpers, cache lifecycle tracking, and metric resets.
const DataCache = require("../index");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolve once all pending microtasks have run (used with jest fake timers).
const flushPromises = () =>
    new Promise((resolve) => jest.requireActual("timers").setImmediate(resolve));

// Reset the counters bumped during warmup so a measurement window starts clean.
function resetMetrics(cache) {
    cache._hits = 0;
    cache._misses = 0;
    cache._refreshes = 0;
    cache._coalescedFetches = 0;
    cache._mismatches = 0;
    cache._invalidations = 0;
}

// Create caches via `make()` and auto-close them after each test so a thrown
// assertion never leaves a refresh timer running (which would hang the suite).
function trackCaches() {
    let active = [];
    afterEach(async () => {
        for (const cache of active) {
            try {
                await cache.close();
            } catch (e) { /* already closing/closed */ }
        }
        active = [];
    });
    return function make(fetch, options) {
        const cache = new DataCache(fetch, options);
        active.push(cache);
        return cache;
    };
}

module.exports = { delay, flushPromises, resetMetrics, trackCaches };
