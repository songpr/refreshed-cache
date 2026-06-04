# Refreshed Cache — Development Plan & Roadmap

This document reflects the **actual implemented state** of `refreshed-cache` (`index.js`, v1.8.0) and sets a deliberately scoped roadmap. It supersedes the earlier draft, which listed already-shipped features as "future work."

---

## 0. Current State (Reality Check)

| Capability | Status | Where |
| :--- | :--- | :--- |
| LRU + TTL store (wraps `lru-cache` v11) | ✅ Shipped | `index.js:64` |
| Scheduled **full refresh** on interval (`refreshAge`) | ✅ Shipped | `_timeoutLoop`, `asyncRefresh` |
| Scheduled refresh **at time-of-day** (`refreshAt`, every 1–14 days) | ✅ Shipped | `_refreshAtLoop` |
| `passRecentKeysOnRefresh` (refresh only the hot working set) | ✅ Shipped | `init` / `asyncRefresh` |
| Negative cache for misses (`fetchByKey` + `maxMiss`/`maxAgeMiss`) | ✅ Shipped | `getOrFetch` |
| **Promise coalescing / single-flight** | ✅ Shipped | `getOrFetch`, `_pendingFetches` |
| **Batch loading on miss** (`getOrFetchMany` + `fetchByKeys`) | ✅ Shipped | `getOrFetchMany:343` |
| `set` / `get` / `delete` / `clear` / `has` / `entries` | ✅ Shipped | — |
| Test suite (~150 tests across 18 files) | ✅ Shipped | `test/` |

> ✅ **Publish gate cleared:** 1.8.0 is published to npm — the coalescing, batch, observability, and backoff features are now live, not just in-repo. The §3 "does a published, honestly-documented 1.8.0 attract real users?" gate is therefore open, so Tier 2.5 work below is now actionable rather than speculative.

---

## 1. Strategic Positioning: Why Not Just Use Raw `lru-cache`?

This is the question every evaluator asks, and the README must answer it in one paragraph. The honest answer determines the library's future.

### The real differentiator: refresh is **push-based and scheduled**, not pull-based and lazy.

`lru-cache`'s `fetchMethod` + `allowStale` is **pull-based**: an entry is only refreshed when *a request happens to hit it* after it goes stale. The *first* requester after expiry still pays the backend latency (stale-while-revalidate serves them stale data, not fresh). Refresh work is coupled to, and triggered by, request traffic.

`refreshed-cache` is **push-based**: `asyncRefresh()` re-fetches the entire working set on a timer (`refreshAge`) or at a wall-clock time (`refreshAt`), *independent of request traffic*. Consequences that raw `lru-cache` cannot replicate without you building it:

1. **Zero cache-miss penalty on hot data.** The working set is already fresh before requests arrive — reads stay `<0.1 ms` with no per-key revalidation stall.
2. **Bounded, predictable backend load.** With `passRecentKeysOnRefresh` + "active-only" refresh, the entire hot set is refreshed in a handful of queries per interval (benchmark §5.B: ~601 queries vs. ~51,000 for lazy), regardless of read QPS. Backend load is a function of *cache size and interval*, not *traffic*.
3. **Time-aligned freshness.** `refreshAt: {days, at}` supports "rebuild the cache at 02:00 daily" — a first-class need for reference data, pricing tables, feature flags, config — that `lru-cache` has no concept of.
4. **Encapsulated data provider.** Fetch logic (`fetch`, `fetchByKey`, `fetchByKeys`) lives with the cache config, not scattered across call sites.

### Be honest about what is *not* a differentiator.

- **Single-flight coalescing** is also provided by `lru-cache`'s own `fetch()` (it dedupes concurrent in-flight fetches per key). Our `getOrFetch` reimplements it on top of `get` + `fetchByKey`. Keep it — but don't market it as unique.
- **Batch loading** overlaps conceptually with `dataloader`. Our edge is that it shares the same store and miss-cache as the rest of the API, not that batching itself is novel.

### Positioning sentence (for the README):

> **`refreshed-cache` is for read-heavy workloads over a bounded, slowly-changing dataset (reference/config/catalog data) where you want the hot set kept fresh *proactively on a schedule* — so no request ever pays refresh latency — rather than lazily revalidated on access like raw `lru-cache`.**

If a use case doesn't match that sentence, the honest recommendation is raw `lru-cache` (`fetchMethod` + `allowStale`). Owning a narrow, correct niche beats pretending to be a general cache.

---

## 2. Roadmap (Scoped)

### Tier 1 — Finish what exists (do now, low cost, high credibility)
- ✅ **Publish 1.8.0** to npm — done.
- **Document `getOrFetch`, `getOrFetchMany`, single-flight, and the miss cache** in the README (they exist in code but not in the published docs).
- **Add the "why not raw lru-cache" section** (above) verbatim to the README.
- **Fix the benchmark harness** (see `benchmark/README.md` audit) so the numbers are defensible, then lead with the single strongest chart: equal hit-rate at ~90× fewer backend queries.
- **TypeScript types** (`index.d.ts`). Cheap, and a hard adoption blocker for many teams today.

### Tier 2 — Sharpen the core (✅ SHIPPED in 1.8.0)

All three Tier 2 items are now implemented and tested. This section is kept as a record of the rationale, not as open work.

*   **Observability Hooks & Metrics** — ✅ **Shipped.** `metrics` getter (`index.js:396`) exposes `hits` / `misses` / `refreshes` / `coalescedFetches` / `mismatches` / `invalidations`; `onRefresh` / `onError` callbacks (`index.js:46–52`) emit structured signals for APM/alerting instead of bare `console.error`.
    *   **Why it was needed / Real-world case**: Production systems require strict monitoring of **Cache Hit Rate (CHR)**. A drop in CHR directly correlates with database latency spikes. Without callbacks, it was impossible to alert on persistent refresh failures or dynamically track cache health.
    *   **ROI**: **Extremely High.** Hard prerequisite for enterprise/production readiness — SRE teams will not approve caches without metrics and alerts.
*   **Per-Refresh Error Backoff & Jitter** — ✅ **Shipped.** Exponential backoff with jitter on repeated `asyncRefresh` failures (`index.js:218`) instead of retrying at the full `refreshAge` rate.
    *   **Why it was needed / Real-world case**: During backend outages a naive refresh loop acts as a self-inflicted DDoS (a **retry storm**), keeping an already-overloaded database down. Backoff with jitter spreads retries so the downstream can recover.
    *   **ROI**: **High.** Protects the database/APIs from cascading failures during outages.
*   **`getOrFetchMany` Single-Flight Coalescing** — ✅ **Shipped.** The batch path now coalesces overlapping concurrent key fetches (`index.js:576`, `index.js:640`).
    *   **Why it was needed / Real-world case**: Under heavy traffic (rendering a homepage or category catalog) many concurrent requests ask for overlapping key sets simultaneously, previously firing redundant queries.
    *   **ROI**: **Medium-High.** Resolves the thundering-herd problem for batch queries on read-heavy dashboards and GraphQL endpoints.

### Tier 2.5 — Latency aggregates & cache-gain metrics (next increment)

**Goal:** make a single read of `cache.metrics` answer two operational questions per cache — *"is this cache's backend degrading?"* and *"how much latency are we actually saving by caching?"* — without an external APM. Additionally, expose a `gain()` method that provides a comprehensive performance and sizing report during active periods.

**Design — running scalars only.** No sample arrays, no sorting, no GC pressure — this sidesteps the entire §5 percentile cost analysis, which applies *only* to percentiles.

The real cost on hot reads is the **clock call** (~100–240 ns per read, two calls per measurement) — not the arithmetic. min/max/avg updates are ~1–5 ns each and are not the constraint. Sampling exists specifically to skip the clock call on most reads.

**Buckets — what to track per path:**

| Bucket | Measured on | Hot path? | Stats tracked | Overhead |
| :--- | :--- | :--- | :--- | :--- |
| `hitLatency` | cache-hit read (`get` / `getOrFetch` / `getOrFetchMany` hit) | **Yes** (<0.1 ms) | **avg only** (`count` + `sumMs`) — min/max uniform/useless here | **sampled at 1%** |
| `missFetchLatency` | single-key backend fetch (`fetchByKey`) | No (>1 ms) | min + avg + max | always-on |
| `batchFetchLatency` | batch backend fetch (`fetchByKeys`) | No | min + avg + max | always-on |
| `refreshLatency` | `asyncRefresh` backend work | No | min + avg + max | always-on |

Hit path carries avg-only (drop min/max — hit latency is near-constant, the extremes are uninformative). Backend paths carry full min/avg/max because **tail spikes on backend calls are exactly what you need to diagnose**.

**Sampling the hit path — `latencySampleRate` (default `0.01` = 1%):**

```js
// hot path — counter-based sampling, skips clock call on 99% of reads
const sample = _trackHitLatency && (this._hitN++ % this._hitEvery === 0);
const start = sample ? performance.now() : 0;
const v = this._cache.get(key);
if (sample) { this._hitCount++; this._hitSumMs += performance.now() - start; }
```

Non-sampled reads pay only `n++ % N` (~1–2 ns). Sampled reads pay the full ~150 ns. Use a counter (`% N`), not `Math.random()` — cheaper and deterministic.

**Why 1% (`hitEvery = 100`)?** Hit latency is low-variance (Map lookup is near-uniform), so the average stabilises quickly.

**Derived gain metrics** (computed lazily in the `metrics` getter — zero hot-path cost):

*   `timeSavedMs` = `hits × (missFetchAvgMs − hitAvgMs)` — total wall-clock saved vs. always hitting the backend. The headline "gain" number. (Note: `hitAvgMs` is ~0.0001 ms and often negligible; the dominant term is `hits × missFetchAvgMs`.)
*   `hitSpeedup` = `missFetchAvgMs / hitAvgMs` — e.g. "hits are ~2,000× faster than a single fetch."
*   `batchPerKeyMs` = `batchFetchAvgMs / avgBatchSize` — per-key cost of a batch call.
*   `batchEfficiency` = `missFetchAvgMs / batchPerKeyMs` — per-key win of batching vs. individual fetches (your *fetch vs. batch* and *miss vs. batch-miss* comparisons).

**The `gain()` Method & Size Optimization (Active Reporting):**

Expose a public method `gain()` that evaluates the cache performance benefits and recommends optimization options based on active cache size and hit-to-size ratio:
*   `timeSavedMs`: Computed active savings.
*   `speedupFactor`: Average backend latency vs. hit latency.
*   `activeSize`: Current non-expired keys (obtained by calling `purgeStale()` on the cache store first).
*   `hitSizeRatio`: `hits / activeSize` (indicates cache reuse efficiency).
*   `utilization`: `activeSize / max`.
*   `recommendation`: Sizing action feedback based on utilization and hit efficiency (e.g., advising if the cache is underutilized or needs expansion).

**Cost / ROI:** ~35–55 LOC extending the existing `metrics` getter, adding the `gain()` method, and validating the `latencySampleRate` option. ROI **High** — turns the library from "fast" into "demonstrably, measurably fast per cache instance," providing operators with sizing and performance insight. Percentiles stay out of core (see §5).

### Tier 3 — Distributed invalidation (DEFERRED / likely cut)
The previous plan proposed Pub/Sub + native-`fetch`/WebSocket cache sync across nodes. **Recommendation: cut, or keep as a documented integration pattern only — do not build it into the library.**

Rationale:
- It changes the product from "an in-process cache" to "a distributed-systems component," with correctness obligations (ordering, partition behavior, delivery guarantees) that are a team-scale, ongoing commitment for a solo maintainer.
- It competes directly with Redis pub/sub, Momento, and existing invalidation libraries — on their turf.
- The earlier justification ("Undici 8 is ~30% faster", "native WebSockets avoid the `ws` dependency") is transport trivia; invalidation *correctness*, not transport speed, is the hard and risky part.
- The existing `delete(key)` / `clear()` / `asyncRefresh()` surface is already enough for users to wire their own invalidation to whatever message bus they run. **Ship a recipe, not a subsystem.**

If distributed sync is ever pursued, gate it behind real demand (issues/users asking) and ship it as a **separate optional package** (`refreshed-cache-sync`) so the core stays zero-config and single-dependency.

---

## 3. Investment Guidance (ROI)

- **Portfolio / internal-tool goal** → do Tier 1 only. The library is a strong, finished showcase of real backend engineering; stop there.
- **OSS-adoption goal** → Tier 1 is mandatory and probably sufficient to test demand. Add Tier 2 only if adoption appears.
- **"Product" goal (Tier 3)** → not advised for a solo maintainer; negative expected ROI against incumbents.

Decision gate before any Tier 2/3 work: **does published-1.8.0 + honest docs attract real users?** Let that answer, not the roadmap, drive further investment.

---

## 4. Architectural & Design Decisions

### Class Naming Rationale: `DataCache` vs. `RefreshedCache`
A common question when inspecting the codebase is why the main class is named `DataCache` while the library is published as `refreshed-cache`.

* **Domain vs. Mechanism:** The package name `refreshed-cache` describes the *refresh mechanism* (push-based/scheduled refreshing). The class name `DataCache` describes the *domain responsibility* (acting as a local cache/provider for general application data, such as product catalogs, user profiles, or config maps).
* **Consumer Autonomy:** Since the class is exported directly via standard CommonJS (`module.exports = DataCache`), consumers have total autonomy to alias it to whatever name they prefer at import time:
  ```javascript
  const Cache = require("refreshed-cache");
  const RefreshedCache = require("refreshed-cache");
  ```
* **Preserving Compatibility:** Renaming `DataCache` to `RefreshedCache` inside the source files and TypeScript typings was decided against to preserve backward compatibility. Doing so would break existing applications that import the type definitions directly (`import { DataCache } ...`) or perform runtime checks (`instanceof DataCache`).

### Testing Standards: Automatic Cache Teardown (Preventing Test Hangs)
To prevent active background timers (such as `setTimeout` loops for `refreshAge` or `refreshAt`) from keeping the Node.js event loop open and causing Jest to hang when an assertion fails, **all test files must implement an automatic cleanup registry**.

Every test file containing async refresh/timeout loops should follow this pattern:
1. Maintain a module-level `activeCaches` array.
2. Implement a `newCache` helper that registers each cache instance upon creation.
3. Clean up all registered caches using a Jest `afterEach` hook.

```javascript
let activeCaches = [];
afterEach(async () => {
    for (const cache of activeCaches) {
        try {
            await cache.close();
        } catch (e) {}
    }
    activeCaches = [];
});

function newCache(fetch, options) {
    const cache = new DataCache(fetch, options);
    activeCaches.push(cache);
    return cache;
}
```
This guarantees that even when an `expect()` throws an assertion exception, the timers are safely cleared during teardown.


---

## 5. ROI Analysis: Real-Time Latency *Percentiles* (p50/p95/p99) inside Core Cache Metrics

> **Scope note:** This section argues against **percentiles** specifically (which require sample storage + sorting). It is *not* an argument against all latency metrics. Cheap **aggregates** — min/avg/max running scalars on the fetch/refresh path, plus a sampled hit average for savings math — are the recommended subset and are planned as **Tier 2.5** above. Read the two together: aggregates **yes**, percentiles **no**.

### Proposal: Exposing `metrics.p50`, `metrics.p95`, and `metrics.p99`
*   **What**: Directly track the latency of read operations (`get`, `getOrFetch`, `getOrFetchMany`) inside the core cache class and expose real-time percentiles.
*   **Cost**: Low/Medium implementation complexity (~100 LOC), but **Extremely High** performance and latency overhead.

---

### Detailed ROI & Performance Overhead Analysis

#### 1. Hot Path Latency Impact (Microsecond Budget)
*   **The Baseline**: A standard in-memory cache hit (Map lookup + LRU update) is extremely fast, taking **~50ns – 150ns** on modern hardware.
*   **The Timing Cost**: Invoking `process.hrtime.bigint()` (or `performance.now()`) requires wrapping system/hardware clock calls. A single call to `process.hrtime.bigint()` takes **~50ns – 120ns** depending on the CPU and OS virtualization layer.
*   **The Math**: Because timing requires two calls (one before and one after the operation), the timing overhead alone adds **~100ns – 240ns** per read.
*   **Latency Penalty**: This adds a **100% to 240% latency penalty** to cache hits, making them 2x to 3.4x slower. For cache hits (the dominant path in heavy workloads), this is a critical regression.
*   **Cache Miss Scenario**: For cache misses, backend API/DB latency is typically `>1ms` (`1,000,000ns`). The timing overhead is `<0.02%` of the total miss duration, which is negligible. However, since the cache's goal is to maximize hit performance, degrading hits for the sake of measuring them is a poor trade-off.

#### 2. Memory Footprint & Garbage Collection (GC) Pressure
*   **Unbounded Storage (Anti-Pattern)**: Storing latency numbers in an array for every request will eventually consume all available heap space, causing Out Of Memory (OOM) crashes.
*   **Circular Buffer/Sliding Window**: To prevent memory leaks, we must limit the sample size (e.g., a rolling window of the last 10,000 requests).
*   **GC Overhead**: Appending, slicing, and shifting elements in JavaScript arrays generates transient garbage objects. Under a throughput of 20,000 RPS, Node.js will trigger frequent garbage collection cycles, causing application-wide latency spikes (stuttering).
*   **Pre-allocated TypedArrays**: Using a pre-allocated typed array (e.g., `Float64Array`) prevents object allocation, but still requires managing write pointers and sorting.

#### 3. CPU Cost (Event Loop Blocking)
*   **Sorting Complexity**: Percentile calculations require sorting the dataset ($O(N \log N)$ complexity). Sorting a rolling window of 10,000 elements in JavaScript blocks the single-threaded event loop for **~0.2ms – 0.5ms**.
*   **Throughput Impact**: If percentiles are calculated on the hot path or polled frequently, it stalls the event loop, decreasing the maximum QPS throughput of the hosting application.

---

### Strategic Recommendation: **DO NOT IMPLEMENT PERCENTILES IN CORE**

Exposing real-time latency *percentiles* directly inside the core library is **not recommended** — the sample storage + sorting cost contradicts the primary purpose of `refreshed-cache`: ultra-low-latency in-memory reads. (Cheap min/avg/max aggregates do **not** carry this cost and are recommended — see Tier 2.5.)

#### The Correct Architectural Pattern: **APM / Wrapper Layer**
Latency percentiles belong in the **Application/APM layer** (using OpenTelemetry, Prometheus, Datadog, or custom middleware wrappers). APM libraries are highly optimized for this, using native bindings or lock-free metric aggregators (like HDR Histograms) that run out-of-process or asynchronously.

```javascript
// Recommended APM instrumentation pattern (Opt-in by application developers)
const cache = new DataCache(fetchFn);

async function measuredGet(key) {
  const start = process.hrtime.bigint();
  try {
    return await cache.getOrFetch(key);
  } finally {
    const durationNs = process.hrtime.bigint() - start;
    apm.recordHistogram('cache.read.latency', Number(durationNs) / 1e6);
  }
}
```

#### Fallback Alternative: Sampled Circular Buffer (Opt-in Only)
If native latency tracking is ever implemented, it must be strictly opt-in and heavily optimized:
1. **Disabled by Default**: Must be explicitly enabled via options (e.g., `{ collectLatencyMetrics: true }`).
2. **Sampling Rate**: Support sampling (e.g., `sampleRate: 0.01` to only measure 1% of operations) to minimize hot-path clock calls.
3. **Fixed Memory Window**: Store samples in a pre-allocated cyclic `Float32Array` of limited size (e.g., 1,000 slots) to guarantee zero GC allocation overhead.
4. **Lazy Percentiles**: Only calculate percentiles when the getter is queried, avoiding constant sorting overhead.

