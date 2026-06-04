// Shared measurement helpers for the benchmark suite.
// Centralized so every script measures memory and latency the same, defensible way.

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Quiesced memory measurement. Forces GC several times with a short settle between
 * each, and returns the *minimum* observed footprint (in MB). Taking the min after
 * repeated GC avoids capturing a transient allocation peak, which is what produced
 * the bogus negative "heap growth" deltas in earlier runs.
 *
 * Requires the process to be started with `--expose-gc` for global.gc to exist.
 */
async function measureMemory() {
    let heap = Infinity;
    let rss = Infinity;
    for (let i = 0; i < 4; i++) {
        if (global.gc) {
            try { global.gc(); } catch (e) { /* ignore */ }
        }
        await sleep(50);
        const m = process.memoryUsage();
        if (m.heapUsed < heap) heap = m.heapUsed;
        if (m.rss < rss) rss = m.rss;
    }
    return {
        heapUsed: (heap / 1024 / 1024).toFixed(2),
        rss: (rss / 1024 / 1024).toFixed(2),
    };
}

/**
 * Nearest-rank percentiles over a latency array (values in ms).
 * Returns p50/p95/p99/avg as fixed(2) strings, or zeros for an empty input.
 */
function percentiles(latencies) {
    if (!latencies || latencies.length === 0) {
        return { p50: '0.00', p95: '0.00', p99: '0.00', avg: '0.00', count: 0 };
    }
    const s = [...latencies].sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    return {
        p50: at(50).toFixed(2),
        p95: at(95).toFixed(2),
        p99: at(99).toFixed(2),
        avg: avg.toFixed(2),
        count: s.length,
    };
}

/**
 * Zero the cache counters bumped during warmup/setup so the measured window
 * starts clean. No-op when cache is null (e.g. the direct/no-cache baseline).
 */
function resetCacheMetrics(cache) {
    if (!cache) return;
    cache._hits = 0;
    cache._misses = 0;
    cache._refreshes = 0;
    cache._coalescedFetches = 0;
    cache._mismatches = 0;
    cache._invalidations = 0;
}

/**
 * Print the standard metrics-validation footer shared by every benchmark:
 * ops accounting, expected-vs-actual DB queries, raw counters, and the gain report.
 * Pass totalDBQueries to enable the DB-query reconciliation line.
 */
function logCacheValidation(cache, totalRequests, totalDBQueries) {
    if (!cache) return;
    const m = cache.metrics;
    const isOpsValid = (m.hits + m.misses === totalRequests);
    console.log(`[Metrics Validation] Total Ops: ${totalRequests} | Metrics Hits+Misses: ${m.hits + m.misses} (Match: ${isOpsValid ? '✅' : '❌'})`);

    if (totalDBQueries !== undefined) {
        const expectedDBQueries = (m.refreshes || 0) + (m.misses - m.coalescedFetches);
        const isDbQueriesValid = (totalDBQueries <= expectedDBQueries);
        console.log(`[Metrics Validation] DB Queries: ${totalDBQueries} | Expected: ${expectedDBQueries} (Match: ${isDbQueriesValid ? '✅' : '❌'}, saved ${expectedDBQueries - totalDBQueries} by miss-cache)`);
    }

    console.log(`[Metrics Validation] Metrics: Hits: ${m.hits} | Misses: ${m.misses} | Coalesced: ${m.coalescedFetches} | Invalidations: ${m.invalidations} | Refreshes: ${m.refreshes}`);
    const g = cache.gain();
    console.log(`[Metrics Validation] Gain report: Est. Time Saved: ${g.timeSavedMs.toFixed(2)}ms | Hit/Fetch latency ratio: ${g.hitVsFetchLatencyRatio.toFixed(2)}x (per-op, not throughput) | Active size: ${g.activeSize} | Hit/Size ratio: ${g.hitSizeRatio.toFixed(2)} | Recommendation: ${g.recommendation}`);
}

module.exports = { sleep, measureMemory, percentiles, resetCacheMetrics, logCacheValidation };
