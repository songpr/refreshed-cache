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
                                                days:x -- refresh every x days (x must be 1-14)
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

* `clear()`

    clear all cached data.

* `entries()`

    Return a generator yielding [key, value] pairs.

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
Latest coverage from `npm test -- --coverage`:

* Statements: **99.18%**
* Branches: **100.00%**
* Functions: **95.34%**
* Lines: **100.00%**

Core file coverage (`index.js`) matches the overall values above.

### Test Execution Summary
Latest full test run (`npm test`) results:

* Test suites: **16 passed, 1 skipped, 17 total**
* Tests: **79 passed, 1 skipped, 80 total**

Roadmap tests are intentionally skipped by default and can be enabled via environment variable.

---

## High-Concurrency Benchmark Results (10,000,000 Rows, 5 Rounds)

For detailed setups, scripts, and cost analyses, please refer to the [Benchmark README](benchmark/README.md).

### A. Standard Scenario Query Speedup (50,000 Lookups)
Comparing **Direct Prepared Statements (No Cache)** against the Cache across different sizes:

| Scenario | Cache Size | Avg DB Ops/sec | Avg Cache Ops/sec | DB Queries Cache | Speedup | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Small Cache** (1% coverage) | 10,000 | ~17,600 | ~48,600 | 20,800 | **2.76x** | ✅ PASSED |
| **Medium Cache** (10% coverage) | 100,000 | ~15,600 | ~42,800 | 16,200 | **2.74x** | ✅ PASSED |
| **Large Cache** (50% coverage) | 500,000 | ~15,100 | ~37,600 | 15,300 | **2.49x** | ✅ PASSED |

### B. Shifting-Load Caching Strategies (5 Rounds, max: 100,000)
Under shifting workloads (sliding window pool of 120,000 keys) with a strict limit of `max: 100000` keys:
* **Active-Only Refresh Cache (Strategy C)**: Achieved the same **95% hit rate** as standard caching strategies, but reduced database query traffic by **over 90x** (from 50,000+ lookups to under 601), keeping heap growth minimal (~4 MB).

### C. Sustained Concurrent Load Test (Key-by-Key Fallback Limits)
Under high concurrent single-key miss storms, standard cache-miss strategies run into database connection pool bottlenecks:
* **Connection Pool Saturation**: Firing individual single-key fetches (`cache.getOrFetch(key)`) for cache misses under high concurrency saturates the Postgres client connection pool.
* **Latency Alignment**: Due to socket queueing delays, standard caching latencies align with the direct prepared statement baseline (~240 ms p99).

### D. New Features Performance ROI (Promise Coalescing & Bulk Batching)
By implementing Single-flight Promise Coalescing and Bulk Batch Loading, the queueing bottleneck is completely resolved:
* **Throughput Boost**: Scales throughput by **over 4x** (from ~5,500 rps with old caching architecture to **~24,500 rps**).
* **Latency ROI**: Drops tail latency (p99) from **~285 ms** to **~31 ms** under high stress.
* **DB Query Reduction**: Cuts total database queries triggered in half (e.g., from 103,837 queries to 51,514), protecting the database from thundering herd storms.
* **Peak Memory Optimization**: Reduces peak heap memory usage by **over 4x** (from ~330 MB to ~75 MB) by eliminating microtask delay wrappers (replacing deferred fetches with direct async IIFEs) and switching from async `for await` iteration to standard synchronous `for` loops for synchronous database result arrays.

### E. Deep Dive: Connection Pool Queueing & Why New Features Matter
* **Why C aligns with DB baseline**: In load test C, the active sliding window (120,000 keys) is wider than the cache capacity (100,000 keys). This forces constant evictions and triggers over **56,000 - 65,000 individual DB queries**. Because these are executed key-by-key, they saturate the Postgres client pool, causing queueing delays that affect both cache misses and direct prepared statements.
* **How D resolves the bottleneck**: Single-flight Promise Coalescing coalesces concurrent duplicate reads targeting the same hot keys into a single database query. Meanwhile, Bulk Batch Loading groups batch requests into a single SQL statement (`WHERE uuid IN (...)`). By eliminating redundant database roundtrips, it prevents connection pool saturation, dropping p99 tail latency by **90%** (to ~31 ms) and scaling throughput to **~24,500 rps**.

---

## Testing

Run the standard suite:

```bash
npm test
```

Run with coverage report:

```bash
npm test -- --coverage
```

Run open-handle diagnostics (serial mode):

```bash
npm test -- --detectOpenHandles --runInBand
```

Run roadmap/future-feature tests explicitly:

```bash
RUN_ROADMAP_TESTS=true npm test -- test/tdd_roadmap.test.js
```

### Memory & Performance report
* **Low Memory Footprint**: Evaluated at **~305.5 bytes per cache item** (storing realistic string values), keeping RAM usage highly predictable.
* **High-Load Stability**: Successfully soak tested for over **2.5 million operations** in a 5-minute high load sequence (concurrent reads, writes, manual evictions, and background refresh intervals) with 0% error rate and stable heap growth.

## Breaking Changes in v1.8.0

To clean up deprecated, duplicate, and sub-optimal methods in the cache API, version `1.8.0` removes the following methods:
1. **`del(key)` (Alias Removed)**: Use the standard **`delete(key)`** method instead.
2. **`find(findFunction)` (Linear Lookup Removed)**: Linear $O(N)$ searches over in-memory caches bypass the speed advantages of LRU maps and introduce performance overhead. If you need to search cached items, iterate via the native generator **`cache.entries()`** instead.

---

## Effective Production Usage Patterns (v1.8.0 Features)

Version `1.8.0` introduces core architectural upgrades to handle high-concurrency enterprise workloads. By combining Single-flight Promise Coalescing, Bulk Batching, and memory-optimized synchronous fast-paths, the library provides a robust solution for large-scale Node.js applications.

### Pattern A: Thundering Herd Protection (Promise Coalescing)
If your app experiences spikes of duplicate requests targeting the same hot keys (e.g., flash sales, breaking news), configuring `fetchByKey` automatically coalesces concurrent misses into a single database query.

```javascript
const Cache = require("refreshed-cache");

const cache = new Cache(
  async () => [], // Base loader (optional for purely lazy setups)
  {
    max: 100000,
    maxAge: 300,
    fetchByKey: async (id) => {
      // Multiple concurrent calls for the same ID will coalesce here.
      // Only ONE database query is executed; others share the same returned Promise.
      return await db.query("SELECT * FROM products WHERE id = $1", [id]);
    }
  }
);

// Usage in express router
app.get("/product/:id", async (req, res) => {
  const product = await cache.getOrFetch(req.params.id);
  res.json(product);
});
```

### Pattern B: Resolving N+1 Database Queries (Bulk Batch Loading)
When loading dashboard widgets, lists, or feeds that query multiple related entities, use `fetchByKeys` and `cache.getOrFetchMany(keys)`. This groups all missing keys and fetches them in a single batch statement (e.g. `WHERE id IN (...)`) rather than iterating key-by-key.

```javascript
const cache = new Cache(
  async () => [],
  {
    max: 100000,
    maxAge: 300,
    // Batch fetcher for missing keys
    fetchByKeys: async (ids) => {
      // Query database once for all missing keys
      const rows = await db.query("SELECT id, name FROM users WHERE id = ANY($1)", [ids]);
      return rows.map(r => [r.id, r]); // Return iterable [key, value] pairs
    }
  }
);

// Usage in express router
app.get("/users/bulk", async (req, res) => {
  const userIds = req.query.ids.split(","); // e.g. [1, 5, 8, 12]
  const users = await cache.getOrFetchMany(userIds);
  res.json(users);
});
```

### Pattern C: Active-Only Memory-Efficient Caching (For Huge Datasets)
When your database contains millions of records (e.g., 10M or 100M rows), caching the entire dataset in-process is impossible. Use the **Active-Only Refresh** strategy. It regularly refreshes only the keys that have been read since the last refresh interval, keeping the hot set warm while bounding memory usage.

```javascript
const cache = new Cache(
  async (recentKeys) => {
    // recentKeys lists only keys accessed since the last refresh cycle
    if (!recentKeys || recentKeys.length === 0) return [];
    
    const rows = await db.query("SELECT id, data FROM profiles WHERE id = ANY($1)", [recentKeys]);
    return rows.map(r => [r.id, r.data]);
  },
  {
    max: 100000,
    maxAge: 600,
    refreshAge: 300,
    resetOnRefresh: false,            // Keep existing unexpired items
    passRecentKeysOnRefresh: true     // Pass active keys list to the loader function
  }
);
```

### Pattern D: Safeguarding against Cache Penetration (Hard Miss Protection)
When clients query non-existent keys (e.g. `product-non-existent-999`), a cache miss normally forces a database query. A flood of non-existent queries can take down your database (Cache Penetration Attack). 

Configure `maxMiss` and `maxAgeMiss` to track non-existent keys in a separate bounded miss-cache, preventing database lookup spam.

```javascript
const cache = new Cache(
  async () => [],
  {
    max: 100000,
    fetchByKey: async (sku) => {
      const item = await db.query("SELECT * FROM items WHERE sku = $1", [sku]);
      return item || undefined; // Returning undefined puts the key into the miss cache
    },
    maxMiss: 10000,      // Bounded tracking for non-existent SKUs
    maxAgeMiss: 60       // Lock out non-existent keys for 60 seconds
  }
);
```

---

## Roadmap & Future Development

For detailed performance comparison benchmarks, database prepared statements analysis, and the future development plan, please refer to [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).