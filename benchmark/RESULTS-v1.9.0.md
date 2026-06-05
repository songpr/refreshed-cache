# Refreshed Cache v1.9.0 Benchmark Results

Below are the results from the isolated **600s** run of `run-new-features-benchmark.js` against the Tier 2 implementation, re-run **2026-06-05** against a **20M-row** Postgres table.

```text
======================================================
NEW VS OLD FEATURES BENCHMARK COMPARISON (1 ROUNDS, process-isolated)
======================================================
```

| Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Peak Heap | Base Heap | Heap Growth | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Direct** | 21,146 rps | 9.66 ms | 21.39 ms | 186.32 ms | 1,909,100 | 39.38 MB | 6.29 MB | +33.09 MB | ✅ PASSED |
| **lru-cache** | 25,160 rps | 10.15 ms | 22.69 ms | 32.83 ms | 1,143,006 | 63.26 MB | 6.29 MB | +56.97 MB | ✅ PASSED |
| **refreshed-cache** | **25,539 rps** | **3.92 ms** | **20.83 ms** | **27.14 ms** | **1,036,715** | **67.89 MB** | 6.29 MB | **+61.60 MB** | ✅ PASSED |

## Key Takeaways
1. **Near-Zero Overhead vs Baseline:** The **`refreshed-cache`** (`25,539 rps`) matches — and this run slightly edges — the raw **`lru-cache`** baseline (`25,160 rps`). This proves that promise coalescing and background refreshing add essentially **zero overhead** to the hot path.
2. **Reduced DB Queries via Coalescing:** Compared to **`lru-cache`** which fires `1,143,006` queries over 10 minutes, **`refreshed-cache`** fires only `1,036,715` queries (~106k fewer). The coalescing successfully absorbed overlapping misses into single fetches.
3. **`gain()` Diagnosis:** For the **`refreshed-cache`**, the benchmark witnessed the following internal validation during its run:
   ```text
   [Metrics Validation] Gain report: Est. Time Saved: 185,317,954.10 ms | Hit/Fetch latency ratio (per-op, not throughput): 6,753.09x | Active Size: 99,774 | Hit/Size Ratio: 109.60 | Code: healthy | Recommendation: High efficiency and near-capacity. Cache size and TTL are optimal or could be increased.
   ✅ Assertion Passed: 'healthy' recommendation witnessed.
   ```
