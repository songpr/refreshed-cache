# Code Review — feature/tier-2-sharpen-core

**Branch:** `feature/tier-2-sharpen-core`  
**Base:** `main`  
**Effort:** high  
**Date:** 2026-06-04  
**Files changed:** 18 (+1619 / -80)

---

## Findings

### 1. `keysLoaded` off-by-one when fetch exceeds `max` — `index.js:360`

`++i` increments `i` before the max-guard break, so `onRefresh` receives `keysLoaded: max+1` instead of `max` when the data source yields more items than the cache cap.

**Failure scenario:** `max=2`, fetch returns `[A, B, C]`. `firstItem=A` → `i=1`. Loop: `++i=2 → 2>2? No → cache B`; `++i=3 → 3>2? Yes → break`. Only A and B are stored, but `onRefresh` gets `{ keysLoaded: 3 }`. Any monitoring built on this metric overcounts by 1 whenever the source exceeds the cap.

**Fix:** restructure the loop so `i` only increments when the item is actually stored:
```js
// before
if ((++i) > this.max) break;
this._cache.set(key, value);

// after
if (i >= this.max) break;
i++;
this._cache.set(key, value);
```

---

### 2. `_coalescedFetches` not recorded in `getOrFetchMany` fallback path — `index.js:641`

When `getOrFetchMany` falls back to per-key `getOrFetch` calls (no `fetchByKeys` configured), it passes `_trackMetrics=false` to avoid double-counting `_misses`. But `false` also suppresses `_coalescedFetches++` — a separate counter that was never double-counted and should always be recorded.

**Failure scenario:** Two concurrent `getOrFetchMany(['x'])` with only `fetchByKey` configured. Call 1 creates a pending fetch for `'x'`; Call 2 coalesces onto it (real fetch avoided). `getOrFetch('x', false)` skips `_coalescedFetches++` → `cache.metrics.coalescedFetches` stays `0` despite actual coalescing.

**Fix:** Use a dedicated `_trackMisses` flag instead of a single `_trackMetrics`, or explicitly increment `_coalescedFetches` in the `getOrFetchMany` fallback before delegating to `getOrFetch`:
```js
// in the fallback map:
const promises = missingKeys.map(async (key) => {
    if (this._pendingFetches.has(key)) this._coalescedFetches++;
    const val = await this.getOrFetch(key, false);
    return [key, val];
});
```

---

### 3. `keys.includes(k)` is an always-true dead predicate, adding O(n²) cost — `index.js:633`

Every `k` emitted into `promisesToAwait` originates from `actualMissing ⊆ missingKeys ⊆ keys`, so `keys.includes(k)` is always `true`. With a 1000-key batch this performs ~1M comparisons per call for zero benefit.

**Failure scenario:** 1000-key batch miss — 1000 resolved entries each scan up to 1000 items to confirm membership already guaranteed by construction.

**Fix:** Remove the guard entirely:
```js
// before
if (v !== undefined && keys.includes(k)) {
    result[k] = v;
}

// after
if (v !== undefined) {
    result[k] = v;
}
```

---

### 4. `_refreshAtLoop` error handler duplicates the backoff state machine in `_timeoutLoop` — `index.js:207`

The inline `runBackoff` closure (lines 207–238) reimplements: `_failureCount++`, `getBackoffDelay(...)`, `_onError` dispatch, `setTimeout` scheduling, and recursive retry — the same logic already in `_timeoutLoop` (lines 128–155).

**Cost:** Changes to backoff behaviour (retry cap, jitter strategy, error logging) must be applied to both copies. The two are already diverging: `has()` omits `_misses++` that the other invalidation sites include.

**Fix:** On error in `_refreshAtLoop`, delegate to `_timeoutLoop` for the retry, then re-enter `_refreshAtLoop` on the next success — eliminating the `runBackoff` closure entirely.

---

### 5. `checkValidity` invalidation block duplicated four times, already diverging — `index.js:419`

The four-step pattern — `_cache.delete`, `_missCache.delete`, `_invalidations++`, `_misses++` — appears independently in `get()` (line 419), `getOrFetch()` (line 487), `getOrFetchMany()` (line 548), and `has()` (line 664). The `has()` copy already omits `_misses++`, proving copy drift.

**Cost:** A new invalidation side-effect (event, secondary index, counter) requires updating all four sites; missing one produces inconsistent state silently.

**Fix:** Extract `_invalidateKey(key, trackMiss = true)` helper and call it from all four sites.

---

### 6. `if (firstItdata.done != true)` is dead code — `index.js:357`

The early return at line 317 handles `firstItdata.done === true`. When execution reaches line 357, `done` is definitively `false` — the condition is always `true`.

**Cost:** The dead guard adds noise. If a future refactor moves the early-return block without removing this check, the iterator loop will be silently skipped when `done` is `true` but `value` is a valid array, dropping remaining items with no error.

**Fix:** Remove the `if (firstItdata.done != true)` wrapper; the `for await` loop body is always reached.

---

### 7. `_runInMs` is "debug only" but is now load-bearing for `runBackoff` — `index.js:204`

`_runInMs` is documented at line 110 as *"just for debug only — do not use to run"*, but `runBackoff` writes `_runInMs = backoffDelay` (line 204) then reads it back inside the closure (`setTimeout(..., dataCache._runInMs)`, line 236) as the actual scheduling delay.

**Cost:** The property's contract is violated. Any `onError` callback that reads `_runInMs` for observability sees the correct value, but the coupling between a mutable debug property and control flow means a future async refactor of `runBackoff` that defers reading `_runInMs` will silently use a stale or overwritten delay.

**Fix:** Pass the delay as a parameter to `runBackoff(delay)` and update `_runInMs` for observability separately.

---

## Summary

| # | Severity | File | Line | Finding |
|---|----------|------|------|---------|
| 1 | Bug | index.js | 360 | `keysLoaded` off-by-one when max is hit |
| 2 | Bug | index.js | 641 | `_coalescedFetches` not recorded in fallback path |
| 3 | Perf | index.js | 633 | `keys.includes(k)` always-true O(n²) dead predicate |
| 4 | Altitude | index.js | 207 | `runBackoff` duplicates `_timeoutLoop` backoff machine |
| 5 | Cleanup | index.js | 419 | `checkValidity` block duplicated 4×, already diverging |
| 6 | Cleanup | index.js | 357 | `if (firstItdata.done != true)` is dead code |
| 7 | Cleanup | index.js | 204 | `_runInMs` doc contract violated by `runBackoff` |
