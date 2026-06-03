# refreshed-cache
caching data with LRU Cache and refresh it within specified time.

## Concept
Data cache that include how to fetch/replace/clear items in one place to make it simple to use.

APIs have been kept to be minimal, unless there are useful use cases.

## Why refreshed-cache instead of raw lru-cache?

`lru-cache`'s `fetchMethod` + `allowStale` is **pull-based**: an entry is only refreshed when *a request happens to hit it* after it goes stale. The *first* requester after expiry still pays the backend latency (stale-while-revalidate serves them stale data, not fresh). Refresh work is coupled to, and triggered by, request traffic.

`refreshed-cache` is **push-based**: `asyncRefresh()` re-fetches the entire working set on a timer (`refreshAge`) or at a wall-clock time (`refreshAt`), *independent of request traffic*. Consequences that raw `lru-cache` cannot replicate without you building it:

1. **Zero cache-miss penalty on hot data.** The working set is already fresh before requests arrive — reads stay `<0.1 ms` with no per-key revalidation stall.
2. **Bounded, predictable backend load.** With `passRecentKeysOnRefresh` + "active-only" refresh, the entire hot set is refreshed in a handful of queries per interval (e.g. ~601 queries vs. ~51,000 for lazy), regardless of read QPS. Backend load is a function of *cache size and interval*, not *traffic*.
3. **Time-aligned freshness.** `refreshAt: {days, at}` supports "rebuild the cache at 02:00 daily" — a first-class need for reference data, pricing tables, feature flags, config — that `lru-cache` has no concept of.
4. **Encapsulated data provider.** Fetch logic (`fetch`, `fetchByKey`, `fetchByKeys`) lives with the cache config, not scattered across call sites.

### At a glance

| | raw `lru-cache` (`fetchMethod` + `allowStale`) | `refreshed-cache` |
| :--- | :--- | :--- |
| Refresh model | **Pull** — on access, after stale | **Push** — on timer / wall-clock, ahead of access |
| Who pays refresh latency | First requester after expiry | Nobody (background loop does it) |
| Backend load scales with | Read traffic (QPS) | Cache size × refresh interval |
| Refresh whole hot set in one query | ✗ (per-key) | ✓ (`fetch` / `fetchByKeys`) |
| "Rebuild at 02:00 daily" | ✗ | ✓ (`refreshAt: {days, at}`) |
| Single-flight coalescing | ✓ (built in) | ✓ (`getOrFetch`) |
| Negative caching of misses | ✗ (you build it) | ✓ (`maxMiss` / `maxAgeMiss`) |

### Position
> **`refreshed-cache` is for read-heavy workloads over a bounded, slowly-changing dataset (reference/config/catalog data) where you want the hot set kept fresh *proactively on a schedule* — so no request ever pays refresh latency — rather than lazily revalidated on access like raw `lru-cache`.**

### When raw `lru-cache` is the better choice (be honest)
- Your dataset is unbounded or high-cardinality and you only ever want lazy, per-key population → use `lru-cache.fetch()`.
- You're happy serving stale-while-revalidate and don't need scheduled/time-aligned freshness.
- You need *only* coalescing or batching — `lru-cache`'s own `fetch()` already coalesces in-flight requests, and [`dataloader`](https://github.com/graphql/dataloader) already batches. `refreshed-cache`'s edge is that coalescing, batching, negative caching, and **scheduled push refresh** share one store and one config — not that any single one of those is novel.

In short: pick `refreshed-cache` when "keep the hot set warm on a schedule" is the requirement; pick raw `lru-cache` when "populate lazily on demand" is enough.

## Installation:

```javascript
npm install refreshed-cache --save
```

## Usage:

### CommonJS (CJS)
```javascript
const Cache = require("refreshed-cache");

const cache = new Cache(
  () => Object.entries({ a: 1, b: 2, c: 3 }),
  { max: 500, maxAge: 1200, refreshAge: 600 }
);

await cache.init();
console.log(cache.get("a")); // 1
await cache.close();
```

### ES Modules (ESM)
If your Node.js project utilizes native ES Modules (`"type": "module"` in `package.json`), you can import the cache directly:
```javascript
import Cache from "refreshed-cache";

const cache = new Cache(
  () => Object.entries({ a: 1, b: 2, c: 3 }),
  { max: 500, maxAge: 1200, refreshAge: 600 }
);

await cache.init();
console.log(cache.get("a")); // 1
await cache.close();
```
## TypeScript Support:

`refreshed-cache` includes built-in TypeScript type definitions out of the box (no separate `@types/refreshed-cache` installation required). 

You can instantiate `DataCache` with generic parameters for the keys and values (`DataCache<K, V>`), providing compile-time safety and IDE autocomplete:

```typescript
import DataCache from "refreshed-cache";
// Or: import DataCache = require("refreshed-cache");

interface User {
  id: string;
  name: string;
}

const fetchAllUsers = async (): Promise<Array<[string, User]>> => {
  return [["1", { id: "1", name: "Alice" }]];
};

const cache = new DataCache<string, User>(
  fetchAllUsers,
  {
    max: 1000,
    maxAge: 300,
    fetchByKey: async (id: string) => {
      return { id, name: `User ${id}` };
    }
  }
);

await cache.init();
const user = cache.get("1"); // Typed as User | undefined
console.log(user?.name);
await cache.close();
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
   Setting it to 0 disables TTL expiry (items live until evicted by LRU pressure).
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

* `maxMiss` - if `fetchByKey` or `fetchByKeys` is set, this is the maximum size of the miss-cache (bounded sidecar LRU for non-existent keys). Setting it to `0` disables the miss-cache entirely — repeated lookups for non-existent keys will always call the fetch function. Default is 2000.

* `maxAgeMiss` - if `fetchByKey` or `fetchByKeys` is set, this is the maximum age of a miss-cache entry in seconds. Setting it to `0` means miss entries never expire by age (they are only evicted by LRU pressure when the miss-cache reaches `maxMiss`). Default is `refreshAge`.
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

## Quality & Testing

**Coverage** (`npm test -- --coverage`): Statements **99.18%** · Branches **100%** · Functions **95.34%** · Lines **100%** (core `index.js` matches).

**Test run** (`npm test`): **79 passed, 1 skipped** across 17 suites. Roadmap/future-feature tests are skipped by default.

**Memory & stability**: ~**305.5 bytes** per cached item (realistic string values); soak-tested over **2.5M operations** in a 5-minute high-load sequence (concurrent reads, writes, evictions, background refresh) with 0% errors and stable heap growth.

```bash
npm test                                            # standard suite
npm test -- --coverage                              # with coverage report
npm test -- --detectOpenHandles --runInBand         # open-handle diagnostics
RUN_ROADMAP_TESTS=true npm test -- test/tdd_roadmap.test.js   # roadmap tests
```

> **Benchmarks:** measured by a process-isolated harness against a 10M-row Postgres table. Headline numbers are cited inline in the [usage patterns](#effective-production-usage-patterns-v180-features) below; full tables and methodology live in the **[Benchmark README](benchmark/README.md)**.

---

## Breaking Changes in v1.8.0

To clean up deprecated, duplicate, and sub-optimal methods in the cache API, version `1.8.0` removes the following methods:
1. **`del(key)` (Alias Removed)**: Use the standard **`delete(key)`** method instead.
2. **`find(findFunction)` (Linear Lookup Removed)**: Linear $O(N)$ searches over in-memory caches bypass the speed advantages of LRU maps and introduce performance overhead. If you need to search cached items, iterate via the native generator **`cache.entries()`** instead.

---

## Effective Production Usage Patterns (v1.8.0 Features)

While caching strategies (like Request Coalescing and Batching) are not unique to `refreshed-cache` and exist in other tools (e.g. `lru-cache`'s native `.fetch()` API, or `dataloader`), version `1.8.0` wraps them natively within its scheduled refresh and miss-cache structures to make them easy to use.

These patterns demonstrate how to configure and utilize these features effectively:

### Pattern A: Thundering Herd Protection (Request Coalescing)
**Benchmark backing:** [§5D](benchmark/README.md#d-new-features-performance-roi-request-coalescing--bulk-batching) — Single-flight coalescing drops p99 tail latency from ~240 ms (old logic, key-by-key misses) to ~35–67 ms, while cutting DB queries by ~63% (~50k vs ~135k).

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
**Benchmark backing:** [§5D](benchmark/README.md#d-new-features-performance-roi-request-coalescing--bulk-batching) — replacing key-by-key fetches with `getOrFetchMany` + `fetchByKeys` lifts throughput **2.3–2.7x** (~22–25k rps vs ~9–12k) and cuts DB queries by ~63% (~50k vs ~135k).

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
**Benchmark backing:** [§5B](benchmark/README.md#b-long-running-strategy-simulation-5-rounds-max-100000) — against a 10M-row table, Active-Only Refresh holds a ~95% hit rate while firing only **~601 DB queries per 30s window** vs ~51k for lazy fetch (a **>90x** reduction), with peak heap bounded at ~44–48 MB.

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
**Benchmark backing:** [§5E](benchmark/README.md#e-cache-penetration-attack-protection-miss-cache-5-rounds-60s-with-ttl-cycling) — under a 50%-bogus penetration attack against a 1,000-key pool, miss-cache bounds DB load to ~pool-size per `maxAgeMiss` window (**~3,060 queries/60s**) vs ~57k with `maxMiss: 0` and ~112k uncached — a **~95% reduction** — while p99 stays **~0.2 ms**.

When clients query non-existent keys (e.g. `product-non-existent-999`), a cache miss normally forces a database query. A flood of non-existent queries can take down your database (Cache Penetration Attack). 

Configure `maxMiss` and `maxAgeMiss` to track non-existent keys in a separate bounded miss-cache, preventing database lookup spam. Under sustained attack the miss-cache reduces backend load to roughly *one fetch per distinct bad key per `maxAgeMiss` interval*, not one per request.

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