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

module.exports = { sleep, measureMemory, percentiles };
