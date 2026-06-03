const util = require('util');
const { LRUCache } = require("lru-cache");
const timeAtRegex = /^(2[0-3]|1[0-9]|0?[0-9]):([1-5][0-9]|0?[0-9]):([1-5][0-9]|0?[0-9])$/
const aDayInMS = 24 * 60 * 60 * 1000;
function nowMsFrom00_00() {
    const now = new Date();
    return now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
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
        const maxAge = options.maxAge || 600;
        if (!Number.isInteger(maxAge)) throw new Error("Invalid maxAge");
        const refreshAge = options.refreshAge || maxAge;
        if (!Number.isInteger(refreshAge)) throw new Error("Invalid refreshAge");
        const resetOnRefresh = options.resetOnRefresh === undefined ? true : options.resetOnRefresh;
        if (typeof (resetOnRefresh) !== "boolean") throw new Error("Invalid resetOnRefresh");
        if (options.refreshAt != null) {
            const { days, at } = options.refreshAt;
            if (!Number.isInteger(days) || days < 0 || days > 14) throw new Error("Invalid refreshAt.days, support 1-14");
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
        const max = options.max || 10000;
        if (!Number.isInteger(max)) throw new Error("Invalid max");
        Object.defineProperty(this, "passRecentKeysOnRefresh", { get: () => passRecentKeysOnRefresh, configurable: false, enumerable: true });
        Object.defineProperty(this, "maxAge", { get: () => maxAge, configurable: false, enumerable: true });
        Object.defineProperty(this, "refreshAge", { get: () => refreshAge, configurable: false, enumerable: true });
        Object.defineProperty(this, "resetOnRefresh", { get: () => resetOnRefresh, configurable: false, enumerable: true });
        Object.defineProperty(this, "max", { get: () => max, configurable: false, enumerable: true });
        const _lruCache = new LRUCache({ max: max, ttl: maxAge * 1000 })
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
                        //cache is not close then set timeout loop again
                        dataCache._timeoutLoop(asyncRefresh, time);
                    }).catch(err => {
                        try {
                            if (dataCache.isClose === true) {
                                return;
                            }
                            console.error("error when refrech cache")
                            console.error(err.stack)
                            //cache is not close then set timeout loop again
                            dataCache._timeoutLoop(asyncRefresh, time);
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
                        //cache is not close then set timeout loop again
                        dataCache._refreshAtLoop(asyncRefresh, refreshAt, refreshAt.daysMs);
                    }).catch(err => {
                        try {
                            if (dataCache.isClose === true) {
                                return;
                            }
                            console.error("error when refrech cache")
                            console.error(err.stack)
                            //cache is not close then set timeout loop again
                            dataCache._refreshAtLoop(asyncRefresh, refreshAt, refreshAt.daysMs);
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
        //getOrRefresh option
        const fetchByKey = options.fetchByKey;
        if (typeof (fetchByKey) === "function") {
            Object.defineProperty(this, "_fetchByKey", { value: fetchByKey, configurable: false, enumerable: false, writable: false });
            const _isAsyncFetchByKey = util.types.isAsyncFunction(fetchByKey);
            Object.defineProperty(this, "_isAsyncFetchByKey", { get: () => _isAsyncFetchByKey, configurable: false, enumerable: false });
            const maxMiss = options.maxMiss || 2000;
            if (!Number.isInteger(maxMiss)) throw new Error("Invalid maxMiss");
            const maxAgeMiss = options.maxAgeMiss || refreshAge;
            if (!Number.isInteger(maxAgeMiss)) throw new Error("Invalid maxAgeMiss");
            const _missLRUCache = new LRUCache({ max: maxMiss, ttl: maxAgeMiss * 1000 })
            Object.defineProperty(this, "_missCache", { get: () => _missLRUCache, configurable: false, enumerable: false });
            Object.defineProperty(this, "maxMiss", { get: () => maxMiss, configurable: false, enumerable: true });
            Object.defineProperty(this, "maxAgeMiss", { get: () => maxAgeMiss, configurable: false, enumerable: true });
        }
    }

    async init() {
        const data = this._isAsyncFetch ? await this._fetch(this.passRecentKeysOnRefresh ? [] : undefined) : this._fetch(this.passRecentKeysOnRefresh ? [] : undefined);
        if (!(Symbol.iterator in Object(data)) && !(Symbol.asyncIterator in Object(data))) throw new Error("fetch return non iterable data");
        for await (const [key, value] of data) {
            if (this.size >= this.max) break;
            this._cache.set(key, value);
        }

        const asyncRefresh = async () => {
            if (this.max <= 0) return;// max <=0 then do not refresh since it cannot cache
            const recentKeys = [];
            if (this.size > 0) {
                //get recent keys to referesh thier value, the expired key will not be included, and this function do not change recently ness 
                this._cache.forEach((value, key, cache) => {
                    recentKeys.push(key);
                });
            }
            const dataIterator = this._isAsyncFetch ? await this._fetch(this.passRecentKeysOnRefresh ? recentKeys : undefined) : this._fetch(this.passRecentKeysOnRefresh ? recentKeys : undefined);
            const isIterator = Symbol.iterator in Object(dataIterator);
            const isAsyncIterator = Symbol.asyncIterator in Object(dataIterator)
            if (!isIterator && !isAsyncIterator) throw new Error("fetch return non iterable data");
            const nextIterator = isAsyncIterator ? dataIterator[Symbol.asyncIterator]() : dataIterator[Symbol.iterator]();
            const firstItdata = isAsyncIterator ? await nextIterator.next() : nextIterator.next();
            if (firstItdata.done === true || !Array.isArray(firstItdata.value)) return;//no data
            const firstItem = { key: firstItdata.value[0], value: firstItdata.value[1] };
            //reset after check data is valid, and can get first key,value
            if (this.resetOnRefresh == true) {
                //no need to prune since it all
                this._cache.clear();//reset on each refresh
            } else {
                this._cache.purgeStale()// remove expired items before insert new fetch so left only non expired recently use cache items.
            }
            if (this._missCache !== undefined) this._missCache.purgeStale();
            this._cache.set(firstItem.key, firstItem.value);
            if (firstItdata.done == true) return; //no more data
            let i = 1; //start from 1 since we already read 1
            //async iterator
            for await (const [key, value] of nextIterator) {
                if ((++i) > this.max) break; // add items do not exceed max
                this._cache.set(key, value);
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


    /**
     * get cache value by key, return undefined if not found.
     * 
     * This method will update recently used.
     * 
     * @param {*} key 
     * @returns 
     */
    get(key) {
        return this._cache.get(key);
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
        //remove miss cache too. since we remove key from cache
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
        //clear miss cache too. since we clear keys from cache
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
     * @returns value ehn
     */
    async getOrFetch(key) {
        const value = this._cache.get(key);
        //miss cache
        if (value !== undefined) return value;
        if (this._fetchByKey !== undefined) {
            //check miss cache key,if it have been try to fetch already or not.
            //To prevent it to repeatly fetch on really miss cache key, until the missd key cache is expired
            if (this._missCache.peek(key) !== undefined) return undefined; //peek will not update recentness of this missed key so allow it to expired.
            const newValue = this._isAsyncFetchByKey ? await this._fetchByKey(key) : this._fetchByKey(key);
            if (newValue !== undefined) {
                this._cache.set(key, newValue)
            } else {
                this._missCache.set(key, true);
            };
            return newValue;
        }
    }

    /**
     * check key is cached, without update recently used
     * @param {*} key 
     * @returns 
     */
    has(key) {
        return this._cache.has(key);
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