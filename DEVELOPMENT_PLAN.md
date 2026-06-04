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
- ✅ **Document `getOrFetch`, `getOrFetchMany`, single-flight, and the miss cache** in the README (they exist in code but not in the published docs).
- ✅ **Add the "why not raw lru-cache" section** (above) verbatim to the README.
- ✅ **Fix the benchmark harness** (see `benchmark/README.md` audit) so the numbers are defensible, then lead with the single strongest chart: equal hit-rate at ~90× fewer backend queries.
- ✅ **TypeScript types** (`index.d.ts`). Cheap, and a hard adoption blocker for many teams today.

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

### Tier 2.6 — Code simplification: `index.js` (next increment)

**Goal:** reduce noise in `index.js` without changing any behaviour or test outcomes. Four targeted cleanups.

**1. Remove `_isAsync*` guards — replace all `isAsync ? await x : x` with plain `await x`.**
`await` on a non-Promise value returns it unchanged, so the sync/async distinction in the code is unnecessary. Removes three `Object.defineProperty` calls (`_isAsyncFetch`, `_isAsyncFetchByKey`, `_isAsyncFetchByKeys`) and simplifies four call sites in `init`, `asyncRefresh`, `getOrFetch`, and `getOrFetchMany`.

**2. Remove obvious inline comments and JSDoc on self-describing methods.**
Delete comments that restate what the code already clearly says — `//already close`, `//if pass then timeoutLoop for the next refresh`, `//cache is not close then set timeout loop again`, the "debug only" notes on `_runInMs`/`_runAt`, the JSDoc blocks on `get`/`set`/`delete`/`clear`/`has`/`entries`, and the `asyncRefresh` property-JSDoc inside `init()`. Retain WHY comments (snapshot-before-clear rationale, first-item-consumed note, coalescing comment).

**3. Fix four typos: `refrech` → `refresh`** in error-log strings inside `_timeoutLoop` and `_refreshAtLoop`.

**4. Remove the `const close = true` indirection in `close()`** — use `true` directly in the `Object.defineProperty` call.

**What is NOT changed:** the `Object.defineProperty` non-enumerable pattern (intentional API surface control), the first-item peek optimisation in `asyncRefresh` (prevents clearing cache on empty fetch), the `_refreshAtLoop` backoff structure (behavioural risk without targeted tests), and all latency-tracking logic.

**Cost / ROI:** ~25–30 LOC net reduction, zero behaviour change. Makes the constructor and refresh loops easier to read for future contributors.

---

### Tier 2.7 — Benchmark gaps: three missing scenarios

The current benchmark suite (`benchmark/README.md §8`) has three documented evidence gaps. Each is a new standalone script that adds to the existing suite without modifying or replacing what's there.

---

#### Gap 1 — Scheduled refresh: "reads cost 0 DB queries per request"

**What the current suite says:** §B shows ~600 total DB queries for Strategy C over 30s at 2,000 rps. The signal is real but gets obscured by the framing (batched no-cache baseline also sits at ~600, making it look like a tie).

**What's missing:** a benchmark that makes the zero-per-request property unmissable.

**New script: `benchmark/run-refresh-vs-direct.js`**

Three strategies, all serving the same 10k-key working set from a 10M-row DB:

| Strategy | What it does | Expected DB queries for 50,000 reads |
| :--- | :--- | :--- |
| Direct (per-key) | `WHERE uuid=$1` on every request | ~50,000 |
| Direct (batched) | `WHERE uuid IN (100)` per batch | ~500 |
| Scheduled Full-Refresh | Load once at init, read from memory | **~1** (the init load only) |

Add a simulated `sleep(10)` to all three DB paths (models a realistic 10 ms network round trip — the common case this library is designed for). Measure: total DB queries, total wall-clock time, p50/p99 latency. The expected outcome — "cache: 1 DB query / direct per-key: 50,000 queries / direct batched: 500 queries" — is the headline the library needs and currently cannot cite from clean data.

**Why it matters:** Scheduled refresh is the #1 unique differentiator over plain `lru-cache` (see DEVELOPMENT_PLAN §1). The current suite's §B evidence for it is real but indirect. This script produces a direct, undeniable number.

---

#### Gap 2 — Batch loading: N+1 collapse with realistic network latency

**What the current suite says:** §D shows 2.3–2.7× improvement for `getOrFetchMany` vs the old per-key path — but the "old" baseline is a hand-disabled subclass (`DataCacheNoCoalescing`), not a realistic no-cache ORM loop. The benchmark uses local Postgres (sub-ms), so the DB-latency difference between 1 query and N queries is invisible.

**What's missing:** a benchmark with a realistic no-cache N+1 baseline and simulated network latency.

**New script: `benchmark/run-n-plus-one.js`**

Workload: render 10,000 feed pages, each needing 20 author records (simulating a social feed or a dashboard). Four strategies:

| Strategy | What it does | Expected behaviour |
| :--- | :--- | :--- |
| ORM loop (no cache) | 20 × `SELECT ... WHERE id=$1` per page, `sleep(10)` each | 200,000 DB queries, p50 ~200 ms/page |
| Direct batch (no cache) | 1 × `SELECT ... WHERE id IN (20)` per page, `sleep(10)` | 10,000 DB queries, p50 ~10 ms/page |
| `getOrFetchMany` (cold cache) | Batch load misses, `sleep(10)` per batch | ~10,000 DB queries first pass, ~0 after warm |
| `getOrFetchMany` (warm cache) | All in-memory after first pass | **~0 DB queries**, p50 <0.1 ms |

Add `sleep(10)` to all DB paths. The expected outcome — "ORM loop 200k queries / batch 10k / cache warm 0" — directly backs the §9 Pattern 4 use case (social feed, dashboards). This is the benchmark that §D should have been.

**Why it matters:** N+1 is the most common backend performance problem. Without this benchmark the batch-loading feature is useful but unproven against the real alternative.

---

#### Gap 3 — Raw `lru-cache` baseline arm

**What's missing:** all baselines compare against Postgres. There is no arm that wraps `new LRUCache({ max, ttl, fetchMethod })` directly so any "vs lru-cache" throughput claim is feature-level only (see §0 caveat).

**Add to `run-new-features-benchmark.js` as a fourth strategy:**

```javascript
{
    key: 'lru-native',
    label: 'Plain lru-cache (fetchMethod, no batching)',
    setup: async (trackedSql) => {
        const { LRUCache } = require('lru-cache');
        const lru = new LRUCache({
            max: 100000,
            ttl: 60_000,
            fetchMethod: async (key) => {
                await sleep(10);
                const [row] = await trackedSql`SELECT uuid, name, email FROM users WHERE uuid = ${key}`;
                return row ?? undefined;
            }
        });
        // Thin wrapper matching the cache.getOrFetch / getOrFetchMany API surface
        return {
            getOrFetch: (key) => lru.fetch(key),
            getOrFetchMany: async (keys) => {
                const entries = await Promise.all(keys.map(k => lru.fetch(k).then(v => [k, v])));
                return Object.fromEntries(entries.filter(([, v]) => v !== undefined));
            },
            size: lru.size,
            metrics: null,
            close: async () => lru.clear(),
        };
    }
}
```

**Expected outcome:** lru-cache's native `fetchMethod` already coalesces same-key concurrent misses — so for single-key throughput with cache hits, it should match or tie the "New Caching Logic" numbers. The gap appears in multi-key batch loading (no `fetchByKeys` equivalent) and miss-cache (no `undefined`-storage concept). This makes §D's conclusions honest.

**Why it matters:** the §0 table says lru-cache has no batching or miss-cache. This baseline *proves* it rather than claiming it.

---

**Combined ROI:** these three scripts are self-contained additions (~150–200 LOC each). They do not touch `index.js` or any test. The payoff is turning three "analytically claimed" differentiators into benchmark-backed ones — which is the only thing standing between the library's stated positioning and its evidence.

**Priority order:** Gap 1 > Gap 2 > Gap 3. Gap 1 is the most important because scheduled refresh is the library's primary differentiator over lru-cache (see §1 positioning). Gap 2 is the most impactful for adoption because N+1 is the most relatable problem. Gap 3 is needed for completeness but is lowest urgency.

---

### Tier 2.8 — `gain()` anti-pattern detection & advice (next increment)

**Goal:** make `gain().recommendation` a *trustworthy* diagnosis that catches the three documented anti-patterns (README → "Anti-Patterns", benchmark `README.md §0`), instead of the current sizing-only heuristic that **misdiagnoses two of them**.

**Defects in the current logic** (`index.js:511–516`):

| Anti-pattern | Real signal | What `gain()` does today | Verdict |
| :--- | :--- | :--- | :--- |
| **1. Refreshing more than the hot set** (full/guessed preload) | many keys cached, few ever hit → `utilization` high **+** `hitSizeRatio` low | branches need `hitSizeRatio > 2` to flag near-capacity; a full-refresh cache at util ≈ 1.0, hitSizeRatio ≈ 0.05 falls through to **"optimal"** | ❌ false-healthy |
| **2. `max` below the working set** (thrash) | low **hit rate** despite a full cache, high eviction churn | no hit-rate or eviction signal; thrash shows *high* `hitSizeRatio` → labeled **"High efficiency and near-capacity"** | ⚠️ right advice ("grow max"), wrong/misleading reason |
| **3. Misreading the ratio as throughput** | — | renamed `hitVsFetchLatencyRatio` + deprecation alias + doc caveats | ✅ already handled |

**Two structural gaps to close:**

1. **No hit *rate*.** Recommendations key off `hitSizeRatio = hits / activeSize` — a **lifetime counter ÷ instantaneous size**, so it grows unbounded with uptime and its thresholds (`0.5`, `2`) mean different things at minute 1 vs. hour 5. Add `hitRate = hits / (hits + misses)` to `metrics` (both counters already exist) — normalized, uptime-independent, and the single most diagnostic "is this strategy working at all" number.
2. **No waste/churn signal.** To separate "too small (thrash)" from "refreshing keys nobody reads," add a **capacity-eviction counter** via lru-cache's `dispose` callback (the only genuinely new instrumentation), and fold the `keysLoaded` vs `keysUpdated` already emitted by `onRefresh` into a cumulative refresh-waste ratio.

> **✅ Verified `lru-cache` v11.5.1 `dispose` semantics (checked against installed `node_modules`, 2026-06-04):**
> - `dispose(value, key, reason)` distinguishes the reasons we need: `DisposeReason = 'evict' | 'set' | 'delete' | 'expire' | 'fetch'`. **Capacity eviction (`'evict'`) and TTL expiry (`'expire'`) are separate reasons**, so thrash is distinguishable from normal aging. ✅
> - **Caveat that shaped the design — TTL expiry is *lazy*.** Per the v11 docs: *"stale items are NOT preemptively removed by default … There is no pre-emptive pruning of expired items; it will treat expired items as missing when they are fetched, and delete them."* `refreshed-cache` constructs `new LRUCache({ max, ttl })` **without `ttlAutopurge`** (`index.js:133`), so a `'expire'` dispose fires only when an expired key is *touched* (a `get`) or when `purgeStale()` runs — **not at the instant of expiry.** Therefore a live `'expire'`-before-hit counter would under-count and is unreliable.
> - **Design consequences:**
>   1. **Thrash detection → count `reason === 'evict'` only.** This fires *synchronously* on capacity eviction regardless of the lazy-expiry caveat, so it is a reliable churn signal. No per-key "was it hit?" bookkeeping is needed — high `'evict'` churn + low `hitRate` + high `utilization` is sufficient to infer thrash, which avoids adding per-entry hit-flag state to the hot path.
>   2. **Refresh-waste detection (anti-pattern 1) → use `onRefresh` `keysLoaded`/`keysUpdated`, NOT `'expire'` dispose.** Because expiry disposal is lazy, do not infer "keys nobody read" from `'expire'` events; derive it from the load-vs-update signal the refresh loop already emits.
>   3. `gain()` already calls `this._cache.purgeStale()` before sampling (`index.js:500`), so `activeSize` is accurate at report time — the lazy-expiry caveat does not distort the reported size, only the would-be `'expire'` counter.

**New decision tree** (replaces the 3-way branch):

| Signal pattern | Diagnosis | Advice |
| :--- | :--- | :--- |
| hit rate low + util high + **high** evict-churn | working set > `max` (thrash) | grow `max` or shrink hot set (anti-pattern 2) |
| util high + **low** hitSizeRatio + low churn | refreshing keys nobody reads | switch to `passRecentKeysOnRefresh` / active-only (anti-pattern 1) |
| hit rate low + low util | cache barely helps this workload | reconsider whether to cache here |
| hit rate high + low util | over-provisioned | shrink `max` / lower TTL (current behavior) |
| hit rate high + util high | healthy & near capacity | grow `max` (current behavior) |

**Design — extract a pure function.** Pull the mapping into a standalone `_recommend({ hitRate, utilization, hitSizeRatio, evictChurn })` that returns a stable `{ code, message }`. This makes every branch and boundary trivially unit-testable in isolation and makes the thresholds reviewable in one place. Recommendations expose a stable `code` (e.g. `"thrash"`, `"refresh-waste"`, `"healthy"`) so consumers can alert on the enum, not parse English.

**Validation strategy — tests *and* a benchmark calibration witness, at different cadences.** This is the crux of the "do we need new benchmarks?" question; the honest answer is **no new benchmark script, but the existing ones must witness the thresholds**:

- **Recommendation *logic* → unit tests (mandatory, every CI run).** Because `_recommend` is pure, a table-driven test asserts each branch and its boundaries (e.g. `util = 0.8` exactly, `hitRate = 0` with a full cache) deterministically, with no DB. This is the gate that would have caught the current "false optimal" defect.
- **Threshold *validity* → calibration against existing benchmark fixtures (one-time + whenever a threshold changes — NOT a per-CI gate).** The suite already manufactures the exact states: `§C` *is* anti-pattern 2 (120k window vs 100k `max`), `§B` Strategy C *is* the healthy active-only case, `§B` Strategy A/B *is* anti-pattern 1 (loads/fetches beyond the hot set). Add a lightweight assertion to the **existing** harness — "on the §C thrash config `gain().code === 'thrash'`; on §B Strategy C it's `'healthy'`/`'optimal'`; on §B Strategy A it's `'refresh-waste'`" — so the benchmark *witnesses* that the thresholds fire on known-bad configs and stay quiet on known-good ones.
- **Honesty caveat (ship it in the JSDoc/README).** Some recommendations are workload-dependent heuristics and cannot be "proven correct" universally. Document them as heuristics with a stable `code`, not guarantees — the same honesty bar already applied to `gain()`'s "diagnostic, not a measurement" framing.

**Why no dedicated throughput benchmark (unlike Tier 2.7).** Gaps 1–3 each *prove a performance differentiator* — a new measurable characteristic. `gain()` advice introduces **no new runtime behavior to measure**; it's a diagnostic *over* existing behavior. A standalone throughput study would measure the wrong thing. The correct artifact is a correctness assertion layered onto the fixtures that already exist. Reach for a new benchmark only if a threshold itself needs empirical calibration data the current fixtures don't already produce.

**Cost / ROI:** ~40–60 LOC (`hitRate` in `metrics`, `dispose` eviction counter, extracted `_recommend`, decision tree) + a table-driven unit test file + ~10 LOC of assertions in the existing benchmark harness. ROI **High** — converts `gain()` from a sizing hint that lies on two of three anti-patterns into a self-diagnosing advisor, which is the natural payoff of having documented those anti-patterns at all.

---

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

