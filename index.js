const util = require('util');
const { LRUCache } = require("lru-cache");
const { performance } = require('perf_hooks');
const timeAtRegex = /^(2[0-3]|1[0-9]|0?[0-9]):([1-5][0-9]|0?[0-9]):([1-5][0-9]|0?[0-9])$/
const aDayInMS = 24 * 60 * 60 * 1000;
function nowMsFrom00_00() {
    const now = new Date();
    return now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
}

function getBackoffDelay(failureCount, initialDelayMs, maxDelayMs) {
    const baseDelay = initialDelayMs * Math.pow(2, failureCount - 1);
    const tempDelay = Math.min(maxDelayMs, baseDelay);
    const jitter = Math.random() * Math.min(1000, tempDelay * 0.2);
    return tempDelay + jitter;
}

/**
 * Data cache that do not have set method, fetch cached via fetch function 
 */
class DataCache {
    /**
     * 
     * @param {Function} fetch - function/async function to fetch all data and return as array of [key,value]/ a Iterator object that contains the [key, value] pairs 
     * @param {Object} options - options(max=10000,maxAge=600, refreshAge=maxAge ,resetOnRefresh = true,fetchByKey,maxMiss=2000,maxAgeMiss=refreshAge)
     *                              max - The maximum size of the cache. Setting it to 0 then no data will be cached; default is 10000,
     *                              maxAge - Maximum age in second. Expired items will be removed every refreshAge; default is 600 seconds
     *                              refreshAge - refresh time in second. New data will be fetch on each refresh and expired items will be removed every refreshAge; default is maxAge,
     *                                          note if refreshAt is specified too, then to refreshAt will be use, and ignore refreshAge.                                        
     *                              refreshAt = refresh time is object in format {days,at} e.g. {days:2,at: "10:00:00"}, time of the day to refresh the data
     *                                           days:xx -- refresh every xx days 
     *                                           at:"HH:mm:ss" -- refresh at
     *                              passRecentKeysOnRefresh - pass recent keys - that not expired - to fetch function when refresh default = false,
     *                              resetOnRefresh - true then reset cache on every refresh, so only the new fetch data is cached; default = true,
     *                              fetchByKey - function/async function use to fetch value by key and and keep it to cache.
     *                                           fetchByKey must return value (null is count as a value), and return undefined when no data found.
     *                              maxMiss - if fetchByKey is set then this is the maximum size of the miss cache key. Setting it to 0 then no miss cache will be cached; default is 2000.
     *                                           if the key is fouud in miss cache key, fetchByKey will not be called.
     *                              maxAgeMiss - if fetchByKey is set this is Maximum age of miss cache key in second. Expired items will be removed every refreshAge; default is refreshAge.
     */
    constructor(fetch, options = { maxAge: 600, resetOnRefresh: true, max: 10000 }) {
        if (typeof (fetch) !== "function") throw new Error("fetch must be function/async function");
        Object.defineProperty(this, "_fetch", { value: fetch, configurable: false, enumerable: false, writable: false });
        const _isAsyncFetch = util.types.isAsyncFunction(fetch);
        Object.defineProperty(this, "_isAsyncFetch", { get: () => _isAsyncFetch, configurable: false, enumerable: false });

        const onRefresh = options.onRefresh;
        if (onRefresh !== undefined && typeof onRefresh !== "function") throw new Error("Invalid onRefresh");
        Object.defineProperty(this, "_onRefresh", { value: onRefresh, configurable: false, enumerable: false, writable: false });

        const onError = options.onError;
        if (onError !== undefined && typeof onError !== "function") throw new Error("Invalid onError");
        Object.defineProperty(this, "_onError", { value: onError, configurable: false, enumerable: false, writable: false });

        const checkValidity = options.checkValidity;
        if (checkValidity !== undefined && typeof checkValidity !== "function") throw new Error("Invalid checkValidity");
        Object.defineProperty(this, "_checkValidity", { value: checkValidity, configurable: false, enumerable: false, writable: false });

        const isEqual = options.isEqual || ((a, b) => a === b);
        if (typeof isEqual !== "function") throw new Error("Invalid isEqual");
        Object.defineProperty(this, "_isEqual", { value: isEqual, configurable: false, enumerable: false, writable: false });

        const backoffInitialDelay = options.backoffInitialDelay === undefined ? 1 : options.backoffInitialDelay;
        if (!Number.isInteger(backoffInitialDelay) || backoffInitialDelay < 0) throw new Error("Invalid backoffInitialDelay");
        Object.defineProperty(this, "_backoffInitialDelay", { value: backoffInitialDelay, configurable: false, enumerable: false, writable: false });

        const backoffMaxDelay = options.backoffMaxDelay === undefined ? 60 : options.backoffMaxDelay;
        if (!Number.isInteger(backoffMaxDelay) || backoffMaxDelay < 0) throw new Error("Invalid backoffMaxDelay");
        Object.defineProperty(this, "_backoffMaxDelay", { value: backoffMaxDelay, configurable: false, enumerable: false, writable: false });

        Object.defineProperty(this, "_hits", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_misses", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_refreshes", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_coalescedFetches", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_mismatches", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_invalidations", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_failureCount", { value: 0, writable: true, configurable: false, enumerable: false });


        const maxAge = options.maxAge === undefined ? 600 : options.maxAge;
        if (!Number.isInteger(maxAge) || maxAge < 0) throw new Error("Invalid maxAge");
        const refreshAge = options.refreshAge === undefined ? maxAge : options.refreshAge;
        if (!Number.isInteger(refreshAge) || refreshAge < 0) throw new Error("Invalid refreshAge");
        const resetOnRefresh = options.resetOnRefresh === undefined ? true : options.resetOnRefresh;
        if (typeof (resetOnRefresh) !== "boolean") throw new Error("Invalid resetOnRefresh");
        if (options.refreshAt != null) {
            const { days, at } = options.refreshAt;
            if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error("Invalid refreshAt.days, support 1-14");
            const matchs = (typeof at === 'string') ? at.match(timeAtRegex) : null;
            if (matchs === null) throw new Error("Invalid refreshAt.at, must be string in format 'HH:mm:ss', in 24 hours format");
            const _refreshAt = { daysMs: days * 24 * 60 * 60 * 1000, msFrom00_00: (parseInt(matchs[1]) * 60 * 60 * 1000 + parseInt(matchs[2]) * 60 * 1000 + parseInt(matchs[3]) * 1000) }
            Object.freeze(_refreshAt);
            Object.defineProperty(this, "refreshAt", { get: () => _refreshAt, configurable: false, enumerable: true });
            //property to track next run at specific time if it have refreshAt only, just for debug only do not use to run
            Object.defineProperty(this, "_runAt", { value: undefined, configurable: false, enumerable: false, writable: true });
        }
        const passRecentKeysOnRefresh = options.passRecentKeysOnRefresh === undefined ? false : options.passRecentKeysOnRefresh;
        if (typeof (passRecentKeysOnRefresh) !== "boolean") throw new Error("Invalid passRecentKeysOnRefresh");
        const max = options.max === undefined ? 10000 : options.max;
        if (!Number.isInteger(max)) throw new Error("Invalid max");
        Object.defineProperty(this, "passRecentKeysOnRefresh", { get: () => passRecentKeysOnRefresh, configurable: false, enumerable: true });
        Object.defineProperty(this, "maxAge", { get: () => maxAge, configurable: false, enumerable: true });
        Object.defineProperty(this, "refreshAge", { get: () => refreshAge, configurable: false, enumerable: true });
        Object.defineProperty(this, "resetOnRefresh", { get: () => resetOnRefresh, configurable: false, enumerable: true });
        Object.defineProperty(this, "max", { get: () => max, configurable: false, enumerable: true });

        const latencySampleRate = options.latencySampleRate === undefined ? 0.01 : options.latencySampleRate;
        if (typeof latencySampleRate !== 'number' || latencySampleRate < 0 || latencySampleRate > 1 || Number.isNaN(latencySampleRate)) {
            throw new Error("Invalid latencySampleRate");
        }
        Object.defineProperty(this, "latencySampleRate", { get: () => latencySampleRate, configurable: false, enumerable: true });

        Object.defineProperty(this, "_hitN", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_hitEvery", { value: latencySampleRate > 0 ? Math.round(1 / latencySampleRate) : Infinity, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_hitCount", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_hitSumMs", { value: 0, writable: true, configurable: false, enumerable: false });

        Object.defineProperty(this, "_missFetchMinMs", { value: null, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_missFetchMaxMs", { value: null, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_missFetchSumMs", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_missFetchCount", { value: 0, writable: true, configurable: false, enumerable: false });

        Object.defineProperty(this, "_batchFetchMinMs", { value: null, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_batchFetchMaxMs", { value: null, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_batchFetchSumMs", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_batchFetchCount", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_batchFetchKeysCount", { value: 0, writable: true, configurable: false, enumerable: false });

        Object.defineProperty(this, "_refreshMinMs", { value: null, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_refreshMaxMs", { value: null, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_refreshSumMs", { value: 0, writable: true, configurable: false, enumerable: false });
        Object.defineProperty(this, "_refreshCount", { value: 0, writable: true, configurable: false, enumerable: false });
        const _lruCache = new LRUCache(maxAge > 0 ? { max: max, ttl: maxAge * 1000 } : { max: max })
        Object.defineProperty(this, "_cache", { get: () => _lruCache, configurable: false, enumerable: false });
        Object.defineProperty(this, "size", { get: () => _lruCache.size, configurable: false, enumerable: true });

        //property to track next run in ms, just for debug only do not use to run
        Object.defineProperty(this, "_runInMs", { value: undefined, configurable: false, enumerable: false, writable: true });

        const dataCache = this;
        Object.defineProperty(this, "_timeoutLoop", {
            value: (asyncRefresh, time) => {
                dataCache._runInMs = time;
                dataCache._timeoutId = setTimeout(function () {
                    if (dataCache.isClose === true) {
                        return;
                    }
                    asyncRefresh().then(() => {
                        //if pass then timeoutLoop for the next refresh
                        if (dataCache.isClose === true) {
                            return;
                        }
                        dataCache._failureCount = 0;
                        //cache is not close then set timeout loop again
                        dataCache._timeoutLoop(asyncRefresh, dataCache.refreshAge * 1000);
                    }).catch(err => {
                        try {
                            if (dataCache.isClose === true) {
                                return;
                            }
                            dataCache._failureCount++;
                            if (dataCache._onError) {
                                dataCache._onError(err);
                            } else {
                                console.error("error when refrech cache")
                                console.error(err.stack)
                            }
                            
                            let nextDelay = time;
                            if (dataCache._backoffInitialDelay > 0) {
                                nextDelay = getBackoffDelay(
                                    dataCache._failureCount,
                                    dataCache._backoffInitialDelay * 1000,
                                    dataCache._backoffMaxDelay * 1000
                                );
                            }
                            //cache is not close then set timeout loop again
                            dataCache._timeoutLoop(asyncRefresh, nextDelay);
                        } catch (unexpectedError) {
                            //do nothing
                            console.error("unexpected error in set refresh time after error")
                        }
                    });
                }, time);
            }
            , configurable: false, enumerable: false, writable: false
        });

        /**
         * refreshDaysInMs = days to refresh, 0 mean run at refreshAt.msFrom00_00 today, or next day if time is pass  refreshAt.msFrom00_00.
         */
        Object.defineProperty(this, "_refreshAtLoop", {
            value: (asyncRefresh, refreshAt, refreshDaysInMs = 0) => {
                const now = Date.now();
                const nowMs = nowMsFrom00_00();
                const diffTime = refreshAt.msFrom00_00 - nowMs;
                //refreshDaysInMs == 0 then run today or tomorrow
                const daysInMsToRun = (refreshDaysInMs == 0) ? (diffTime > 0 ? 0 : aDayInMS) : refreshDaysInMs;
                const runInMS = daysInMsToRun + diffTime;
                dataCache._runInMs = runInMS;
                dataCache._timeoutId = setTimeout(function () {
                    if (dataCache.isClose === true) {
                        return;
                    }
                    asyncRefresh().then(() => {
                        //if pass then timeoutLoop for the next refresh
                        if (dataCache.isClose === true) {
                            return;
                        }
                        dataCache._failureCount = 0;
                        //cache is not close then set timeout loop again
                        dataCache._refreshAtLoop(asyncRefresh, refreshAt, refreshAt.daysMs);
                    }).catch(err => {
                        try {
                            if (dataCache.isClose === true) {
                                return;
                            }
                            dataCache._failureCount++;
                            if (dataCache._onError) {
                                dataCache._onError(err);
                            } else {
                                console.error("error when refrech cache")
                                console.error(err.stack)
                            }

                            if (dataCache._backoffInitialDelay > 0) {
                                const backoffDelay = getBackoffDelay(
                                    dataCache._failureCount,
                                    dataCache._backoffInitialDelay * 1000,
                                    dataCache._backoffMaxDelay * 1000
                                );
                                dataCache._runInMs = backoffDelay;
                                dataCache._runAt = new Date(Date.now() + backoffDelay);
                                
                                const runBackoff = () => {
                                    dataCache._timeoutId = setTimeout(function() {
                                        if (dataCache.isClose === true) return;
                                        asyncRefresh().then(() => {
                                            if (dataCache.isClose === true) return;
                                            dataCache._failureCount = 0;
                                            dataCache._refreshAtLoop(asyncRefresh, refreshAt, refreshAt.daysMs);
                                        }).catch(backoffErr => {
                                            try {
                                                if (dataCache.isClose === true) return;
                                                dataCache._failureCount++;
                                                if (dataCache._onError) {
                                                    dataCache._onError(backoffErr);
                                                } else {
                                                    console.error("error when refrech cache")
                                                    console.error(backoffErr.stack)
                                                }
                                                const nextBackoffDelay = getBackoffDelay(
                                                    dataCache._failureCount,
                                                    dataCache._backoffInitialDelay * 1000,
                                                    dataCache._backoffMaxDelay * 1000
                                                );
                                                dataCache._runInMs = nextBackoffDelay;
                                                dataCache._runAt = new Date(Date.now() + nextBackoffDelay);
                                                runBackoff();
                                            } catch (unexpectedError) {
                                                console.error("unexpected error in set refresh time after error")
                                            }
                                        });
                                    }, dataCache._runInMs);
                                };
                                runBackoff();
                            } else {
                                dataCache._refreshAtLoop(asyncRefresh, refreshAt, refreshAt.daysMs);
                            }
                        } catch (unexpectedError) {
                            //do nothing
                            console.error("unexpected error in set refresh time after error")
                        }
                    });
                }, runInMS);
                dataCache._runAt = new Date(now + runInMS);
            }
            , configurable: false, enumerable: false, writable: false
        });
        // Configure the miss cache once, shared by fetchByKey and fetchByKeys.
        const setupMissCache = () => {
            if ('maxMiss' in this) return;
            const maxMiss = options.maxMiss === undefined ? 2000 : options.maxMiss;
            if (!Number.isInteger(maxMiss) || maxMiss < 0) throw new Error("Invalid maxMiss");
            const maxAgeMiss = options.maxAgeMiss === undefined ? refreshAge : options.maxAgeMiss;
            if (!Number.isInteger(maxAgeMiss) || maxAgeMiss < 0) throw new Error("Invalid maxAgeMiss");
            Object.defineProperty(this, "maxMiss", { get: () => maxMiss, configurable: false, enumerable: true });
            Object.defineProperty(this, "maxAgeMiss", { get: () => maxAgeMiss, configurable: false, enumerable: true });
            if (maxMiss > 0) {
                const _missLRUCache = new LRUCache(maxAgeMiss > 0 ? { max: maxMiss, ttl: maxAgeMiss * 1000 } : { max: maxMiss })
                Object.defineProperty(this, "_missCache", { get: () => _missLRUCache, configurable: false, enumerable: false });
            }
        };

        const fetchByKey = options.fetchByKey;
        if (typeof (fetchByKey) === "function") {
            Object.defineProperty(this, "_fetchByKey", { value: fetchByKey, configurable: false, enumerable: false, writable: false });
            const _isAsyncFetchByKey = util.types.isAsyncFunction(fetchByKey);
            Object.defineProperty(this, "_isAsyncFetchByKey", { get: () => _isAsyncFetchByKey, configurable: false, enumerable: false });
            setupMissCache();
        }

        const fetchByKeys = options.fetchByKeys;
        if (typeof (fetchByKeys) === "function") {
            Object.defineProperty(this, "_fetchByKeys", { value: fetchByKeys, configurable: false, enumerable: false, writable: false });
            const _isAsyncFetchByKeys = util.types.isAsyncFunction(fetchByKeys);
            Object.defineProperty(this, "_isAsyncFetchByKeys", { get: () => _isAsyncFetchByKeys, configurable: false, enumerable: false });
            setupMissCache();
        }

        Object.defineProperty(this, "_pendingFetches", { value: new Map(), configurable: false, enumerable: false });
    }

    async init() {
        const data = this._isAsyncFetch ? await this._fetch(this.passRecentKeysOnRefresh ? [] : undefined) : this._fetch(this.passRecentKeysOnRefresh ? [] : undefined);
        if (!(Symbol.iterator in Object(data)) && !(Symbol.asyncIterator in Object(data))) throw new Error("fetch return non iterable data");
        for await (const [key, value] of data) {
            if (this.size >= this.max) break;
            this._cache.set(key, value);
        }

        const asyncRefresh = async () => {
            if (this.max <= 0) return; // nothing to refresh when caching is disabled
            const startTime = performance.now();
            const recentKeys = [];
            if (this.size > 0) {
                // forEach skips expired keys and does not bump recency
                this._cache.forEach((value, key) => recentKeys.push(key));
            }
            const dataIterator = this._isAsyncFetch ? await this._fetch(this.passRecentKeysOnRefresh ? recentKeys : undefined) : this._fetch(this.passRecentKeysOnRefresh ? recentKeys : undefined);
            const isIterator = Symbol.iterator in Object(dataIterator);
            const isAsyncIterator = Symbol.asyncIterator in Object(dataIterator)
            if (!isIterator && !isAsyncIterator) throw new Error("fetch return non iterable data");
            const nextIterator = isAsyncIterator ? dataIterator[Symbol.asyncIterator]() : dataIterator[Symbol.iterator]();
            const firstItdata = isAsyncIterator ? await nextIterator.next() : nextIterator.next();
            
            if (firstItdata.done || !Array.isArray(firstItdata.value)) {
                const durationMs = performance.now() - startTime;
                this._updateRefreshLatency(durationMs);
                this._refreshes++;
                if (this._onRefresh) {
                    this._onRefresh({ durationMs, keysLoaded: 0, keysUpdated: 0 });
                }
                return; // fetch yielded no data
            }
            
            const firstItem = { key: firstItdata.value[0], value: firstItdata.value[1] };
            let keysUpdated = 0;

            // Snapshot prior values so we can detect changed keys. In reset mode we
            // clear the cache up front, so the snapshot Map is the only old-value
            // source; otherwise we read live from the (stale-pruned) cache.
            let oldValues;
            if (this.resetOnRefresh == true) {
                oldValues = new Map();
                this._cache.forEach((v, k) => oldValues.set(k, v));
                this._cache.clear();
            } else {
                this._cache.purgeStale();
                oldValues = this._cache;
            }
            const countMismatch = (key, newValue) => {
                if (oldValues.has(key)) {
                    const oldVal = oldValues instanceof Map ? oldValues.get(key) : oldValues.peek(key);
                    if (!this._isEqual(oldVal, newValue)) {
                        keysUpdated++;
                        this._mismatches++;
                    }
                }
            };

            countMismatch(firstItem.key, firstItem.value);
            if (this._missCache !== undefined) this._missCache.purgeStale();
            this._cache.set(firstItem.key, firstItem.value);

            let i = 1; // first item already consumed above
            for await (const [key, value] of nextIterator) {
                if (i >= this.max) break;
                i++;
                countMismatch(key, value);
                this._cache.set(key, value);
            }

            const durationMs = performance.now() - startTime;
            this._updateRefreshLatency(durationMs);
            this._refreshes++;
            if (this._onRefresh) {
                this._onRefresh({ durationMs, keysLoaded: i, keysUpdated });
            }
        }
        /**
         * async fetch data using fetch function and reset cache if and only if resetOnRefresh option is true. 
         * @property {object} */
        Object.defineProperty(this, "asyncRefresh", { value: asyncRefresh, configurable: false, enumerable: false, writable: false });
        if (this.refreshAt) {
            //not init data because it will run at the specific time
            await this._refreshAtLoop(asyncRefresh, this.refreshAt, this.refreshAt.daysMs);
        } else {
            await this._timeoutLoop(asyncRefresh, this.refreshAge * 1000);
        }
    }
    // Evict an item that failed checkValidity, mirror the eviction into the miss
    // cache, and record it as both an invalidation and a miss.
    _invalidate(key) {
        this._cache.delete(key);
        if (this._missCache !== undefined) this._missCache.delete(key);
        this._invalidations++;
        this._misses++;
    }

    _updateMissFetchLatency(ms) {
        this._missFetchCount++;
        this._missFetchSumMs += ms;
        if (this._missFetchMinMs === null || ms < this._missFetchMinMs) this._missFetchMinMs = ms;
        if (this._missFetchMaxMs === null || ms > this._missFetchMaxMs) this._missFetchMaxMs = ms;
    }

    _updateBatchFetchLatency(ms, keysCount) {
        this._batchFetchCount++;
        this._batchFetchSumMs += ms;
        this._batchFetchKeysCount += keysCount;
        if (this._batchFetchMinMs === null || ms < this._batchFetchMinMs) this._batchFetchMinMs = ms;
        if (this._batchFetchMaxMs === null || ms > this._batchFetchMaxMs) this._batchFetchMaxMs = ms;
    }

    _updateRefreshLatency(ms) {
        this._refreshCount++;
        this._refreshSumMs += ms;
        if (this._refreshMinMs === null || ms < this._refreshMinMs) this._refreshMinMs = ms;
        if (this._refreshMaxMs === null || ms > this._refreshMaxMs) this._refreshMaxMs = ms;
    }

    get metrics() {
        const hitAvgMs = this._hitCount > 0 ? this._hitSumMs / this._hitCount : 0;
        const missFetchAvgMs = this._missFetchCount > 0 ? this._missFetchSumMs / this._missFetchCount : 0;
        const batchFetchAvgMs = this._batchFetchCount > 0 ? this._batchFetchSumMs / this._batchFetchCount : 0;
        const refreshAvgMs = this._refreshCount > 0 ? this._refreshSumMs / this._refreshCount : 0;

        const avgBatchSize = this._batchFetchCount > 0 ? this._batchFetchKeysCount / this._batchFetchCount : 0;
        const batchPerKeyMs = avgBatchSize > 0 ? batchFetchAvgMs / avgBatchSize : 0;
        const batchEfficiency = batchPerKeyMs > 0 ? missFetchAvgMs / batchPerKeyMs : 0;

        // timeSavedMs is a counterfactual estimate: hits * (avg miss-fetch cost - avg hit cost).
        // It is only meaningful when there is a measured per-key fetch baseline to compare
        // against. With no miss-fetch samples (e.g. a refresh-only/Active-Only strategy),
        // missFetchAvgMs is 0 and the subtraction would yield a bogus negative number, so we
        // floor the per-hit saving at 0. "Time saved" can never be negative by construction.
        const perHitSavingMs = missFetchAvgMs > hitAvgMs ? missFetchAvgMs - hitAvgMs : 0;
        const timeSavedMs = this._hits * perHitSavingMs;
        // Ratio of avg miss-fetch latency to avg hit latency. This is a per-operation LATENCY
        // ratio, NOT an application throughput speedup; treat it as a diagnostic, not a headline.
        const hitVsFetchLatencyRatio = hitAvgMs > 0 ? missFetchAvgMs / hitAvgMs : 0;
        const hitSpeedup = hitVsFetchLatencyRatio; // back-compat alias

        return {
            hits: this._hits,
            misses: this._misses,
            refreshes: this._refreshes,
            coalescedFetches: this._coalescedFetches,
            mismatches: this._mismatches,
            invalidations: this._invalidations,
            hitLatency: {
                avgMs: hitAvgMs
            },
            missFetchLatency: {
                minMs: this._missFetchMinMs !== null ? this._missFetchMinMs : 0,
                avgMs: missFetchAvgMs,
                maxMs: this._missFetchMaxMs !== null ? this._missFetchMaxMs : 0
            },
            batchFetchLatency: {
                minMs: this._batchFetchMinMs !== null ? this._batchFetchMinMs : 0,
                avgMs: batchFetchAvgMs,
                maxMs: this._batchFetchMaxMs !== null ? this._batchFetchMaxMs : 0
            },
            refreshLatency: {
                minMs: this._refreshMinMs !== null ? this._refreshMinMs : 0,
                avgMs: refreshAvgMs,
                maxMs: this._refreshMaxMs !== null ? this._refreshMaxMs : 0
            },
            timeSavedMs,
            hitVsFetchLatencyRatio,
            hitSpeedup,
            batchPerKeyMs,
            batchEfficiency
        };
    }

    gain() {
        if (this.max === 0) {
            return {
                timeSavedMs: 0,
                speedupFactor: 0,
                activeSize: 0,
                hitSizeRatio: 0,
                utilization: 0,
                recommendation: "Cache is disabled (max=0)."
            };
        }

        this._cache.purgeStale();
        const activeSize = this._cache.size;
        const utilization = activeSize / this.max;
        const hitSizeRatio = activeSize > 0 ? this._hits / activeSize : 0;

        const m = this.metrics;
        const timeSavedMs = m.timeSavedMs;
        // Per-operation latency ratio (avg miss-fetch / avg hit), NOT a throughput speedup.
        const hitVsFetchLatencyRatio = m.hitVsFetchLatencyRatio;
        const speedupFactor = hitVsFetchLatencyRatio; // back-compat alias

        let recommendation = "Cache size and TTL are optimal for the current workload.";
        if (utilization < 0.2 && hitSizeRatio < 0.5) {
            recommendation = "Cache is underutilized. Consider decreasing max size or lowering TTL.";
        } else if (utilization > 0.8 && hitSizeRatio > 2) {
            recommendation = "High efficiency and near-capacity. Consider increasing max size to capture more hits.";
        }

        return {
            timeSavedMs,
            hitVsFetchLatencyRatio,
            speedupFactor,
            activeSize,
            hitSizeRatio,
            utilization,
            recommendation
        };
    }

    /**
     * get cache value by key, return undefined if not found.
     * 
     * This method will update recently used.
     * 
     * @param {*} key 
     * @returns 
     */
    get(key) {
        const sample = this.latencySampleRate > 0 && (this._hitN++ % this._hitEvery === 0);
        const start = sample ? performance.now() : 0;
        const val = this._cache.get(key);
        if (val !== undefined) {
            if (this._checkValidity && !this._checkValidity(key, val)) {
                this._invalidate(key);
                return undefined;
            }
            this._hits++;
            if (sample) {
                this._hitCount++;
                this._hitSumMs += performance.now() - start;
            }
            return val;
        }
        this._misses++;
        return undefined;
    }

    /**
     * set cache value by key.
     * 
     * This method will update recently used.
     * 
     * @param {*} key 
     * @returns 
     */
    set(key, value) {
        this._cache.set(key, value);
    }

    /**
    * delele key from cache.
     * 
     * @param {*} key 
     * @returns 
     */
    delete(key) {
        this._cache.delete(key);
        if (this._missCache != null) this._missCache.delete(key);
    }

    /**
     * clear all keys from cache.
     * 
     * @param {*} key 
     * @returns 
     */
    clear() {
        this._cache.clear();
        if (this._missCache != null) this._missCache.clear();
    }

    /**
     * Return a generator yielding [key, value] pairs of cached items
     * @returns {Generator} a generator yielding [key, value] pairs
     */
    entries() {
        return this._cache.entries();
    }

    /**
     * get cache value by key, if it's not found try to get item using fetchByKey, return undefined if not found.
     * 
     * If fetchByKey throw exception this will throw exception as well.
     * @param {*} key
     * @returns
     */
    async getOrFetch(key, _trackMetrics = true) {
        const sample = _trackMetrics && this.latencySampleRate > 0 && (this._hitN++ % this._hitEvery === 0);
        const start = sample ? performance.now() : 0;
        let value = this._cache.get(key);
        if (value !== undefined) {
            if (this._checkValidity && !this._checkValidity(key, value)) {
                this._cache.delete(key);
                if (this._missCache !== undefined) this._missCache.delete(key);
                this._invalidations++;
                if (_trackMetrics) this._misses++;
                value = undefined;
            } else {
                if (_trackMetrics) this._hits++;
                if (sample) {
                    this._hitCount++;
                    this._hitSumMs += performance.now() - start;
                }
                return value;
            }
        } else {
            if (_trackMetrics) this._misses++;
        }

        if (this._fetchByKey !== undefined) {
            // check miss cache key, if it has been fetched already or not.
            if (this._missCache !== undefined && this._missCache.peek(key) !== undefined) return undefined;

            // Promise Coalescing (Single-flight): merge duplicate requests into one promise
            if (this._pendingFetches.has(key)) {
                if (_trackMetrics) this._coalescedFetches++;
                return this._pendingFetches.get(key);
            }

            let resolvedSync = false;
            const fetchStart = performance.now();
            const fetchPromise = (async () => {
                try {
                    const newValue = this._isAsyncFetchByKey ? await this._fetchByKey(key) : this._fetchByKey(key);
                    const durationMs = performance.now() - fetchStart;
                    this._updateMissFetchLatency(durationMs);
                    if (newValue !== undefined) {
                        this._cache.set(key, newValue);
                    } else {
                        if (this._missCache !== undefined) this._missCache.set(key, true);
                    }
                    return newValue;
                } finally {
                    resolvedSync = true;
                    this._pendingFetches.delete(key);
                }
            })();

            if (!resolvedSync) {
                this._pendingFetches.set(key, fetchPromise);
            }
            return fetchPromise;
        }
    }

    /**
     * Get values for multiple keys. Missing keys are fetched using fetchByKeys in a batch,
     * or individual getOrFetch calls concurrently as fallback.
     * @param {Array} keys 
     * @returns {Promise<Object>} An object mapping keys to values
     */
    async getOrFetchMany(keys) {
        if (!Array.isArray(keys)) throw new Error("keys must be an array");
        const result = {};
        const missingKeys = [];

        for (const key of keys) {
            const sample = this.latencySampleRate > 0 && (this._hitN++ % this._hitEvery === 0);
            const start = sample ? performance.now() : 0;
            let val = this._cache.get(key);
            if (val !== undefined) {
                if (this._checkValidity && !this._checkValidity(key, val)) {
                    this._invalidate(key);
                    missingKeys.push(key);
                } else {
                    this._hits++;
                    if (sample) {
                        this._hitCount++;
                        this._hitSumMs += performance.now() - start;
                    }
                    result[key] = val;
                }
            } else {
                this._misses++;
                missingKeys.push(key);
            }
        }

        if (missingKeys.length > 0) {
            if (this._fetchByKeys !== undefined) {
                // Filter out keys already in the miss cache
                const actualMissing = this._missCache !== undefined
                    ? missingKeys.filter(k => this._missCache.peek(k) === undefined)
                    : missingKeys;
                
                if (actualMissing.length > 0) {
                    const coalescedKeys = [];
                    const keysToFetch = [];
                    for (const k of actualMissing) {
                        if (this._pendingFetches.has(k)) {
                            coalescedKeys.push(k);
                            this._coalescedFetches++;
                        } else {
                            keysToFetch.push(k);
                        }
                    }

                    const promisesToAwait = [];

                    for (const k of coalescedKeys) {
                        promisesToAwait.push(
                            this._pendingFetches.get(k).then(val => [k, val])
                        );
                    }

                    if (keysToFetch.length > 0) {
                        const fetchStart = performance.now();
                        const batchPromise = (async () => {
                            try {
                                const fetchedData = this._isAsyncFetchByKeys ? await this._fetchByKeys(keysToFetch) : this._fetchByKeys(keysToFetch);
                                const durationMs = performance.now() - fetchStart;
                                this._updateBatchFetchLatency(durationMs, keysToFetch.length);
                                const resultMap = new Map();
                                if (fetchedData) {
                                    if (typeof fetchedData[Symbol.asyncIterator] === "function") {
                                        for await (const [k, v] of fetchedData) {
                                            resultMap.set(k, v);
                                        }
                                    } else {
                                        for (const [k, v] of fetchedData) {
                                            resultMap.set(k, v);
                                        }
                                    }
                                }
                                return resultMap;
                            } finally {
                                for (const k of keysToFetch) {
                                    this._pendingFetches.delete(k);
                                }
                            }
                        })();

                        for (const k of keysToFetch) {
                            const keyPromise = (async () => {
                                const resultMap = await batchPromise;
                                const val = resultMap.get(k);
                                if (val !== undefined) {
                                    this._cache.set(k, val);
                                } else {
                                    if (this._missCache !== undefined) this._missCache.set(k, true);
                                }
                                return val;
                            })();
                            this._pendingFetches.set(k, keyPromise);
                            promisesToAwait.push(keyPromise.then(val => [k, val]));
                        }
                    }

                    const resolved = await Promise.all(promisesToAwait);
                    for (const [k, v] of resolved) {
                        if (v !== undefined) {
                            result[k] = v;
                        }
                    }
                }
            } else {
                // Fallback to calling getOrFetch for each key concurrently (passing false to avoid double counting _misses)
                const promises = missingKeys.map(async (key) => {
                    if (this._pendingFetches.has(key)) this._coalescedFetches++;
                    const val = await this.getOrFetch(key, false);
                    return [key, val];
                });
                const resolved = await Promise.all(promises);
                for (const [k, v] of resolved) {
                    if (v !== undefined) {
                        result[k] = v;
                    }
                }
            }
        }

        return result;
    }

    /**
     * check key is cached, without update recently used
     * @param {*} key 
     * @returns 
     */
    has(key) {
        const val = this._cache.peek(key);
        if (val !== undefined) {
            if (this._checkValidity && !this._checkValidity(key, val)) {
                this._invalidate(key);
                return false;
            }
            return true;
        }
        return false;
    }
    async close() {
        if (this.isClose === true) return;//already close
        const close = true;
        Object.defineProperty(this, "isClose", { get: () => close, configurable: false, enumerable: true });
        if (this._timeoutId) {
            clearTimeout(this._timeoutId);
        }
        this._cache.clear();
    }

}

module.exports = DataCache;