# Gotchas — deterministic benchmark harness (`run-new-features-benchmark.js`)

Findings from a high-effort `/code-review` of the work-box / seeded-PRNG / median-of-N
changes (working tree on `feature/tier-2-sharpen-core`, 2026-06-05).

**Status: all four findings RESOLVED 2026-06-05** (see "Fix applied" under each). The
fixes change the executed synthetic workload, so the §D tables and the reproducibility
figures in `README.md` / `benchmark/README.md` / `DEVELOPMENT_PLAN.md` must be **re-run
and refreshed** before they are quoted again.

**Scope:** all findings are in `benchmark/run-new-features-benchmark.js`. No production/
library code (`index.js`) changed; these are **benchmark-validity** issues, not user-facing
crashes. No correctness/crash bug survived verification (the candidate empty-`statsHistory`
crash at line 426 was **refuted** — every worker suspends on its first `await` DB fetch
before `main` reaches `while (isRunning)`, so the monitor always records ≥1 sample).

---

## 1. Window-sweep frequency changed: ~20 sweeps → 1 sweep per run (most consequential)

**What changed:** the hot-key window used to slide by wall-clock —
`windowStart = floor(elapsed*1000) % 30000` — which wraps every ~30s, i.e. **~20 full
sweeps** over a 600s run. The first determinism pass made it slide by total-run progress
(`tick/totalBatches`, 0→1), i.e. **one single sweep** across the entire run.

**Why it mattered:** the 120k window slid ~20× slower, so keys stayed hot far longer →
**higher hit rate, far fewer evictions** than the old harness, making the committed §D
tables non-comparable to anything re-run on this harness for a reason *beyond* determinism.

**Fix applied:** the window now sweeps on a **cyclic logical clock** —
`progress = (reqSeq / requestsPerSweep) % 1`, with
`requestsPerSweep = NUM_WORKERS * targetQps * SWEEP_PERIOD_SEC` (`SWEEP_PERIOD_SEC = 30`).
This restores the ~30s / ~20-sweep cadence while staying wall-clock-independent (depends
only on `reqSeq` at batch start), so hit/eviction behaviour is comparable to the published
§D shape again.

---

## 2. Sweep completeness depended on each strategy hitting the `totalBatches` estimate

**Why it mattered:** `totalBatches = NUM_WORKERS * round(duration*1000/intervalMs)` assumed
every strategy sustains ~1000 batch-loops/sec/worker. A saturated/slower strategy (e.g.
Direct under pool queueing) executed fewer batches in the fixed duration, so
`progress = tick/totalBatches` never reached 1 and its window only swept the **early part**
of the universe, while a fast strategy swept further — so the strategies being compared read
**different key subsets**, biasing the comparison the harness exists to make.

**Fix applied:** resolved by the #1 fix. The cyclic `reqSeq`-driven sweep no longer
references `totalBatches` (the variable is removed); completeness is now independent of how
many batches a strategy manages to execute.

---

## 3. Per-request `mulberry32` closure allocation on the measured hot path

**Why it mattered:** at ~25k rps over 600s the worker fires ~15M requests, each allocating
and returning a new PRNG closure (the old `Math.random()` path allocated nothing). The added
per-request allocation raised minor-GC frequency **inside the measurement window**, slightly
depressing the throughput/latency the benchmark reports — self-distorting the metric.

**Fix applied:** replaced the per-request closure with a **stateless** module-level
`hashFloat(seed, seq, n)` plus a primitive `let draw = 0` counter per request. Each random
decision is `hashFloat(seedBase, seq, draw++)` — zero heap allocation on the hot path.

---

## 4. Per-request PRNG seeds were consecutive integers (low inter-seed entropy)

**Why it mattered:** `seq` increments by 1 per request, so successive requests seeded
`mulberry32` with `s, s+1, s+2…`. mulberry32's *first* emitted value for adjacent seeds is
only weakly decorrelated (a single `+0x6D2B79F5` step before the avalanche), so the
`rand`/branch-selection draw of consecutive requests could be correlated, subtly skewing the
hit/miss/coalesce distribution the run is meant to sample uniformly.

**Fix applied:** resolved together with #3. `hashFloat` runs `(seed, seq, n)` through a
splitmix-style finalizer (two `Math.imul` avalanche rounds), so adjacent `seq` values — and
adjacent draws within a request — are independently mixed rather than derived from adjacent
seeds.

---

### Follow-up — DONE 2026-06-05

The full suite was re-run at 20M rows and all docs refreshed. Outcomes of the fixes:

- **Reproducibility improved from ~0.1% to bit-identical.** Two back-to-back
  `--requests=40000 --seed=777` runs produced **identical** DB-query counts on every arm:
  Direct `40,000`, lru-cache `25,291`, refreshed-cache `21,904`. The stateless hash draws +
  `reqSeq`-driven cyclic sweep removed the timing dependence that previously left the cache
  arms at ~0.1% rather than exact. (Coalescing *can* still introduce sub-0.1% drift at much
  larger `--requests`/worker counts — exactness is the observed floor at this scale, not a
  guarantee at every scale.)
- **§D / all sections refreshed** in `README.md`, `benchmark/README.md`,
  `benchmark/RESULTS-v1.9.0.md`, `DEVELOPMENT_PLAN.md`.
- **Unrelated finding surfaced by the run, since FIXED (TDD):** the run first showed `gain()`
  scoring §B Active-Only Refresh and §E miss-cache `low-value` despite both being valuable
  (low hit rate there = batched misses / bogus-key absorption, not low value). Fixed by adding
  `missProtectionRatio` → `miss-protected` and `avgBatchSize` → `batch-efficient` signals to
  `_recommend` (`test/gain-calibration.test.js`, 16/16). Classification-only — the §A–§E
  tables are unaffected. See README → "Status of `gain()` recommendations" and DEVELOPMENT_PLAN
  Tier 2.8.
