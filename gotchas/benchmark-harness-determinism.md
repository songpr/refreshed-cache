# Gotchas — deterministic benchmark harness (`run-new-features-benchmark.js`)

Findings from a high-effort `/code-review` of the work-box / seeded-PRNG / median-of-N
changes (working tree on `feature/tier-2-sharpen-core`, 2026-06-05).

**Scope:** all findings are in `benchmark/run-new-features-benchmark.js`. No production/
library code (`index.js`) changed; these are **benchmark-validity** issues, not user-facing
crashes. No correctness/crash bug survived verification (the candidate empty-`statsHistory`
crash at line 426 was **refuted** — every worker suspends on its first `await` DB fetch
before `main` reaches `while (isRunning)`, so the monitor always records ≥1 sample).

---

## 1. Window-sweep frequency changed: ~20 sweeps → 1 sweep per run (most consequential)

**Where:** `benchmark/run-new-features-benchmark.js:219` (`progress = … : tick / totalBatches`).

**What changed:** the hot-key window used to slide by wall-clock —
`windowStart = floor(elapsed*1000) % 30000` — which wraps every ~30s, i.e. **~20 full
sweeps** over a 600s run. It now slides by logical progress (`tick/totalBatches`, 0→1),
i.e. **one single sweep** across the entire run.

**Failure scenario:** the 120k window slides ~20× slower, so keys stay hot far longer →
**higher hit rate, far fewer evictions** than the old harness. New throughput/DB-query
numbers therefore differ from the **§D results still published in `README.md` /
`benchmark/README.md`** for a reason *beyond* determinism, making those committed tables
non-comparable to anything re-run on this harness.

**Suggested fix:** make the logical sweep complete one cycle per `intervalSec`-equivalent
(restore the ~30s cadence) while keeping it wall-clock-independent — e.g.
`progress = (tick / batchesPerSweep) % 1` where `batchesPerSweep` corresponds to ~30s of
batches. This also resolves #2.

---

## 2. Sweep completeness depends on each strategy hitting the `totalBatches` estimate

**Where:** `benchmark/run-new-features-benchmark.js:195` (`totalBatches = …`) feeding line 219.

**Failure scenario:** `totalBatches = NUM_WORKERS * round(duration*1000/intervalMs)` assumes
every strategy sustains ~1000 batch-loops/sec/worker. A saturated/slower strategy (e.g.
Direct under pool queueing) executes fewer batches in the fixed duration, so
`progress = tick/totalBatches` never reaches 1 and its window only sweeps the **early part**
of the universe, while a fast strategy sweeps further. The strategies being compared then
read **different key subsets**, biasing the relative DB-query/throughput comparison the
harness exists to make.

**Note:** fixed automatically by the #1 fix (cyclic per-interval sweep makes completeness
independent of total batch count).

---

## 3. Per-request `mulberry32` closure allocation on the measured hot path

**Where:** `benchmark/run-new-features-benchmark.js:228` (`const rng = mulberry32(...)`).

**Failure scenario:** at ~25k rps over 600s the worker fires ~15M requests, each allocating
and returning a new closure. The old code called `Math.random()` with zero allocation. The
added per-request allocation raises minor-GC frequency **inside the measurement window**,
slightly depressing the throughput/latency the benchmark reports — self-distorting the
metric.

**Suggested fix:** use a counter-seeded inline hash (no closure) — derive the needed draws
from `(seedBase, seq)` via a couple of integer ops rather than constructing a PRNG object
per request.

---

## 4. Per-request PRNG seeds are consecutive integers (low inter-seed entropy)

**Where:** `benchmark/run-new-features-benchmark.js:228` (`mulberry32((seedBase * K + seq) >>> 0)`).

**Failure scenario:** `seq` increments by 1 per request, so successive requests seed
`mulberry32` with `s, s+1, s+2…`. mulberry32's *first* emitted value for adjacent seeds is
only weakly decorrelated (a single `+0x6D2B79F5` step before the avalanche), so the
`rand`/branch-selection draw of consecutive requests can be correlated. The synthetic
30%-batch / 70%-single / thundering-herd mix may then be **less independent than intended**,
subtly skewing the hit/miss/coalesce distribution the run is meant to sample uniformly.

**Suggested fix:** hash-mix the seed before use (e.g. run the seed through one
splitmix64/mulberry step, or seed once per worker and draw sequentially) so adjacent
requests aren't derived from adjacent seeds.

---

### Priority

#1 is the one to fix before re-publishing any §D numbers — it silently changes *what* the
harness measures and breaks comparability with the results already committed in the docs.
#2 falls out of the same fix. #3/#4 are quality/efficiency refinements to the synthetic
workload, not blockers.
