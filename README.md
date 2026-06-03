# refreshed-cache
caching data with LRU Cache and refresh it within specified time.

## Concept
Data cache that include how to fetch/replace/clear items in one place to make it simple to use.

APIs have been kept to be minimal, unless there are useful use cases.
## Installation:

```javascript
npm install refreshed-cache --save
```

## Usage:

```javascript
const Cache = require("refreshed-cache");
const options = { max: 500
              , maxAge: 1200
              , refreshAge : 600 };
const fetch = ()=>Object.entries({ a: 1, b: 2, c: 3 });
const cache = new Cache(fetch,options);
await cache.init()
cache.get("a") // 1
await cache.close() //clear cache and stop refresh

```
## Cache constructor

data-cache constructor requie a fetch function, and an optional options

## Fetch function/async function

a function/async function that return a iterator/asyncIterator object that contains the [key, value] pairs for each item
e.g. Map.entries(), Object.entries(object), Async Generator Function

if Options.passRecentKeysOnRefresh is true, then recently keys (Array) will be passed to this function when refresh data

Note: the order of items in entries is important, if the max < size of entries then only 1 to max items are loaded to cached.
Therefore items must be sorted by its prority, which the most important one is the first.
## Options

* `max` The maximum size of the cache. Setting it to 0 then no data will be cached.
   Default is 10000.

* `maxAge` Maximum age in second. Expired items will be removed every refreshAge. 
   Default is 600 seconds.

* `refreshAge` refresh time in second. New data will be fetch on each refresh and expired items will be removed every refreshAge.
   Also the expired data will be prune in every refresh only the first item of each refresh successfully retrieved.
   Default is maxAge.
   note if refreshAt is specified too, then the refreshAt will be use, and ignore refreshAge.

*  `refreshAt` refresh at specific time every x days. Specific as object in format {days,at} e.g. {days:2,at: "10:00:00"}, time of the day to refresh the data
                                                days:x -- refresh every x days 
                                                at:"HH:mm:ss" -- refresh at 

* `passRecentKeysOnRefresh` pass recent keys (Array) - that not expired - to fetch function when refresh default = false.
                    This is useful when do you want to refresh the recently keys.

* `resetOnRefresh` true then reset cache on every refresh only the first item of each refresh successfully retrieved, so only the new fetch data is cached.
   Default is true

* `fetchByKey` - function/async function use to fetch value by key and and keep it to cache. fetchByKey must return value (null is count as a value), and return undefined when no data found.

* `maxMiss` -  if fetchByKey is set then this is the maximum size of the miss cache key. Setting it to 0 then no miss cache will be cached; default is 2000. if the key is fouud in miss cache key, fetchByKey will not be called.

* `maxAgeMiss` - if fetchByKey is set this is Maximum age of miss cache key in second. Expired items will be removed every refreshAge; default is refreshAge.
## API

* `async init()`
    Call this function to init cache with the data from fetch function and start the refresh cycle.
    
    This function will throw exception if fetch throw exception

* `get(key) => value`

    get the cached data using key. if no key then it will return undefined.
    
    This will update the "recently used"-ness of the key.

    The key and val can be any type. But using object as key have to same object.

* `set(key, value)`

    set the cached data using key.
    
    This will update the "recently used"-ness of the key.

    The key and val can be any type. But using object as key have to same object.

* `delete(key)`

    delete the cached data using key.

* `del(key)`

    alias of delete(), delete the cached data using key.

* `clear()`

    clear all cached data.

* `entries()`

    Return a generator yielding [key, value] pairs.

* `find(findFunction)`

    Find a value for which the supplied fn method returns a truthy value, similar to Array.find().

    The item add recently will be finded first.
    
    findFunction is called as fn(value, key, cache).

* `asyncRefresh()`

    async refresh data using fetch function and reset cache if and only if resetOnRefresh option is true, otherwise unexpired values will be kept.

* `async getOrFetch(key) => value`
    get cache value by key, if it's not found try to get item using fetchByKey, return undefined if not found.

    If fetchByKey throw exception this will throw exception as well.

* `has(key) => boolean`

    check the key is in cached. if the key is cached then return true
    
    This will not update the "recently used"-ness of the key, and not remove the expired key.

* `async close()`

    Clear the cache entirely, throwing away all values, and stop refresh.

* `size`

    Return total number of items currently in cache. Note, that
    expired items are included as part of this item count.

## Read data from CSV to cache
```javascript
const fs = require('fs');
const parse = require('csv-parse');

async function* readCSVByLine() {
    const readFileStream = fs.createReadStream(__dirname + "/keyword.csv");
    const csvParser = parse({});
    readFileStream.pipe(csvParser)
    for await (const record of csvParser) {
        yield record;
    }
    await readFileStream.destroy();//detroy unused readstream
}
const cache = new (require("refreshed-cache"))(readCSVByLine);
await cache.init();
cache.get("aa");//
await cache.close();
```
The code above will read content from CSV to cache, the first column will be keys and the second column will be values.
The cache will be refresh with update content of CSV file every 600 second (default)
## Read 4 lines from large CSV to cache

This example is read only first 4 lines from large csv since max cache is only 4

```javascript
const fs = require('fs');
const parse = require('csv-parse');

async function* readCSV4Lines() {
    const readFileStream = fs.createReadStream(__dirname + "/large.csv");
    const csvParser = parse({});
    readFileStream.pipe(csvParser)
    let i = 0;
    for await (const record of csvParser) {
        yield record;
        i++;
        if (i >= 4) break;
    }
    await readFileStream.destroy();
}
const cache = new (require("refreshed-cache"))(readCSV4Lines,{max:4});
await cache.init();
cache.get("aa");//
await cache.close();
```

## Read 10 lines from large CSV on web to cache
```javascript
var got = require('got');
const parse = require('csv-parse');
const max = 10;
async function* readCSVMaxLinesOnWeb() {
    const csvWebStream = got.stream("https://raw.githubusercontent.com/songpr/refreshed-cache/main/test/1000000.csv");
    const csvParser = parse({});
    csvWebStream.pipe(csvParser)
    let i = 0;
    for await (const record of csvParser) {
        yield record;
        i++;
        if (i == max) break
    }
    await csvWebStream.destroy();
}

const cache = new (require("refreshed-cache"))(readCSVMaxLinesOnWeb,{max});
await cache.init();
console.log(cache.get("cpPG"))//"MnelEaBbPP"
console.log(cache.get("HClmlnlM"))//"I"
console.log(cache.get("IFOBOfEOpLcJKnH"))//'PNaj'
await cache.close();
```

## Quality & Performance Metrics

### Test Coverage
`refreshed-cache` maintains **100% Line Coverage** over its core cache manager, ensuring high reliability across all refresh timer loops, cache eviction schedules, and error-handling paths.

### Memory & Performance report
* **Low Memory Footprint**: Evaluated at **~666 bytes per cache item** (storing realistic string values), keeping RAM usage highly predictable.
* **High-Load Stability**: Successfully soak tested for over **2.5 million operations** in a 5-minute high load sequence (concurrent reads, writes, manual evictions, and background refresh intervals) with 0% error rate and stable heap growth.

---

## Roadmap & Future Development

For detailed performance comparison benchmarks, database prepared statements analysis, and the future development plan, please refer to [DEVELOPMENT_PLAN.md](file:///Users/prungsiri/Projects/refreshed-cache/DEVELOPMENT_PLAN.md).