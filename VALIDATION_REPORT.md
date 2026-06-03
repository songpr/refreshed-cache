# Validation Report: LRU-Cache Mentions in README.md

This document presents a line-by-line validation of every mention of `lru-cache` in [README.md](README.md) compared against the source code in [index.js](index.js) and the package configuration.

---

## Line-by-Line Validation Table

| README.md Line | Mention / Claim | Verified Against Code | Status | Notes / Source Verification |
| :--- | :--- | :--- | :--- | :--- |
| **Line 2** | `caching data with LRU Cache and refresh it within specified time.` | [index.js:2](index.js#L2)<br>[index.js:64](index.js#L64) | **Correct** | We import `LRUCache` from `lru-cache` and instantiate it under the hood. |
| **Line 11** | ``lru-cache`'s `fetchMethod` + `allowStale` is **pull-based**... The *first* requester after expiry still pays the backend latency...` | Concept Comparison | **Correct** | In raw `lru-cache`, `fetchMethod` only executes on-demand (pull-based) when requested. |
| **Line 13** | ``refreshed-cache` is **push-based**: `asyncRefresh()` re-fetches the entire working set... independent of request traffic.` | [index.js:72-146](index.js#L72-L146)<br>[index.js:191-224](index.js#L191-L224) | **Correct** | The code maintains background loops (`_timeoutLoop`, `_refreshAtLoop`) to call `asyncRefresh` and populate the cache. |
| **Line 17** | `3. **Time-aligned freshness.** `refreshAt: {days, at}` supports "rebuild the cache at 02:00 daily" — ... that `lru-cache` has no concept of.` | [index.js:44-54](index.js#L44-L54)<br>[index.js:108-146](index.js#L108-L146) | **Correct** | `lru-cache` has no native cron or schedule options; we implement `refreshAt` using daily millisecond offsets in `index.js`. |
| **Line 18** | `4. **Encapsulated data provider.** Fetch logic lives with the cache config, not scattered across call sites.` | [index.js:33-35](index.js#L33-L35)<br>[index.js:148-178](index.js#L148-L178) | **Correct** | The constructor takes `fetch`, `fetchByKey`, and `fetchByKeys` as part of configuration options. |
| **Line 22** | Table Row Comparing raw `lru-cache` and `refreshed-cache` | Conceptual & API | **Correct** | Compares push vs. pull model, coalescing (`getOrFetch` matches `lru-cache`'s own coalescing), and negative caching (`_missCache` wrapping). |
| **Line 33** | Positioning statement comparing proactive schedules vs. lazy revalidation in `lru-cache`. | Conceptual | **Correct** | Accurately describes design trade-offs. |
| **Line 36** | `use lru-cache.fetch()` for lazy, per-key population on unbounded datasets. | `lru-cache` API | **Correct** | In `lru-cache` v7+, `cache.fetch(key)` is indeed the standard way to retrieve a value or trigger `fetchMethod`. |
| **Line 38** | `lru-cache`'s own `fetch()` already coalesces in-flight requests. | `lru-cache` behavior | **Correct** | Verified: `lru-cache` natively coalesces concurrent reads for the same key to avoid duplicate background fetches. |
| **Line 332** | `lru-cache`'s native `.fetch()` API implements coalescing, wrapped by `refreshed-cache`'s schedule. | [index.js:309-333](index.js#L309-L333) | **Correct** | In `refreshed-cache`, coalescing is explicitly implemented using `_pendingFetches` to mimic the behavior on top of `fetchByKey`. |

---

## Key Findings & Minor Discrepancy

While all conceptual references, feature comparisons, and API calls to `lru-cache` are correct, there is a minor behavioral discrepancy regarding the option `max: 0`:

### `max: 0` Behavior
* **README.md Claim** (Lines 77 & 100):
  * `max` description: *"Setting it to 0 then no data will be cached."*
  * `maxMiss` description: *"Setting it to 0 then no miss cache will be cached."*
* **Actual Source Code Behavior**:
  * In [index.js:64](index.js#L64), `_lruCache` is instantiated as `new LRUCache({ max: max, ttl: maxAge * 1000 })`.
  * In `lru-cache` (v11.5.1), passing `max: 0` is interpreted as **unbounded** (no limit on items).
  * `refreshed-cache` checks `this.size >= this.max` during bulk fetch/refresh loops, effectively loading 0 items. However, if a developer manually calls `cache.set("key", value)` when `max: 0`, the underlying `lru-cache` stores the entry, and `cache.get("key")` will return it.
  * This also triggers `UnboundedCacheWarning: TTL caching without ttlAutopurge, max, or maxSize can result in unbounded memory consumption.` from `lru-cache` during test execution when `max` is `0` and a `ttl` is configured.
