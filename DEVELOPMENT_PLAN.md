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

> ⚠️ **Highest-ROI action, costs one command:** npm `latest` is **1.5.3**; this repo is at **1.8.0**. The coalescing and batch features are built but **unpublished**. `npm publish` first; everything else is secondary.

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
- **Publish 1.8.0** to npm.
- **Document `getOrFetch`, `getOrFetchMany`, single-flight, and the miss cache** in the README (they exist in code but not in the published docs).
- **Add the "why not raw lru-cache" section** (above) verbatim to the README.
- **Fix the benchmark harness** (see `benchmark/README.md` audit) so the numbers are defensible, then lead with the single strongest chart: equal hit-rate at ~90× fewer backend queries.
- **TypeScript types** (`index.d.ts`). Cheap, and a hard adoption blocker for many teams today.

### Tier 2 — Sharpen the core (optional, medium cost)
- **Observability hooks**: expose counters for hits/misses/refreshes/coalesced-fetches and an `onRefresh`/`onError` callback. Right now refresh errors only `console.error` (`index.js:91`); production users need a hook.
- **Per-refresh error backoff**: on repeated `asyncRefresh` failure, back off instead of retrying every interval at full rate.
- **`getOrFetchMany` single-flight**: the batch path does not yet coalesce overlapping concurrent batches the way `getOrFetch` does for single keys.

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
