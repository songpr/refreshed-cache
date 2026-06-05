# Refreshed Cache - Postgres Benchmarking Suite

This directory contains a benchmark suite that compares the performance, memory usage, and correctness of `refreshed-cache` against direct Postgres querying using the `postgres` library.

---

## 0. The Core Case: When This Library Works — and When It Doesn't

**`refreshed-cache` is a strategic tool, not a free speed-up.** Whether it helps depends almost entirely on *how your app currently reads the database* and *whether your hot set fits in memory*. The benchmark suite (§5) was built specifically to find the line between the two. The one rule that predicts everything below:

> **The cache cuts database load only to the extent your current no-cache code does *not* already batch its reads. If you already batch everything, the cache buys read latency and bounded memory — not fewer queries.**

### ✅ Where it works (backed by benchmarks)

| Pattern | Why it works | Benchmark proof | How it was tested |
| :--- | :--- | :--- | :--- |
| **Per-key read paths** (ORM `findById`, REST `/resource/:id`, GraphQL N+1) | The no-cache baseline fires one query *per key*; the cache serves the hot fraction from memory. | **§A** — 50k per-key queries → ~16k (**~3× DB-load cut**, the stable headline); throughput speedup is higher but noisy (~2–9×) on the 20M table, correctness ✅. | 50k lookups, 70% hit / 25% soft-miss / 5% hard-miss, vs a **per-key** `WHERE uuid=$1` baseline; exact query counter; per-round forked process. |
| **Cache-penetration / hard-miss floods** (bogus IDs, scrapers, credential-stuffing) | `maxMiss` absorbs repeat lookups for non-existent keys in a bounded sidecar cache. | **§E** — 110k → ~3k DB queries (**~97%**), p99 200 ms → **0.2 ms**, +7.5 MB bounded heap. | Three-way: no-cache vs `maxMiss:0` vs `maxMiss` enabled; valid set **pre-warmed** to isolate the miss signal; `duration ≥ 2× maxAgeMiss` guard so expiry+refill cycles are observed; workload unit-tested (`test/miss-cache-workload.test.js`). |
| **Thundering-herd spikes** (flash sale, breaking news → same hot key) | Single-flight coalescing merges concurrent misses for a key into one query. | **§D** — `refreshed-cache` matches raw `lru-cache` throughput (**~25k rps**, zero orchestration overhead) while coalescing trims DB queries below it (**~1.04M vs ~1.14M** / 600s); p99 ~27–38 ms vs Direct's ~186–209 ms. | refreshed-cache vs raw lru-cache vs Direct; concurrent workers with a 30% same-key burst; isolated process. ⚠️ the Direct baseline is *no-latency local* Postgres, so read §D as an overhead+coalescing check, not a throughput-vs-no-cache headline. |
| **Datasets too large to hold fully** (millions of rows, hot subset) | Active-Only Refresh keeps only recently-used keys warm and refreshes them in one batched query. | **§B** — 95% hit rate over 20M rows from a **bounded ~44 MB** hot set; flat memory across 5 rounds. | Sliding hot-key window, strict 100k ceiling, `--expose-gc` quiesced heap, peak/base/cleaned heap tracked per forked round. |

### ❌ Where it does *not* help (anti-patterns, also benchmarked)

| Anti-pattern | Why it fails | Benchmark proof | How it was tested |
| :--- | :--- | :--- | :--- |
| **You already batch every read** (`WHERE id IN (...)`) and expect *fewer queries* | A batched baseline already bottoms out; the cache only ties it on query count. | **§B** — Direct (batched) ~600 queries vs cache ~601: a **tie**, not a reduction. The real gain shifts to latency/memory. | Same §B run; the no-cache arm sends 100-key `IN (...)` batches (`run-long-benchmark.js:191`). |
| **Cache smaller than the working set** (hot set > `max`) | Constant eviction → constant miss refetches; behind a saturated pool, tail latency tracks the DB. | **§C** — 120k window vs 100k ceiling: only ~25% fewer queries, p99 ~210 ms ≈ direct. | Sustained 4-worker load, window deliberately over the ceiling; `Row-Exist Rate` (not hit rate) logged honestly. |
| **Refreshing more than the active hot set** (scheduled *full* refresh, or lazy `fetchByKey`-per-miss, on a huge dataset) | Reloading keys demand hasn't revealed is wasted work; on a set bigger than `max`, every miss becomes its own round trip and misses dominate. | **§B** — Strategy A (full refresh, ~53k queries, ~67 MB peak) and B (lazy per-key, ~51k) fire **~90×** more queries than Strategy C's ~601 active-only refresh, for keys nobody asked for. | Same §B run; A/B reload/fetch beyond the active set, C replays `recentKeys` in one batched query — isolating the config difference. |
| **Treating `gain()` "speedup"/"time saved" as throughput** | They're a per-op latency *ratio* and a counterfactual estimate, inflated by miss-fetch latency. | See §5 `cache.gain()` callouts and §8 — `Hit/Fetch latency ratio` ≠ application speedup (the real win is a stable ~3× DB-query reduction, §A, with noisier throughput). | Hit latency is sampled (`latencySampleRate`) and timer-noise-bound at sub-µs; documented as a diagnostic, not a measurement. |

**Net:** reach for `refreshed-cache` when your reads are **per-key**, your **hot set fits in memory**, or you face a **hard-miss/penetration flood**. Don't expect it to beat code that already batches, and always size `max` to your working set. Every claim above is reproducible from §4; the methodology and its limits are in §8.

### Relationship to `lru-cache` (what this actually adds)

> ⚠️ **Analytical comparison, not yet benchmarked.** `refreshed-cache` is **built on `lru-cache` v11** — both the main store and the miss-store are `LRUCache` instances (`index.js:2`, `:133`, `:290`). It is an orchestration layer, not a competing cache engine. The table below is a **feature-level** comparison; the suite does **not** currently include a raw-`lru-cache` baseline arm, so these rows are *not* backed by numbers (unlike §A–§E vs Postgres). See the caveat after the table.

| Capability | Plain `lru-cache` v11 | `refreshed-cache` (adds) |
| :--- | :--- | :--- |
| `max` / `ttl` eviction | ✅ native (passed straight through) | — (delegates to lru-cache) |
| Per-key loader + **single-flight coalescing** | ✅ `fetchMethod` already dedupes concurrent same-key fetches | Wraps the same idea via `fetchByKey` + `_pendingFetches` |
| Stale-while-revalidate (lazy, per-key) | ✅ `allowStale` + background `fetchMethod` | Available, plus the timed refresh below |
| **Scheduled bulk/active refresh on a timer** | ❌ refresh is lazy/on-access only | ✅ `refreshAge` loop reloads the working set (or `passRecentKeysOnRefresh` keys) in **one batched query**. **Benchmark status: indirectly backed by §B** — at 95% hit rate over 20M rows, ~19,000 of 20,000 reads per interval are served from memory with zero DB contact; DB load is flat at ~600 queries/window regardless of read QPS. Clean head-to-head ("reads cost 0 vs 1 DB query per request with simulated network latency") is a **benchmark gap** — see §8 open items. |
| **Multi-key batch loading** (collapse N misses → one `IN (...)`) | ❌ `fetchMethod` is strictly per-key | ✅ `getOrFetchMany` / `fetchByKeys`. **Benchmark status: real-world case is strong; current benchmark baseline is weak.** The N+1 problem is ubiquitous in ORM-based apps (feed renders, dashboards, GraphQL resolvers). The prior "§5D 2.3–2.7× vs a no-coalescing subclass" figure has been **retired** (that hand-crippled arm was removed from the benchmark); §5D now only shows `refreshed-cache` matching raw `lru-cache` while coalescing trims queries. A proper N+1 benchmark (N per-key queries × network latency vs 1 batch query) is still a **benchmark gap** — see §8 open items. |
| **Negative / miss caching** (bounded, separate TTL) | ❌ won't store `undefined`; no negative-cache concept | ✅ `maxMiss` / `maxAgeMiss` sidecar (§E) |
| ROI metrics (`gain()`, hit/miss latency) | ❌ basic stats only | ✅ `metrics` + `gain()` (read §8 caveats) |

**So: if you only need per-key memoization with TTL, lazy stale-revalidate, and same-key coalescing, plain `lru-cache` already does that — don't add this layer.** `refreshed-cache` earns its place only when you specifically want **(a)** scheduled *batched* refresh of a hot set, **(b)** N+1 collapse via multi-key batch fetch, or **(c)** cache-penetration/miss protection.

> **Honesty caveat on §D:** §D's `lru-cache` arm is a **hand-written wrapper** around `new LRUCache({max, ttl})` with manual miss-fetch — it deliberately does **not** use `lru-cache`'s native `fetchMethod` (which would coalesce same-key fetches on its own). So §D shows (a) `refreshed-cache` adds **zero overhead** over a plain `lru-cache` wrapper, and (b) its single-flight coalescing trims DB queries below that wrapper — **not** that it beats `lru-cache`'s own native coalescing. The defensible, lru-cache-relative wins remain the features lru-cache lacks entirely: **timed bulk refresh (§B)** and **miss-cache (§E)**. A native-`fetchMethod` baseline arm would still be needed for a head-to-head coalescing-throughput claim — see the open item in §8.

---

## 1. Prerequisites

- **Node.js** (v18+)
- **Docker** or **OrbStack**

---

## 2. Benchmark Setup & Database Size

The database is populated with **20,000,000** records generated via a fast SQL generator (`generate_series`). Each row contains:
- `id` (SERIAL PRIMARY KEY)
- `uuid` (VARCHAR UNIQUE) - indexed
- `name` (VARCHAR)
- `email` (VARCHAR)
- `metadata` (JSONB) - containing nested properties simulating user profiles

### Physical DB Sizes at 20M Rows:
* **Table Data Size (Relation Size)**: `3,587 MB` (3.59 GB)
* **Total Table Size (Data + Indexes)**: `7,068 MB` (7.07 GB)
* **Index Size (uuid b-trees + pkey)**: `3,481 MB` (3.48 GB)

---

## 3. Files & Architecture

- `docker-compose.yml`: Spins up Postgres 17 on port `5439`.
- `schema.sql`: Table definitions and index structures.
- `seed.js`: Database seeding script.
- `run-benchmark.js`: Measures standard scenario throughput (hits vs. misses) and tracks `DB Queries Triggered`.
- `run-long-benchmark.js`: Simulates caching strategies over multiple intervals, verifying memory limits and garbage collection behavior.
- `run-load-test.js`: Sustained concurrent user load test comparing local caching against Direct Prepared Statements (No Cache).
- `run-new-features-benchmark.js`: Evaluates performance ROI of Request Coalescing (single-flight) and Bulk Batch Loading.
- `run-miss-cache-benchmark.js`: Measures DB query reduction from miss-cache (Pattern D). Compares Direct (no cache), `maxMiss: 0` (disabled), and `maxMiss: 10000` under a cache-penetration **attack** — a high share of repeated bogus-key traffic against a small bounded pool, with the valid set pre-warmed. Workload shape is configurable via `--bogusRatio`, `--bogusPool`, `--validPool`.
- `lib/miss-cache-workload.js`: Shared, unit-tested workload generator for the miss-cache benchmark (`makeBogusPool`, `selectKey`, `validateAttackConfig`). `validateAttackConfig` rejects workloads where bogus traffic can't repeat often enough to exercise miss-cache. Covered by `test/miss-cache-workload.test.js`.

---

## 4. How to Run

### Start the Database
```bash
docker compose -f benchmark/docker-compose.yml up -d
```

### Install Dependencies
```bash
npm install
```

### Seed the Database
Before running the benchmarks, the database needs to be seeded with records. You have two options:

#### Option A: Fast SQL Seeding (Recommended for 20,000,000 Rows)
Run a native Postgres `generate_series` script inside the Docker container. This generates exactly 20,000,000 records with realistic formats in well under a minute:
```bash
docker exec -i refreshed-cache-benchmark-postgres psql -U benchmark_user -d benchmark_db -c "
INSERT INTO users (uuid, name, email, metadata)
SELECT 
    gen_random_uuid()::varchar,
    'User ' || i,
    'user' || i || '@example.com',
    jsonb_build_object('city', 'City ' || (i % 100), 'company', 'Company ' || (i % 10), 'role', 'Role ' || (i % 5))
FROM generate_series(1, 20000000) AS i;
"
```

#### Option B: Node.js Seeding (For 1,000,000 Faker Rows)
Run the Node.js seeding script which uses `@faker-js/faker` to insert 1,000,000 mock records:
```bash
node benchmark/seed.js
```

### Run Benchmarks (with Optional `--rounds=N` and `--duration=S` args)
Each script can be run with `--rounds` (default: 1) and `--duration` (for load simulations, in seconds) to gather comprehensive data.

```bash
# 1. Standard Benchmark (5 rounds)
node benchmark/run-benchmark.js --rounds=5

# 2. Strategy Simulation (5 rounds, 30s duration)
node benchmark/run-long-benchmark.js --rounds=5 --duration=30

# 3. Sustained Load Test (5 rounds, 30s duration)
node benchmark/run-load-test.js --rounds=5 --duration=30

# 4. New Features Benchmark (5 rounds, 30s duration) — time-boxed, for steady-state/variance
node benchmark/run-new-features-benchmark.js --rounds=5 --duration=30

# 4b. New Features Benchmark — REGRESSION-DIFFING mode (deterministic workload)
#     --requests=N runs a fixed work box (exactly N logical requests) instead of a
#     fixed duration, and --seed pins the PRNG. Together they make the executed
#     workload reproducible across runs, so DB-query counts are directly comparable
#     when checking whether a code change regressed. Use a large N to reach steady state.
node benchmark/run-new-features-benchmark.js --rounds=3 --requests=2000000 --seed=777

# 5. Miss Cache Benchmark (5 rounds, 60s duration with TTL cycling)
node benchmark/run-miss-cache-benchmark.js --rounds=5

# 5b. Miss Cache Benchmark — custom attack shape (e.g. heavier attack, smaller pool, different TTL)
node benchmark/run-miss-cache-benchmark.js --rounds=5 --bogusRatio=0.7 --bogusPool=500 --validPool=10000 --maxAgeMiss=30
```

> **Miss-cache workload & lifecycle note:** the benchmark models a cache-penetration **attack** and captures the full **expiry+refill lifecycle**. The bogus pool must be small relative to the volume of bogus requests, otherwise each bogus key is seen at most once and miss-cache has nothing to absorb. `validateAttackConfig` enforces this: it estimates total request volume (~2,000 rps × duration) and aborts if expected bogus requests don't exceed the bogus pool by at least 3×. Duration must exceed 2× `maxAgeMiss` so expiry and refill cycles are observed (guard enforced at runtime). The valid set is **pre-warmed** before measurement so valid lookups are pure cache hits and don't mask the miss-cache signal. Default: `duration=60s`, `maxAgeMiss=20s` (production typically uses 60s, but 20s here fits 3 cycles in the run).

### Run the benchmark workload unit tests
```bash
npx jest test/miss-cache-workload.test.js
```

---

## 5. Benchmark Results (20,000,000 Total DB Rows)

✅ **FRESH — Re-run on 2026-06-05** against a **20M-row** table. All numbers below are from the **process-isolated harness** (`benchmark/lib/isolated-runner.js`). Each `(round, strategy)` runs in its own forked process with a fresh pool and heap, `--expose-gc` quiesced memory, `hrtime` timing, and exact `DB Queries` counts.

> **Read the numbers honestly.** Process isolation eliminates cross-round **heap accumulation** (see §7) — it does **not** make throughput deterministic. Throughput still varies round-to-round (e.g. §A speedup ranges ~2.2×–8.8× for the *same* config, driven mostly by a noisy per-key Direct baseline on the larger table; §D `refreshed-cache` throughput ranges ~24.5k–25.5k rps), so treat per-round figures as samples, not precise constants, and prefer the median across rounds. The most reproducible numbers are the **exact `DB Queries` integer counts**, not the timing-dependent throughput/latency. §D's deterministic mode (`--requests`/`--seed`) makes even the cache DB-query counts bit-reproducible — see §8.

### 5.0 How each section maps to the core case (§0)

The strategic "works / doesn't work" summary is in **[§0](#0-the-core-case-when-this-library-works--and-when-it-doesnt)**. Each results section below is the evidence behind one row of it, ordered here by how strongly it supports adopting the library:

| Rank | Evidence | Claim it actually supports |
| :--- | :--- | :--- |
| 1 | **§E** | Strongest & cleanest cache-vs-no-cache win: ~97% DB-load reduction + cache-penetration protection + ~1000× p99. |
| 2 | **§A** | ~3× fewer DB queries and ~2× throughput **when reads are per-key and the hot set fits in memory**. |
| 3 | **§B** | Bounded memory + sub-ms reads for huge datasets. The "90×" here is **active+batched refresh vs lazy per-key fetching** (a cache-config lesson), **not** cache-vs-no-cache. |
| 4 | **§D** | `refreshed-cache` matches raw `lru-cache` throughput (zero overhead) while coalescing trims DB queries below it; against a zero-latency *local* direct baseline the throughput edge is modest. Proves the overhead/coalescing story, not "caching beats not caching." |
| 5 | **§C** | Honest null result: an undersized cache under pool saturation barely moves tail latency. Documents a limitation, not a win. |

Read each section below with its rank in mind. §A and §E are the load-bearing evidence; §B is a memory/latency story; §D is a regression check; §C is a stress-case caveat.

### A. Standard Scenario Throughput (50,000 Lookups, 5-Rounds Run)

> **Rank 2 (a fair cache-vs-no-cache win).** Unlike §B, the `Direct (No Cache)` baseline here issues **per-key** `WHERE uuid = $1` queries (`run-benchmark.js:113`) — the common ORM/REST-by-id pattern. So the cache's `DB Queries Direct` (50,000) vs `DB Queries Cache` (~16,000 medium) is an apples-to-apples **~3× DB-load reduction** — the stable, reproducible headline here. Throughput "Speedup" reads higher (~2.2–8.8×) but is noisy and partly an artifact: on the 20M-row table the per-key `WHERE uuid = $1` Direct baseline is slower and more variable, inflating the `Cache Ops/sec ÷ DB Ops/sec` ratio, so lead with the DB-query reduction, not the speedup column. This is the win to cite when your reads are per-key and the hot set fits in memory.

> **⛔ Guardrail — when this win evaporates.** The ~3× here exists *only* because the no-cache baseline reads **per-key** (`WHERE uuid = $1`). If your no-cache code already batches reads (`WHERE id IN (...)`), there is no query reduction left to capture — the cache ties it on query count (see §B's ~600 ≈ ~601) and the value shifts to read latency and bounded memory. **Don't quote §A's 3× for an already-batched read path.**

Simulates 50,000 read queries with a realistic traffic distribution of 70% cache hits, 25% cache misses (exist in DB), and 5% hard misses.

*Direct Prepared Statements (No Cache) are compared directly against the Cache as a baseline. Results from process-isolated harness (fresh pool and heap per round).*

| Round | Scenario | Cache Size | Init Time | DB Ops/sec | DB Queries Direct | Cache Ops/sec | DB Queries Cache | Speedup | Correctness | Heap Mem | RSS Mem |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Round 1** | Small Cache (1% coverage) | 10,000 | 38 ms | 14,855 | 50,000 | 115,099 | 20,702 | **7.75x** | ✅ PASSED | 4.25 MB | 14.69 MB |
| **Round 1** | Medium Cache (10% coverage) | 100,000 | 145 ms | 19,482 | 50,000 | 127,892 | 16,158 | **6.56x** | ✅ PASSED | 39.94 MB | 123.28 MB |
| **Round 1** | Large Cache (50% coverage) | 500,000 | 607 ms | 15,871 | 50,000 | 99,518 | 15,221 | **6.27x** | ✅ PASSED | 194.81 MB | 228.45 MB |
| **Round 2** | Small Cache (1% coverage) | 10,000 | 31 ms | 33,030 | 50,000 | 78,477 | 20,575 | **2.38x** | ✅ PASSED | 4.26 MB | 16.26 MB |
| **Round 2** | Medium Cache (10% coverage) | 100,000 | 166 ms | 17,056 | 50,000 | 124,836 | 16,234 | **7.32x** | ✅ PASSED | 39.94 MB | 125.78 MB |
| **Round 2** | Large Cache (50% coverage) | 500,000 | 669 ms | 14,219 | 50,000 | 85,086 | 15,141 | **5.98x** | ✅ PASSED | 194.82 MB | 202.93 MB |
| **Round 3** | Small Cache (1% coverage) | 10,000 | 36 ms | 41,172 | 50,000 | 115,978 | 21,013 | **2.82x** | ✅ PASSED | 4.25 MB | 16.84 MB |
| **Round 3** | Medium Cache (10% coverage) | 100,000 | 152 ms | 12,287 | 50,000 | 107,541 | 16,301 | **8.75x** | ✅ PASSED | 39.95 MB | 100.28 MB |
| **Round 3** | Large Cache (50% coverage) | 500,000 | 625 ms | 12,101 | 50,000 | 99,554 | 15,299 | **8.23x** | ✅ PASSED | 194.81 MB | 205.70 MB |
| **Round 4** | Small Cache (1% coverage) | 10,000 | 39 ms | 35,066 | 50,000 | 108,010 | 20,634 | **3.08x** | ✅ PASSED | 4.26 MB | 16.55 MB |
| **Round 4** | Medium Cache (10% coverage) | 100,000 | 141 ms | 18,516 | 50,000 | 112,887 | 16,305 | **6.10x** | ✅ PASSED | 39.95 MB | 104.38 MB |
| **Round 4** | Large Cache (50% coverage) | 500,000 | 640 ms | 14,090 | 50,000 | 95,195 | 15,017 | **6.76x** | ✅ PASSED | 194.82 MB | 221.27 MB |
| **Round 5** | Small Cache (1% coverage) | 10,000 | 35 ms | 55,789 | 50,000 | 120,965 | 20,561 | **2.17x** | ✅ PASSED | 4.26 MB | 14.77 MB |
| **Round 5** | Medium Cache (10% coverage) | 100,000 | 144 ms | 29,386 | 50,000 | 113,857 | 16,359 | **3.87x** | ✅ PASSED | 39.95 MB | 105.98 MB |
| **Round 5** | Large Cache (50% coverage) | 500,000 | 839 ms | 11,548 | 50,000 | 100,009 | 15,034 | **8.66x** | ✅ PASSED | 194.81 MB | 191.53 MB |

> [!NOTE]
> _`Est. time saved` is a counterfactual estimate (`hits × avg miss-fetch latency`), and `Hit/Fetch latency ratio` is a per-operation latency ratio — **neither is an application throughput speedup** (those are in the tables above). Both scale with the avg miss-fetch (DB round-trip) latency, and the hit side is sub-microsecond and timer-noise-bound; read them as directional diagnostics, not precise measurements (see §8)._
> **Active Cache-Gain Metrics (Round 5 Diagnosed via `cache.gain()`):**
> * **Small Cache (10,000)**: Est. time saved: `189,928.98 ms` | Hit/Fetch latency ratio (per-op, not throughput): `3,538.97x` | Active Size: `10,000` | Hit/Size Ratio: `2.90` | Code: `healthy` | *Recommendation: High efficiency and near-capacity. Cache size and TTL are optimal or could be increased.*
> * **Medium Cache (100,000)**: Est. time saved: `218,585.12 ms` | Hit/Fetch latency ratio (per-op, not throughput): `2,818.91x` | Active Size: `100,000` | Hit/Size Ratio: `0.34` | Code: `healthy` | *Recommendation: High efficiency and near-capacity. Cache size and TTL are optimal or could be increased.*
> * **Large Cache (500,000)**: Est. time saved: `237,075.16 ms` | Hit/Fetch latency ratio (per-op, not throughput): `1,301.60x` | Active Size: `500,000` | Hit/Size Ratio: `0.07` | Code: `healthy` | *Recommendation: High efficiency and near-capacity. Cache size and TTL are optimal or could be increased.*

---

### B. Long-Running Strategy Simulation — Memory Bounding for Huge Datasets (5 Rounds, max: 100,000)

> **Rank 3 (memory/latency story, not a DB-load headline).** Read §A and §E first for the cache-vs-no-cache case. This section's value is showing that a 20M-row dataset can be served at a ~95% hit rate from a **bounded ~44 MB hot set** with flat memory over time — and that, *among cache configs*, active+batched refresh fires ~90× fewer DB queries than lazy per-key fetching.

> **⛔ Guardrail — two anti-patterns this section pins down.** (1) **Refreshing more than the active hot set.** *Scheduled Full Refresh* (~53k queries, ~67 MB peak heap) and *Lazy per-key* (~51k) cost **>90×** the DB load of Active-Only Refresh (~601 queries, ~44 MB) — that excess is reloads/fetches for keys nobody requested. Replay `recentKeys` (`passRecentKeysOnRefresh`), don't preload a guessed or full set. (2) **Expecting fewer queries than an already-batched baseline.** Direct batched ~600 ≈ Strategy C ~601 — against well-batched no-cache code the cache's edge is **latency and bounded memory, not query count** (for a query-count win, see §E).

Evaluates strategies under a shifting hot key load (sliding window) using a strict limit of `max: 100000` keys to test process RAM safety and GC leaks. Results from process-isolated harness (fresh pool and heap per round).

> **Important — what the `DB Queries` column compares here.** The workload issues lookups in **batches of 100**. The **Direct (No Cache)** baseline sends each batch as a single `WHERE uuid IN (...)` query, so it already bottoms out at **~600 queries** — it is *not* a naive per-key/N+1 baseline. **Strategy C lands at ~601, i.e. it matches Direct on DB-query count, not below it.** The headline "~90× fewer queries" below is **Strategy C vs Strategies A/B** (other *cache* configurations), where A/B fetch every miss one key at a time (`WHERE uuid = $1`) and the 120k sliding window exceeds the 100k ceiling, forcing constant per-key miss fetches. So §B's real lesson is **"if you cache a huge dataset, active + batched refresh (C) beats lazy per-key fetching (A/B) by ~90×"** — a *cache-tuning* result, **not** "caching beats not caching on DB load." Against a well-batched no-cache baseline, C's edge is in-process read **latency** (p50 ~0.04 ms vs ~0.13 ms) and **bounded memory** (~44 MB for the hot set), not query count. For the unambiguous cache-beats-no-cache DB-load win, see **§E**.

| Strategy | Hit Rate | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Peak Heap | Base Heap | Heap Growth | Cleaned Heap | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[R1] Direct Prepared Statements** | 0% | 2000 rps | 0.11 ms | 0.24 ms | 0.32 ms | 600 | 25.87 MB | 5.91 MB | +19.96 MB | 24.97 MB | N/A |
| **[R1] Strategy A: Scheduled Full Refresh** | 94.9% | 2000 rps | 0.05 ms | 0.08 ms | 0.11 ms | 53,511 | 67.17 MB | 5.91 MB | +61.26 MB | 28.70 MB | ✅ PASSED |
| **[R1] Strategy B: Lazy Fetch-on-Miss** | 95.0% | 2000 rps | 0.04 ms | 0.08 ms | 0.10 ms | 51,420 | 43.09 MB | 5.91 MB | +37.18 MB | 29.29 MB | ✅ PASSED |
| **[R1] Strategy C: Active-Only Refresh** | 94.9% | 2000 rps | 0.11 ms | 0.30 ms | 0.36 ms | 601 | 43.59 MB | 5.91 MB | +37.68 MB | 29.89 MB | ✅ PASSED |
| **[R2] Direct Prepared Statements** | 0% | 2000 rps | 0.14 ms | 0.22 ms | 0.25 ms | 600 | 25.88 MB | 5.91 MB | +19.97 MB | 24.98 MB | N/A |
| **[R2] Strategy A: Scheduled Full Refresh** | 94.9% | 2000 rps | 0.05 ms | 0.08 ms | 0.08 ms | 53,404 | 67.26 MB | 5.91 MB | +61.35 MB | 28.73 MB | ✅ PASSED |
| **[R2] Strategy B: Lazy Fetch-on-Miss** | 95.0% | 2000 rps | 0.03 ms | 0.08 ms | 0.12 ms | 51,320 | 43.06 MB | 5.91 MB | +37.15 MB | 29.27 MB | ✅ PASSED |
| **[R2] Strategy C: Active-Only Refresh** | 95.0% | 2000 rps | 0.12 ms | 0.31 ms | 0.36 ms | 601 | 43.45 MB | 5.91 MB | +37.54 MB | 29.83 MB | ✅ PASSED |
| **[R3] Direct Prepared Statements** | 0% | 2000 rps | 0.13 ms | 0.24 ms | 0.32 ms | 600 | 25.88 MB | 5.91 MB | +19.97 MB | 24.97 MB | N/A |
| **[R3] Strategy A: Scheduled Full Refresh** | 95.0% | 2000 rps | 0.04 ms | 0.08 ms | 0.13 ms | 53,413 | 67.19 MB | 5.91 MB | +61.28 MB | 28.72 MB | ✅ PASSED |
| **[R3] Strategy B: Lazy Fetch-on-Miss** | 94.9% | 2000 rps | 0.05 ms | 0.11 ms | 0.16 ms | 51,349 | 43.08 MB | 5.91 MB | +37.17 MB | 29.28 MB | ✅ PASSED |
| **[R3] Strategy C: Active-Only Refresh** | 95.0% | 2000 rps | 0.17 ms | 0.53 ms | 0.62 ms | 601 | 43.62 MB | 5.91 MB | +37.71 MB | 29.90 MB | ✅ PASSED |
| **[R4] Direct Prepared Statements** | 0% | 2000 rps | 0.10 ms | 0.20 ms | 0.26 ms | 600 | 25.88 MB | 5.91 MB | +19.97 MB | 24.97 MB | N/A |
| **[R4] Strategy A: Scheduled Full Refresh** | 94.8% | 2000 rps | 0.03 ms | 0.07 ms | 0.12 ms | 53,393 | 67.19 MB | 5.91 MB | +61.28 MB | 28.74 MB | ✅ PASSED |
| **[R4] Strategy B: Lazy Fetch-on-Miss** | 94.9% | 2000 rps | 0.05 ms | 0.08 ms | 0.12 ms | 51,378 | 43.06 MB | 5.91 MB | +37.15 MB | 29.31 MB | ✅ PASSED |
| **[R4] Strategy C: Active-Only Refresh** | 94.9% | 2000 rps | 0.12 ms | 0.26 ms | 0.34 ms | 601 | 43.58 MB | 5.91 MB | +37.67 MB | 29.92 MB | ✅ PASSED |
| **[R5] Direct Prepared Statements** | 0% | 2000 rps | 0.10 ms | 0.20 ms | 0.24 ms | 600 | 25.87 MB | 5.91 MB | +19.96 MB | 24.97 MB | N/A |
| **[R5] Strategy A: Scheduled Full Refresh** | 95.0% | 2000 rps | 0.05 ms | 0.11 ms | 0.13 ms | 53,402 | 67.20 MB | 5.91 MB | +61.29 MB | 65.39 MB | ✅ PASSED |
| **[R5] Strategy B: Lazy Fetch-on-Miss** | 95.0% | 2000 rps | 0.04 ms | 0.07 ms | 0.12 ms | 51,377 | 43.05 MB | 5.91 MB | +37.14 MB | 29.30 MB | ✅ PASSED |
| **[R5] Strategy C: Active-Only Refresh** | 95.0% | 2000 rps | 0.12 ms | 0.26 ms | 0.38 ms | 601 | 43.65 MB | 5.91 MB | +37.74 MB | 29.90 MB | ✅ PASSED |

> [!NOTE]
> _`Est. time saved` is a counterfactual estimate (`hits × avg miss-fetch latency`), and `Hit/Fetch latency ratio` is a per-operation latency ratio — **neither is an application throughput speedup** (those are in the tables above). Both scale with the avg miss-fetch (DB round-trip) latency, and the hit side is sub-microsecond and timer-noise-bound; read them as directional diagnostics, not precise measurements (see §8)._
> **Active Cache-Gain Metrics (Strategy C, Round 5 Diagnosed via `cache.gain()`):**
> * **Active-Only Refresh**: Est. time saved: `0.00 ms` | Hit/Fetch latency ratio (per-op, not throughput): `0.00x` | Active Size: `45,985` | Hit/Size Ratio: `0.21` | Code: `batch-efficient` | *Recommendation: Low hit rate, but misses are collapsed into batched fetches (getOrFetchMany), keeping backend load low. Working as intended for large/streaming working sets.*
>
> _Active-Only Refresh populates the cache via the refresh loader, not per-key `fetchByKey`, so there are **no miss-fetch latency samples** to use as a baseline — `Est. time saved` is therefore 0. (Earlier runs reported a spurious **negative** value here; `gain()` now floors the per-hit saving at 0 when no fetch baseline exists.) The cache's *internal* hit rate is low (~0.21 hit/size) because the sliding window over a 20M-row space means most keys are misses — but those misses are **collapsed into one batched `fetchByKeys` query per batch**, so backend load stays at ~601 queries/window. `gain()` recognizes this via the `avgBatchSize` signal and returns **`batch-efficient`** rather than `low-value` (the earlier mis-classification, fixed in Tier 2.8). The real win for this strategy is the **~90× DB-query reduction vs the per-key cache strategies (A/B)**, plus bounded memory — not the `Est. time saved` estimator._

**Key Takeaway**: All three cache strategies hold a **~95% hit rate**. On DB-query count, `Strategy C` (~601) **ties the well-batched Direct/No-Cache baseline (~600)** — caching does not beat a batched baseline on raw query count here. Where C wins is **against the other cache configs**: it fires ~90× fewer queries than Strategy A/B (~601 vs ~51,000), because A/B fetch each miss key-by-key while C refreshes the active set in one batched query. C also keeps memory flat (~44 MB hot set, ~4 MB growth) and read latency in-process (~0.04 ms p50 vs ~0.13 ms for Direct). **Takeaway: for huge datasets, prefer active + batched refresh over lazy per-key fetching; the cache's edge over a batched no-cache baseline is latency and memory bounding, not DB-query count (for that, see §E).**

---

### C. Sustained High-Concurrency Load Test (5 Rounds, max: 100,000)

> **Rank 5 (deliberate stress case / honest null result).** The 120k sliding window exceeds the 100k cache ceiling, so the cache thrashes (constant eviction → per-key miss refetches) and the Postgres connection pool saturates. The cache cuts DB queries only ~25% and tail latency tracks the direct baseline (~210 ms p99) because the bottleneck is pool queueing, not the DB. **Lesson:** an undersized cache behind a saturated pool barely helps tail latency — size the cache to the working set. This section documents a limitation, not a win.

> **⛔ Guardrail — this whole section *is* the anti-pattern.** A cache sized **below** its working set (120k-key window vs 100k `max`) thrashes: constant eviction → constant per-key miss refetches → only ~25% fewer queries and p99 ~210 ms ≈ direct. **Size `max` to the hot set, and keep `maxAge` long enough that the set survives between refreshes** — an undersized cache behind a saturated pool is ≈ no cache at all.

Compares in-process cache lookups against direct Postgres querying via optimized Prepared Statements under concurrent traffic. Results from process-isolated harness.

| Round | Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | Row-Exist Rate | DB Queries | Peak Heap | Base Heap | Heap Growth | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Round 1** | Direct Prepared (No Cache) | 3,050 rps | 12.69 ms | 208.28 ms | 223.18 ms | 94.0% | 92,500 | 31.20 MB | 6.21 MB | +24.99 MB | PASSED |
| **Round 1** | Lazy Fetch-on-Miss | 3,277 rps | 6.62 ms | 157.75 ms | 216.19 ms | 94.1% | 71,994 | 55.94 MB | 6.21 MB | +49.73 MB | PASSED |
| **Round 1** | Active-Only Refresh | 2,999 rps | 7.30 ms | 204.87 ms | 219.80 ms | 94.3% | 67,301 | 54.84 MB | 6.21 MB | +48.63 MB | PASSED |
| **Round 2** | Direct Prepared (No Cache) | 3,591 rps | 10.84 ms | 177.65 ms | 223.00 ms | 94.4% | 108,400 | 31.00 MB | 6.21 MB | +24.79 MB | PASSED |
| **Round 2** | Lazy Fetch-on-Miss | 3,408 rps | 6.49 ms | 163.13 ms | 217.12 ms | 94.3% | 73,794 | 55.81 MB | 6.21 MB | +49.60 MB | PASSED |
| **Round 2** | Active-Only Refresh | 3,322 rps | 6.24 ms | 169.14 ms | 216.92 ms | 94.0% | 72,557 | 56.21 MB | 6.21 MB | +50.00 MB | PASSED |
| **Round 3** | Direct Prepared (No Cache) | 3,433 rps | 9.97 ms | 186.30 ms | 219.36 ms | 94.5% | 103,600 | 31.19 MB | 6.21 MB | +24.98 MB | PASSED |
| **Round 3** | Lazy Fetch-on-Miss | 3,213 rps | 7.04 ms | 173.22 ms | 220.89 ms | 93.5% | 71,369 | 59.83 MB | 6.21 MB | +53.62 MB | PASSED |
| **Round 3** | Active-Only Refresh | 3,253 rps | 6.95 ms | 161.66 ms | 217.71 ms | 94.2% | 71,517 | 55.08 MB | 6.21 MB | +48.87 MB | PASSED |
| **Round 4** | Direct Prepared (No Cache) | 2,947 rps | 14.06 ms | 208.21 ms | 223.39 ms | 94.3% | 88,900 | 31.28 MB | 6.21 MB | +25.07 MB | PASSED |
| **Round 4** | Lazy Fetch-on-Miss | 3,440 rps | 6.64 ms | 91.60 ms | 211.77 ms | 93.7% | 74,486 | 56.03 MB | 6.21 MB | +49.82 MB | PASSED |
| **Round 4** | Active-Only Refresh | 3,479 rps | 6.63 ms | 143.08 ms | 215.51 ms | 94.2% | 74,779 | 54.52 MB | 6.21 MB | +48.31 MB | PASSED |
| **Round 5** | Direct Prepared (No Cache) | 3,272 rps | 12.10 ms | 203.51 ms | 221.56 ms | 94.1% | 99,100 | 31.23 MB | 6.21 MB | +25.02 MB | PASSED |
| **Round 5** | Lazy Fetch-on-Miss | 3,419 rps | 6.95 ms | 149.54 ms | 214.97 ms | 94.3% | 73,941 | 52.91 MB | 6.21 MB | +46.70 MB | PASSED |
| **Round 5** | Active-Only Refresh | 3,165 rps | 7.57 ms | 203.84 ms | 218.71 ms | 94.1% | 70,096 | 54.36 MB | 6.21 MB | +48.15 MB | PASSED |

> [!NOTE]
> _`Est. time saved` is a counterfactual estimate (`hits × avg miss-fetch latency`), and `Hit/Fetch latency ratio` is a per-operation latency ratio — **neither is an application throughput speedup** (those are in the tables above). Both scale with the avg miss-fetch (DB round-trip) latency, and the hit side is sub-microsecond and timer-noise-bound; read them as directional diagnostics, not precise measurements (see §8)._
> **Active Cache-Gain Metrics (Round 5 Diagnosed via `cache.gain()`):**
> * **Lazy Fetch-on-Miss**: Est. time saved: `745,527.97 ms` | Hit/Fetch latency ratio (per-op, not throughput): `772.34x` | Active Size: `67,106` | Hit/Size Ratio: `0.44` | Code: `low-value` | *Recommendation: Cache provides low value for this workload. Reconsider caching strategy here.*
> * **Active-Only Refresh**: Est. time saved: `781,384.92 ms` | Hit/Fetch latency ratio (per-op, not throughput): `987.63x` | Active Size: `63,803` | Hit/Size Ratio: `0.40` | Code: `low-value` | *Recommendation: Cache provides low value for this workload. Reconsider caching strategy here.*
>
> _Note: this is the **deliberately under-provisioned** stress case (120k window > 100k `max`), and `gain()` correctly flags it `low-value` — the cache thrashes and recovers only ~25% of DB queries here. Both strategies use **per-key** `getOrFetch` (no batching) against a mostly-valid key set (no miss-cache absorption), so neither the `batch-efficient` nor `miss-protected` signal applies — this is the advisor working as intended on a genuine anti-pattern. (Contrast §B Active-Only → `batch-efficient` and §E → `miss-protected`, where low hit rate is *not* a problem.)_

---

### D. New Features Performance ROI (Request Coalescing, Bulk Batching, & Observability)

> **Rank 4 (an overhead + coalescing check, not a throughput-vs-no-cache claim).** This section compares **`refreshed-cache`** against the **raw `lru-cache`** it wraps and a **Direct (No Cache)** baseline. It answers two questions: (1) does the orchestration layer add hot-path overhead over plain `lru-cache`? (no), and (2) does single-flight coalescing actually cut DB queries? (yes, ~9%). It is **not** a "caching beats no cache on throughput" claim — see the caveat below.

> **⛔ Guardrail — what the numbers do and don't say.** `refreshed-cache` matches `lru-cache` throughput (median **25,288 vs 24,798 rps** — overhead is within noise) while firing **fewer DB queries** (median **54,299 vs 59,651** per 30s window; **1,036,715 vs 1,143,006** over the 600s run, ~106k fewer) thanks to coalescing. Both caches out-throughput **Direct** (~21k rps) and collapse tail latency (p99 ~34 ms vs ~207 ms), **but** the Direct baseline here hits *zero-latency local* Postgres with no injected round-trip, so read the cross-cache story (overhead + coalescing) as the point of §D, not the throughput gap over Direct. For the unambiguous cache-vs-no-cache wins use **§B** (memory/latency) and **§E** (query reduction).

Compares **`refreshed-cache`** (Request Coalescing (single-flight), Batch Loading, retrieve-time `checkValidity` validation, and Observability hooks/metrics enabled) against the raw **`lru-cache`** library and a **Direct Prepared Statements (No Cache)** baseline. Results from process-isolated harness.

> **What this section does and does not show.** The point is **(a) zero measurable overhead** of `refreshed-cache`'s orchestration over plain `lru-cache`, and **(b)** that single-flight **coalescing** removes ~106k redundant fetches over the run. Against the zero-latency **Direct (No Cache)** baseline both caches are faster on throughput and far better on tail latency, but that gap understates a *remote* DB (no injected latency on the Direct path here) — so don't quote §D as the headline "should I cache?" number. The unambiguous wins live in **§B** (90× fewer DB queries at equal hit rate) and **§E** (penetration protection).

| Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Peak Heap | Base Heap | Heap Growth | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Direct** | 21,146 rps | 9.66 ms | 21.39 ms | 186.32 ms | 1,909,100 | 39.38 MB | 6.29 MB | +33.09 MB | ✅ PASSED |
| **lru-cache** | 25,160 rps | 10.15 ms | 22.69 ms | 32.83 ms | 1,143,006 | 63.26 MB | 6.29 MB | +56.97 MB | ✅ PASSED |
| **refreshed-cache** | **25,539 rps** | **3.92 ms** | **20.83 ms** | **27.14 ms** | **1,036,715** | **67.89 MB** | 6.29 MB | **+61.60 MB** | ✅ PASSED |

> [!NOTE]
> _`Est. time saved` is a counterfactual estimate (`hits × avg miss-fetch latency`), and `Hit/Fetch latency ratio` is a per-operation latency ratio — **neither is an application throughput speedup** (those are in the tables above). Both scale with the avg miss-fetch (DB round-trip) latency, and the hit side is sub-microsecond and timer-noise-bound; read them as directional diagnostics, not precise measurements (see §8)._
> **Active Cache-Gain Metrics (refreshed-cache, Diagnosed via `cache.gain()`):**
> * **refreshed-cache**: Est. time saved: `185,317,954.10 ms` | Hit/Fetch latency ratio (per-op, not throughput): `6,753.09x` | Active Size: `99,774` | Hit/Size Ratio: `109.60` | Code: `healthy` | *Recommendation: High efficiency and near-capacity. Cache size and TTL are optimal or could be increased.*

### Critical ROI Insights (Full 600s Run):
1. **Near-Zero Overhead vs Baseline**: The **`refreshed-cache`** (`25,539 rps`) matches — and this run slightly edges — the raw **`lru-cache`** baseline (`25,160 rps`) on throughput, with comparable p50 latency. This proves that promise coalescing and background refreshing add essentially **zero overhead** to the hot path over a standard LRU cache.
2. **Reduced DB Queries via Coalescing**: Compared to the **`lru-cache`** which fires `1,143,006` queries over 10 minutes, **`refreshed-cache`** fires only `1,036,715` queries. The single-flight coalescing absorbed overlapping misses into single fetches, saving **~106,000** redundant database trips even under randomized load.
3. **Observability & Validity Hooks have Negligible Overhead**: Enabling retrieve-time `checkValidity` (executing a structure/type check on every read) and tracking metrics (`hits`, `misses`, `coalescedFetches`, `invalidations`) incurs no observable performance penalty. The cache still performs at ~25,000+ rps with sub-millisecond overhead.
4. **Batch Single-Flight Coalescing**: When concurrent requests trigger overlapping batch fetches (`getOrFetchMany`), keys already in-flight are coalesced rather than queried redundantly, further capping database QPS.

### 5-Round Variance Data (30s per round)
| Round | Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Heap Growth | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Direct** | 20,926 rps | 5.67ms | 17.02ms | 195.78ms | 93,600 | +25.29 MB | ✅ PASSED |
| **1** | **lru-cache** | 25,601 rps | 11.84ms | 20.79ms | 29.42ms | 61,968 | +54.06 MB | ✅ PASSED |
| **1** | **refreshed-cache** | **25,100 rps** | **11.78ms** | **22.72ms** | **33.59ms** | **54,349** | **+59.48 MB** | ✅ PASSED |
| **2** | **Direct** | 21,209 rps | 5.96ms | 19.05ms | 207.21ms | 95,600 | +29.57 MB | ✅ PASSED |
| **2** | **lru-cache** | 24,944 rps | 11.48ms | 23.26ms | 36.73ms | 59,651 | +52.19 MB | ✅ PASSED |
| **2** | **refreshed-cache** | **24,537 rps** | **11.64ms** | **23.93ms** | **36.96ms** | **52,727** | **+55.23 MB** | ✅ PASSED |
| **3** | **Direct** | 20,992 rps | 5.69ms | 20.13ms | 204.49ms | 95,150 | +27.97 MB | ✅ PASSED |
| **3** | **lru-cache** | 24,674 rps | 11.63ms | 22.49ms | 34.42ms | 59,278 | +53.52 MB | ✅ PASSED |
| **3** | **refreshed-cache** | **25,336 rps** | **11.55ms** | **21.73ms** | **30.10ms** | **54,299** | **+56.05 MB** | ✅ PASSED |
| **4** | **Direct** | 20,765 rps | 5.85ms | 19.86ms | 207.02ms | 93,900 | +29.79 MB | ✅ PASSED |
| **4** | **lru-cache** | 24,798 rps | 11.69ms | 23.02ms | 35.59ms | 59,821 | +52.12 MB | ✅ PASSED |
| **4** | **refreshed-cache** | **25,338 rps** | **11.36ms** | **22.73ms** | **32.81ms** | **54,576** | **+56.50 MB** | ✅ PASSED |
| **5** | **Direct** | 20,100 rps | 6.16ms | 21.03ms | 209.25ms | 90,350 | +23.82 MB | ✅ PASSED |
| **5** | **lru-cache** | 24,660 rps | 11.83ms | 24.24ms | 40.42ms | 59,603 | +55.08 MB | ✅ PASSED |
| **5** | **refreshed-cache** | **25,288 rps** | **11.32ms** | **23.84ms** | **38.18ms** | **54,194** | **+56.51 MB** | ✅ PASSED |

**Aggregate over 5 rounds** (`median (min–max)`, printed by the harness — robust to single-round GC outliers):

| Strategy | Throughput (rps) | p50 (ms) | p99 (ms) | DB Queries | Heap Growth (MB) | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Direct** | 20,926 (20,100–21,209) | 5.85 (5.67–6.16) | 207.02 (195.78–209.25) | 93,900 (90,350–95,600) | 27.97 (23.82–29.79) | ✅ PASSED |
| **lru-cache** | 24,798 (24,660–25,601) | 11.69 (11.48–11.84) | 35.59 (29.42–40.42) | 59,651 (59,278–61,968) | 53.52 (52.12–55.08) | ✅ PASSED |
| **refreshed-cache** | **25,288 (24,537–25,338)** | **11.55 (11.32–11.78)** | **33.59 (30.10–38.18)** | **54,299 (52,727–54,576)** | **56.50 (55.23–59.48)** | ✅ PASSED |

---

### E. Cache-Penetration Attack Protection (Miss-Cache, 5 Rounds, 60s with TTL Cycling)

> **Rank 1 (the strongest, cleanest cache-vs-no-cache evidence).** All three strategies use the same per-key `fetchByKey`, the valid set is pre-warmed, so the only variable is miss handling. The three-way split is decisive: **Direct (no cache) ~110k DB queries → cache without miss-protection ~56k (the cache alone halves load by serving valid hits) → miss-cache enabled ~3k (~97% total reduction)**, with p99 dropping from ~200 ms to ~0.2 ms for a bounded ~7.5 MB of extra heap. This is the result to lead with.

> **⛔ Guardrail — what miss-cache does and doesn't promise.** (1) It **bounds** DB load to ~pool-size per `maxAgeMiss` window (~3k queries/60s here), **not "zero forever"** — entries expire and refill, so under indefinite attack you keep paying ~one fetch per distinct bad key per TTL, not nothing. (2) Disabling it (`maxMiss: 0`) still leaves ~56k queries — the main cache alone does *not* stop penetration; **the miss-cache is what absorbs bogus-key floods.** Don't run with `maxMiss: 0` if you face untrusted key traffic.

Models a cache-penetration **attack**: 50% of traffic hammers a fixed pool of **1,000 non-existent keys** while the valid set (10,000 keys) is **pre-warmed** so valid lookups are pure cache hits — isolating the miss-cache effect. Duration is 60s with `maxAgeMiss: 20s`, so miss-cache entries expire ~3 times per run, showing the **refill lifecycle**. Run with `node benchmark/run-miss-cache-benchmark.js --rounds=5`. Results from process-isolated harness.

| Round | Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | Total DB Queries | Peak Heap (MB) | Base Heap (MB) | Heap Growth (MB) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **R1** | Direct Prepared (No Cache) | 1,880 rps | 11.02 ms | 18.61 ms | 118.97 ms | 113,200 | 8.69 MB | 5.89 MB | +2.80 MB |
| **R1** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,968 rps | 2.09 ms | 9.44 ms | 11.68 ms | 56,830 | 13.24 MB | 5.89 MB | +7.35 MB |
| **R1** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,010 rps | **0.09 ms** | **0.16 ms** | **0.22 ms** | **3,073** | 13.38 MB | 5.89 MB | +7.49 MB |
| **R2** | Direct Prepared (No Cache) | 1,877 rps | 11.19 ms | 22.12 ms | 210.81 ms | 113,000 | 8.80 MB | 5.89 MB | +2.91 MB |
| **R2** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,968 rps | 0.72 ms | 9.55 ms | 10.91 ms | 56,736 | 13.10 MB | 5.89 MB | +7.21 MB |
| **R2** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,017 rps | **0.09 ms** | **0.18 ms** | **0.23 ms** | **3,056** | 13.43 MB | 5.89 MB | +7.54 MB |
| **R3** | Direct Prepared (No Cache) | 1,878 rps | 10.27 ms | 16.87 ms | 108.72 ms | 113,000 | 8.91 MB | 5.89 MB | +3.02 MB |
| **R3** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,966 rps | 0.43 ms | 9.14 ms | 13.78 ms | 56,224 | 13.19 MB | 5.89 MB | +7.30 MB |
| **R3** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,017 rps | **0.09 ms** | **0.19 ms** | **0.23 ms** | **3,064** | 13.39 MB | 5.89 MB | +7.50 MB |
| **R4** | Direct Prepared (No Cache) | 1,861 rps | 10.74 ms | 18.23 ms | 104.10 ms | 112,050 | 8.88 MB | 5.89 MB | +2.99 MB |
| **R4** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,961 rps | 0.32 ms | 9.56 ms | 18.29 ms | 56,432 | 13.59 MB | 5.89 MB | +7.70 MB |
| **R4** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,017 rps | **0.09 ms** | **0.18 ms** | **0.22 ms** | **3,073** | 13.38 MB | 5.89 MB | +7.49 MB |
| **R5** | Direct Prepared (No Cache) | 1,857 rps | 11.25 ms | 20.26 ms | 113.77 ms | 111,800 | 8.89 MB | 5.89 MB | +3.00 MB |
| **R5** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,959 rps | 0.40 ms | 9.14 ms | 104.54 ms | 56,391 | 13.36 MB | 5.89 MB | +7.47 MB |
| **R5** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,014 rps | **0.09 ms** | **0.18 ms** | **0.22 ms** | **3,061** | 13.49 MB | 5.89 MB | +7.60 MB |

> [!NOTE]
> _`Est. time saved` is a counterfactual estimate (`hits × avg miss-fetch latency`), and `Hit/Fetch latency ratio` is a per-operation latency ratio — **neither is an application throughput speedup** (those are in the tables above). Both scale with the avg miss-fetch (DB round-trip) latency, and the hit side is sub-microsecond and timer-noise-bound; read them as directional diagnostics, not precise measurements (see §8)._
> **Active Cache-Gain Metrics (Miss Protection Enabled, Round 5 Diagnosed via `cache.gain()`):**
> * **Miss Protection Enabled**: Est. time saved: `323,440.56 ms` | Hit/Fetch latency ratio (per-op, not throughput): `304.73x` | Active Size: `10,000` | Hit/Size Ratio: `6.05` | Code: `miss-protected` | *Recommendation: Miss-cache is absorbing a high share of bogus-key lookups (penetration protection). Low hit rate here reflects shielded misses, not a sizing problem.*
>
> _Half the traffic is bogus-key *misses*, which would drag the hit-rate/utilization signals down — but the miss-cache absorbs the flood, and `gain()` now tracks that via the `missCacheHits` counter (the `missProtectionRatio` signal). It therefore returns **`miss-protected`** instead of the earlier `low-value` mis-classification (fixed in Tier 2.8), correctly recognizing the library's strongest DB-load win (~97% query reduction). For the magnitude of the win, still read the DB-query and p99 columns — the `code` now points the right direction._

**Key Takeaway**: Over 60 seconds with `maxAgeMiss: 20`, miss-cache exhibits the **full lifecycle**: misses are cached, entries expire after 20s, and are refetched — total ~3,056–3,073 DB queries per round (~1,000 per 20s window), versus ~56k for `maxMiss: 0` (disabled) and ~112–113k for no cache. This **~97% reduction** proves the production claim: under indefinite attack, miss-cache **bounds** DB load to ~pool-size per TTL interval, not "zero forever" (which was an artifact of earlier 30s runs expiring nothing). p99 latency stays **~0.2 ms** (pure in-process), ~10–20 ms worse with `maxMiss: 0`, and ~110–210 ms worse uncached. Miss-cache costs ~7.5 MB bounded extra heap.

> **Workload & lifecycle integrity:** the script enforces `duration ≥ 2 × maxAgeMiss` so expiry+refill cycles are observed (guard rejects duration=30, maxAgeMiss=60, which would show only fill/absorb without refill). The bogus pool is validated small enough that bogus requests repeat heavily (≥3× per pool entry). See `test/miss-cache-workload.test.js` for regression tests. Default `maxAgeMiss: 20` is for demo (production uses 60, but 20 fits 3 cycles in one 60s benchmark run).

---

## 6. Deep Dive: Connection Pool Queueing & Feature ROI (Comparison of C and D)

A critical observation from the 5-round data is the difference in behavior between the **Sustained High-Concurrency Load Test (C)** and the **New Features Performance Benchmark (D)**:

### Why C's Cache Latencies Align with the Direct DB Baseline:
1. **Key-by-Key Miss Storms**: In `run-load-test.js` (C), the workload strictly sends individual single-key queries (`cache.getOrFetch(key)`). When a cache miss occurs under high load, the cache triggers a single-key database query (`SELECT ... WHERE uuid = $1`).
2. **Postgres Connection Pool Saturation**: Because the active sliding window (120,000 keys) is wider than the cache max capacity (100,000 keys), evictions are constant, triggering **~88,900–108,400 individual DB queries** during the 30-second run (vs. ~67,000–74,800 for caching strategies — a modest reduction that still saturates the pool).
3. **Queueing Latency**: Firing these lookups key-by-key saturates the Postgres client connection pool. The resulting socket queueing delays block both direct database queries and cache-miss fetches equally, causing cache latencies to match direct DB levels (p99 ~211–223 ms). This is a **deliberately under-provisioned stress case** — the working set (120k keys) exceeds the cache ceiling (100k), so the cache cannot fully serve its hot set.
4. **Row-Exist Rate**: The ~95% figure logged in `run-load-test.js` is the **DB row-existence rate** (whether the key existed in the DB at all), not the cache hit rate.

### How D's Caching Logic Resolves the Bottleneck:
In `run-new-features-benchmark.js` (D), we isolate the benefits of **Request Coalescing (single-flight)** and **Bulk Batch Loading (`getOrFetchMany`)**:
1. **Request Coalescing (Thundering Herd Protection)**: Under concurrent duplicate reads targeting the same hot keys, the cache coalesces the concurrent reads into a single database query, returning the shared result.
2. **Bulk Batch Loading**: For batch reads (fetching 20 keys at once), the cache groups all missed keys and fetches them in a single `WHERE uuid IN (...)` statement.
3. **Throughput & Latency ROI**: Unlike §C, §D's workload mixes batch reads (`getOrFetchMany`) and thundering-herd hot keys, so coalescing and batching keep DB query volume to **~52,700–55,200 per 30s window for `refreshed-cache`** (vs ~59,000–62,000 for raw `lru-cache` and ~90,000–95,600 for Direct). This keeps the pool unsaturated, holding p99 latency at **~30–38 ms** (vs Direct's **~196–209 ms**) while sustaining **~25k rps** — matching `lru-cache` with no measurable overhead from the orchestration layer.

---

## 7. Memory Baseline Analysis (Process-Isolated Harness)

Under the process-isolated harness, each `(strategy, round)` pair forks a fresh child process with a clean V8 heap and a new connection pool. This eliminates cross-round heap accumulation.

**Observed base heap per process** (consistent across all rounds):
- **Standard benchmark (§A)**: ~4–5 MB base heap (small/medium caches), ~195 MB with 500k-entry cache pre-loaded
- **Long-running simulation (§B)**: ~5.91 MB base heap per strategy process; **miss-cache attack (§E)**: ~5.89 MB
- **Load test (§C)**: ~6.21 MB and **new features (§D)**: ~6.29 MB base heap per strategy process

### What the memory figures prove:
1. **No cross-round accumulation**: Because each process starts cold, base heap stays flat at ~6 MB across all 5 rounds. Any heap growth observed is solely due to the strategy's own cache population and connection pool — not GC pressure or V8 page retention from prior rounds.
2. **No memory leak**: Peak heap stabilizes per strategy (e.g., Strategy B at ~42–46 MB, Strategy A at ~66–70 MB). The `Cleaned Heap` column confirms GC reclaims most growth after the load ends.
3. **Cache size drives heap, not round count**: The heap footprint correlates directly with cache cardinality (10k keys ≈ 4 MB, 100k keys ≈ 40 MB, 500k keys ≈ 195 MB), confirming memory is bounded and predictable.

---

## 8. Measurement Methodology

All results in §5 are produced by the **process-isolated harness** (`benchmark/lib/isolated-runner.js`). Key properties:

- **Process isolation**: each `(strategy, round)` forks a fresh child process with a clean heap and a new `postgres()` pool. Eliminates cross-round JIT deopt, GC pressure, and pool state accumulation.
- **High-resolution timing**: throughput and latency use `process.hrtime.bigint()` instead of `Date.now()`, giving nanosecond resolution. Sub-millisecond p50/p95/p99 figures in §B are real.
- **Quiesced memory**: baseline heap is captured after `--expose-gc` + `global.gc()` with an idle settle period, not mid-load.
- **Exact DB query counts**: each child process increments an atomic counter on every backend query; the total is an exact integer, not an estimate.
- **Load test (§C) is a deliberate stress case**: the 120k-key sliding window intentionally exceeds the 100k cache ceiling. This tests cache thrash under an under-provisioned cache, not optimal cache operation. The `Row-Exist Rate` column measures DB row existence, not cache hit rate — that distinction is intentional.
- **Injected fetch latency (§D)**: the cache `fetchByKey`/`fetchByKeys` paths in §D carry an `await sleep(10)` to model a remote-DB round trip on a miss. The **Direct (No Cache) baseline has no such sleep** — it hits local Postgres at sub-ms. This makes Direct look *better* than a production remote DB would (i.e. the comparison is conservative toward the cache for misses), but it also means the §D New-vs-Direct numbers understate the cache's real-world edge. Old-vs-New both pay the 10 ms, so that comparison is apples-to-apples.
- **`cache.gain()` figures are estimates, not measurements**: `Est. time saved = hits × (avg miss-fetch latency − avg hit latency)` is a counterfactual that assumes every hit would otherwise have been a full miss-fetch *at the injected ~10 ms latency*. `Hit/Fetch latency ratio` is `avg miss-fetch / avg hit` — a per-operation latency ratio, **not** an application throughput speedup. Hit latency is sampled (`latencySampleRate`, default 0.01) and measured with `performance.now()` around a single `Map.get`, so it is timer-noise-bound at the sub-microsecond scale; do not read its precision literally. Use these as directional diagnostics; use the table throughput/DB-query columns for hard claims.
- **Variance**: process isolation removes cross-round heap accumulation but not throughput noise. With n=5 and the spreads noted in §5, prefer medians over any single round; the per-section `cache.gain()` callouts happen to all be Round 5 and are illustrative, not representative.
- **Deterministic mode (`run-new-features-benchmark.js` only)**: this script supports a reproducible workload for regression diffing. (1) **Stateless seeded draws** — every random decision is `hashFloat(seedBase, requestSeq, drawIndex)`, a splitmix-style hash with **zero per-request allocation**, so *which* keys are touched depends only on `(--seed + round, requestSeq)` and never on async interleaving between the 4 workers (and adjacent requests are independently mixed, not seeded from adjacent integers). (2) **Cyclic logical window sweep** — the hot-key window advances by logical request progress (`reqSeq`), completing one full sweep every ~30s-equivalent of traffic (`SWEEP_PERIOD_SEC`), so the cadence matches the original wall-clock sweep but no longer shifts with GC/scheduling jitter, and a slow strategy can't fall behind into only the early universe. (3) **`--requests=N` work box** — stops after exactly N logical requests instead of after a duration, fixing the request *count* as well as the key sequence. (4) **GC settle points** before the baseline sample and before load starts. (5) **Median-of-N aggregate table** — multi-round runs print a `median (min–max)` summary per strategy beneath the per-round table, which is robust to single-round GC outliers while still surfacing the spread.

  **Measured reproducibility** (two back-to-back `--requests=40000 --seed=777` runs, 2026-06-05): all three arms are now **bit-identical** — **Direct 40,000**, **lru-cache 25,291**, **refreshed-cache 21,904** DB queries in *both* runs (down from a ~9% raw round-to-round swing). The stateless hash draws plus the `reqSeq`-driven sweep removed the timing dependence that previously held the cache arms to ~0.1% rather than exact. Note: at much larger `--requests` or higher worker counts, single-flight **coalescing** can still introduce sub-0.1% drift, because *which* concurrently-in-flight misses overlap is a scheduling property — so treat exact reproducibility as the observed floor at this scale, not a hard guarantee at every scale. Use a large `--requests` (e.g. 2M) for steady state; small counts are warmup-weighted and read below the steady ~25k rps.

### Known gap / open item: no raw `lru-cache` baseline

All baselines in §A–§E compare against **Postgres** (direct queries), not against a plain `lru-cache`. Because `refreshed-cache` is built *on* `lru-cache` (see §0), the coalescing/throughput claims in §D are measured against a hand-disabled-coalescing subclass, **not** lru-cache's native `fetchMethod` (which coalesces same-key fetches on its own). To make any head-to-head "vs lru-cache" performance claim, the suite would need a fourth baseline arm wrapping `new LRUCache({ max, ttl, fetchMethod })` directly. Until then, the only lru-cache-relative claims that hold are **feature-level** ones — the capabilities lru-cache lacks entirely (timed bulk refresh §B, multi-key batch fetch, miss-cache §E), summarized in §0.

---

## 9. Effective Production Usage Patterns

Five numbered patterns ordered from **simplest to most advanced** — start from Pattern 1 and only add complexity when your situation demands it. Each pattern opens with a concrete use case, then the mechanism, then the benchmark evidence.

| # | Pattern | When to reach for it |
| :--- | :--- | :--- |
| **1** | Scheduled Full-Refresh | Whole dataset fits in RAM, changes infrequently, every request needs it |
| **2** | Active-Only Refresh | Dataset is huge (millions of rows), only a fraction is hot at any time |
| **3** | Lazy Fetch with Coalescing | Reads are per-key and traffic can spike on the same key simultaneously |
| **4** | Batch Loading (N+1 Collapse) | You load multiple related records per request (feeds, dashboards, lists) |
| **5** | Miss-Cache (Penetration Protection) | Non-existent key lookups reach the DB and you can't stop the source |

---

### Pattern 1: Scheduled Full-Refresh (Whole Dataset, Small/Medium)

> **Use case — feature flags, pricing config, FX rates.**
> Your app has a table of a few thousand rows that **every single request reads** — feature flags, product prices, currency rates. The data changes only every few minutes. Without a cache, every HTTP request fires a DB query even though the answer is almost certainly the same one it got a second ago. You load the whole table once at startup, refresh it on a 5-minute timer, and every request becomes a **pure in-memory lookup** that never touches the DB. Data is eventually consistent up to `refreshAge` seconds — acceptable for config/pricing that changes on human timescales.

**When to use:** dataset fits comfortably in RAM, low-to-moderate write frequency, strong read QPS.

**Benchmark backing:** §5B Strategy A — 95% hit rate, p50 ~0.05 ms, **DB queries scale with refresh interval, not with read QPS**. At 2,000 rps for 30s the DB sees only ~53k queries total (one full reload per refresh cycle), not 60,000 per-request queries.

```javascript
const Cache = require("refreshed-cache");

const cache = new Cache(
  async () => {
    const rows = await db.query("SELECT id, data FROM config_items ORDER BY priority");
    return rows.map(r => [r.id, r.data]); // [key, value] pairs
  },
  {
    max: 50000,          // Max entries to keep in memory
    maxAge: 600,         // Evict entries older than 10 minutes
    refreshAge: 300,     // Re-fetch the full set every 5 minutes
    resetOnRefresh: true // Replace cache contents on each refresh
  }
);

await cache.init(); // Load initial data and start the refresh loop

app.get("/config/:id", (req, res) => {
  const item = cache.get(req.params.id); // Pure in-process lookup, ~0.05 ms
  res.json(item ?? null);
});
```

---

### Pattern 2: Active-Only Refresh (Hot Subset of a Huge Dataset)

> **Use case — user-profile service with 20 million accounts.**
> You have 20 million user rows (~3.6 GB on disk). You cannot load them all into RAM, but caching nothing means every request hits the DB. The insight: at any given moment only **~50,000 users are actually active** (logged in, browsing). Active-Only Refresh keeps only those ~50k profiles warm in ~44 MB of heap, and each refresh cycle re-fetches *only those keys* in a single batched query. The other 19.95 million cold rows are never touched. As the active population shifts across the day, the cache tracks it automatically — keys that go cold age out, keys that go hot get fetched on first miss and refreshed on subsequent cycles.

**When to use:** row count is in the millions (too large to pre-load fully), but a small hot subset gets the vast majority of traffic.

**Benchmark backing:** §5B — 95% hit rate over 20M rows from a bounded ~44 MB hot set; flat memory across 5 rounds. On DB queries: the active+batched path (Strategy C) fires ~601 queries/30s window while a naive per-key miss-fetch path (Strategy A/B) fires ~51k — a ~90× difference *between cache configs*. Note: a well-batched no-cache baseline also sits at ~600, so the win over *no cache* is read latency (~0.04 ms in-process vs a DB round trip) and memory bounding, not raw query count.

```javascript
const cache = new Cache(
  async (recentKeys) => {
    // Called on each refresh cycle with the keys accessed since last cycle.
    // Fetch only the hot set — never loads the full 20M rows.
    if (!recentKeys || recentKeys.length === 0) return [];
    const rows = await db.query(
      "SELECT id, data FROM profiles WHERE id = ANY($1)", [recentKeys]
    );
    return rows.map(r => [r.id, r.data]);
  },
  {
    max: 100000,             // Hard cap — only ~44 MB even at 100k profiles
    maxAge: 600,             // Evict entries not refreshed in 10 minutes
    refreshAge: 300,         // Refresh active keys every 5 minutes
    resetOnRefresh: false,   // Keep existing unexpired items between cycles
    passRecentKeysOnRefresh: true // Give the loader only the active key list
  }
);
```

---

### Pattern 3: Lazy Fetch with Coalescing (Per-Key, Thundering-Herd Safe)

> **Use case — a flash-sale product page.**
> At 12:00:00 a limited deal goes live and **50,000 shoppers simultaneously hit `GET /product/flash-deal-42`**. The item isn't in the cache yet (it was just activated), so all 50,000 requests miss at the same instant. Without coalescing, each miss independently fires `SELECT * FROM products WHERE id=42` — a thundering herd that can topple the DB. With coalescing, the **first** request that misses starts the DB query and registers a pending Promise. Every other concurrent miss for the same key **joins that same Promise** rather than issuing its own query. One DB query serves all 50,000 waiters. Once the result is cached, subsequent requests are pure in-memory hits.

**When to use:** reads are per-key (ORM `findById`, REST `/resource/:id`), traffic can spike on the same key simultaneously (viral content, product drops, breaking news).

**Benchmark backing:** §5A — per-key baseline (50k `WHERE uuid=$1` queries) reduced ~3× by the cache (~16k). §5D — under a 30%-same-key burst, `refreshed-cache` holds p99 at ~27–38 ms (vs Direct's ~186–209 ms) while coalescing trims DB queries below the raw `lru-cache` arm. ⚠️ The Direct baseline is no-latency local Postgres, so the throughput edge is modest here — coalescing's win is most visible in production where DB round trips are 5–20 ms.

```javascript
const Cache = require("refreshed-cache");

const cache = new Cache(
  async () => [], // No bulk pre-load; entries are fetched lazily on first miss
  {
    max: 100000,
    maxAge: 300,
    fetchByKey: async (id) => {
      // Concurrent misses for the same id are automatically coalesced —
      // only ONE query runs no matter how many requests are waiting.
      return await db.query("SELECT * FROM products WHERE id = $1", [id]);
    }
  }
);

app.get("/product/:id", async (req, res) => {
  const product = await cache.getOrFetch(req.params.id);
  res.json(product ?? null);
});
```

---

### Pattern 4: Batch Loading — N+1 Collapse (Multi-Key per Request)

> **Use case — rendering a social media feed.**
> Each feed page shows 20 posts. To display each post you need its **author's name and avatar** — a separate lookup per post. The naive code fetches authors one at a time in a loop: 20 `SELECT ... WHERE id=?` queries per page render — the classic **N+1 problem**. With 1,000 concurrent users rendering feeds, the DB is taking 20,000 tiny per-author queries every second. `getOrFetchMany([id1, id2, ..., id20])` first checks the cache for each id, then collapses all the *cache misses* into a **single** `WHERE id IN (...)` query. The next render that needs the same authors is a pure cache hit.

**When to use:** a single request needs multiple related records (feed items, dashboard widgets, product recommendations, order line items). Combine with Pattern 3 — `fetchByKey` handles single-key coalescing and `fetchByKeys` handles multi-key batching; they work together.

**Benchmark backing:** §5D shows `refreshed-cache` matching raw `lru-cache` throughput while coalescing trims DB queries below it (~1.04M vs ~1.14M / 600s) — but it no longer isolates an N+1 multiplier (the prior "2.3–2.7× vs a no-coalescing subclass" arm was removed). The benchmark §5A is a closer proxy: it measures a per-key no-cache baseline (one `WHERE uuid=$1` per request) and the cache cuts that ~3×. ⚠️ Neither benchmark isolates batch loading specifically with realistic network latency. A proper N+1 benchmark is an open item (see §8).

```javascript
const cache = new Cache(
  async () => [],
  {
    max: 100000,
    maxAge: 300,
    fetchByKeys: async (ids) => {
      // Called with only the ids that were NOT in the cache.
      // One query regardless of how many ids are missing.
      const rows = await db.query(
        "SELECT id, name, avatar FROM users WHERE id = ANY($1)", [ids]
      );
      return rows.map(r => [r.id, r]); // [key, value] pairs
    },
    fetchByKey: async (id) => {
      // Fallback for single-key getOrFetch() calls — also coalesced.
      const [row] = await db.query("SELECT id, name, avatar FROM users WHERE id = $1", [id]);
      return row ?? undefined;
    }
  }
);

app.get("/feed", async (req, res) => {
  const posts = await getPosts(req.user.id);           // your existing logic
  const authorIds = posts.map(p => p.authorId);
  const authors = await cache.getOrFetchMany(authorIds); // 1 DB query for all misses
  res.json(posts.map(p => ({ ...p, author: authors[p.authorId] })));
});
```

---

### Pattern 5: Miss-Cache — Cache Penetration Protection

> **Use case — bots probing a public product API with random SKUs.**
> Your `GET /item/:sku` endpoint is public. A bot starts requesting non-existent SKUs — `SKU-99999999`, `SKU-88888888`, randomised strings — thousands of times per second. A normal cache never helps here: the key isn't found, so every bogus request "misses" straight through to the DB (`SELECT * FROM items WHERE sku=?`), which also returns nothing — and the DB query fires again next time the same bogus SKU arrives. The cache is completely bypassed. This is **cache penetration**: traffic designed (or accidental) to pass through the cache layer and hit the database directly on every single request. Miss-cache fixes it by **remembering that a key doesn't exist** for `maxAgeMiss` seconds. Repeat probes for the same bogus SKU are answered from a tiny in-memory entry (`true`) and the DB never sees them again until the TTL expires.

**When to use:** non-existent key lookups are reaching the DB repeatedly and you can't block the source at the network level; also useful for protecting against accidental N+1 lookups for IDs that were deleted.

**Benchmark backing:** §5E — the strongest cache-vs-no-cache evidence in the suite. Three-way comparison (no cache / cache without miss-protection / cache with miss-protection) over 60s with `maxAgeMiss: 20`: **Direct 110k → disabled 56k → enabled ~3k DB queries (~97% reduction)**. p99 drops from ~200 ms (no cache) to ~10 ms (cache, no miss-protection) to **~0.2 ms** (miss-cache enabled). The refill lifecycle is explicitly tested: duration is enforced ≥ 2× `maxAgeMiss` so miss-cache entries expire and refill at least twice per run — proving the bound holds indefinitely, not just for the first TTL window. Extra heap cost: ~7.5 MB.

```javascript
const cache = new Cache(
  async () => [],
  {
    max: 100000,
    fetchByKey: async (sku) => {
      const [item] = await db.query("SELECT * FROM items WHERE sku = $1", [sku]);
      // Returning undefined signals "this key does not exist".
      // refreshed-cache stores it in the miss-cache sidecar — future lookups
      // for this SKU are answered in-process until maxAgeMiss expires.
      return item ?? undefined;
    },
    maxMiss: 10000,   // Up to 10,000 distinct non-existent keys remembered
    maxAgeMiss: 60    // Each remembered for 60 seconds; then re-checked once
    // maxMiss: 0     // Set to 0 to disable miss-cache entirely (opt-out)
  }
);

app.get("/item/:sku", async (req, res) => {
  const item = await cache.getOrFetch(req.params.sku);
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
});
```



---

## 10. Appendix: June 3, 2026 Baseline Benchmarks

Below are the baseline benchmark results recorded on June 3, 2026, before implementing Tier 2.5 high-precision latency tracking and cache-gain metrics.

### Baseline A. Standard Scenario Throughput
| Round | Scenario | Cache Size | Init Time | DB Ops/sec | DB Queries Direct | Cache Ops/sec | DB Queries Cache | Speedup | Correctness | Heap Mem | RSS Mem |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Round 1** | Small Cache (1% coverage) | 10,000 | 29 ms | 33,089 | 50,000 | 106,344 | 20,837 | **3.21x** | ✅ PASSED | 4.26 MB | 15.01 MB |
| **Round 1** | Medium Cache (10% coverage) | 100,000 | 148 ms | 17,851 | 50,000 | 129,549 | 16,291 | **7.26x** | ✅ PASSED | 39.94 MB | 139.67 MB |
| **Round 1** | Large Cache (50% coverage) | 500,000 | 630 ms | 21,328 | 50,000 | 133,483 | 15,158 | **6.26x** | ✅ PASSED | 194.18 MB | 207.16 MB |
| **Round 2** | Small Cache (1% coverage) | 10,000 | 24 ms | 29,597 | 50,000 | 50,253 | 21,028 | **1.70x** | ✅ PASSED | 4.24 MB | 17.29 MB |
| **Round 2** | Medium Cache (10% coverage) | 100,000 | 142 ms | 16,374 | 50,000 | 44,294 | 16,443 | **2.71x** | ✅ PASSED | 39.93 MB | 114.64 MB |
| **Round 2** | Large Cache (50% coverage) | 500,000 | 677 ms | 17,394 | 50,000 | 73,990 | 15,199 | **4.25x** | ✅ PASSED | 194.81 MB | 189.03 MB |
| **Round 3** | Small Cache (1% coverage) | 10,000 | 27 ms | 22,528 | 50,000 | 93,634 | 20,848 | **4.16x** | ✅ PASSED | 4.26 MB | 15.64 MB |
| **Round 3** | Medium Cache (10% coverage) | 100,000 | 150 ms | 16,942 | 50,000 | 114,054 | 16,158 | **6.73x** | ✅ PASSED | 39.98 MB | 106.45 MB |
| **Round 3** | Large Cache (50% coverage) | 500,000 | 761 ms | 20,803 | 50,000 | 57,021 | 15,314 | **2.74x** | ✅ PASSED | 194.81 MB | 209.50 MB |
| **Round 4** | Small Cache (1% coverage) | 10,000 | 28 ms | 31,447 | 50,000 | 93,934 | 20,908 | **2.99x** | ✅ PASSED | 4.25 MB | 15.83 MB |
| **Round 4** | Medium Cache (10% coverage) | 100,000 | 130 ms | 19,742 | 50,000 | 42,735 | 16,361 | **2.16x** | ✅ PASSED | 39.95 MB | 113.43 MB |
| **Round 4** | Large Cache (50% coverage) | 500,000 | 984 ms | 13,258 | 50,000 | 67,071 | 15,344 | **5.06x** | ✅ PASSED | 194.81 MB | 207.89 MB |
| **Round 5** | Small Cache (1% coverage) | 10,000 | 25 ms | 8,452 | 50,000 | 48,822 | 20,676 | **5.78x** | ✅ PASSED | 4.26 MB | 14.88 MB |
| **Round 5** | Medium Cache (10% coverage) | 100,000 | 131 ms | 18,015 | 50,000 | 30,261 | 16,343 | **1.68x** | ✅ PASSED | 39.93 MB | 111.70 MB |
| **Round 5** | Large Cache (50% coverage) | 500,000 | 669 ms | 20,582 | 50,000 | 71,336 | 15,370 | **3.47x** | ✅ PASSED | 194.81 MB | 207.98 MB |

### Baseline B. Long-Running Strategy Simulation
| Strategy | Hit Rate | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Peak Heap | Base Heap | Heap Growth | Cleaned Heap | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[R1] Direct Prepared Statements** | 0% | 2000 rps | 0.05 ms | 0.08 ms | 0.10 ms | 400 | 25.74 MB | 5.84 MB | +19.90 MB | 24.83 MB | N/A |
| **[R1] Strategy A: Scheduled Full Refresh** | 95.1% | 2000 rps | 0.02 ms | 0.05 ms | 0.10 ms | 34,734 | 67.07 MB | 5.85 MB | +61.22 MB | 28.46 MB | ✅ PASSED |
| **[R1] Strategy B: Lazy Fetch-on-Miss** | 95.1% | 2000 rps | 0.02 ms | 0.04 ms | 0.08 ms | 34,867 | 39.49 MB | 5.85 MB | +33.64 MB | 29.01 MB | ✅ PASSED |
| **[R1] Strategy C: Active-Only Refresh** | 95.1% | 2000 rps | 0.04 ms | 0.06 ms | 0.09 ms | 401 | 39.80 MB | 5.84 MB | +33.96 MB | 30.72 MB | ✅ PASSED |
| **[R2] Direct Prepared Statements** | 0% | 2000 rps | 0.05 ms | 0.19 ms | 0.41 ms | 600 | 25.79 MB | 5.83 MB | +19.96 MB | 24.89 MB | N/A |
| **[R2] Strategy A: Scheduled Full Refresh** | 95.1% | 2000 rps | 0.08 ms | 0.36 ms | 0.80 ms | 53,468 | 69.03 MB | 5.83 MB | +63.20 MB | 28.32 MB | ✅ PASSED |
| **[R2] Strategy B: Lazy Fetch-on-Miss** | 95.0% | 2000 rps | 0.05 ms | 1.13 ms | 2.08 ms | 51,172 | 45.24 MB | 5.82 MB | +39.42 MB | 28.57 MB | ✅ PASSED |
| **[R2] Strategy C: Active-Only Refresh** | 95.0% | 2000 rps | 0.07 ms | 0.34 ms | 0.47 ms | 601 | 43.82 MB | 5.83 MB | +37.99 MB | 30.76 MB | ✅ PASSED |
| **[R3] Direct Prepared Statements** | 0% | 2000 rps | 0.05 ms | 0.32 ms | 1.48 ms | 600 | 25.78 MB | 5.82 MB | +19.96 MB | 24.88 MB | N/A |
| **[R3] Strategy A: Scheduled Full Refresh** | 95.0% | 2000 rps | 0.05 ms | 0.18 ms | 2.05 ms | 53,562 | 67.04 MB | 5.82 MB | +61.22 MB | 28.23 MB | ✅ PASSED |
| **[R3] Strategy B: Lazy Fetch-on-Miss** | 95.0% | 2000 rps | 0.08 ms | 0.48 ms | 0.69 ms | 51,367 | 42.29 MB | 5.82 MB | +36.47 MB | 28.48 MB | ✅ PASSED |
| **[R3] Strategy C: Active-Only Refresh** | 94.8% | 2000 rps | 0.06 ms | 0.27 ms | 0.37 ms | 601 | 43.85 MB | 5.82 MB | +38.03 MB | 30.77 MB | ✅ PASSED |
| **[R4] Direct Prepared Statements** | 0% | 2000 rps | 0.05 ms | 0.18 ms | 0.45 ms | 600 | 25.78 MB | 5.83 MB | +19.95 MB | 24.88 MB | N/A |
| **[R4] Strategy A: Scheduled Full Refresh** | 94.9% | 2000 rps | 0.08 ms | 0.18 ms | 0.50 ms | 53,523 | 66.41 MB | 5.83 MB | +60.58 MB | 28.57 MB | ✅ PASSED |
| **[R4] Strategy B: Lazy Fetch-on-Miss** | 94.9% | 2000 rps | 0.07 ms | 0.24 ms | 0.47 ms | 51,253 | 42.89 MB | 5.82 MB | +37.07 MB | 29.14 MB | ✅ PASSED |
| **[R4] Strategy C: Active-Only Refresh** | 95.0% | 2000 rps | 0.10 ms | 0.38 ms | 0.78 ms | 601 | 43.74 MB | 5.82 MB | +37.92 MB | 30.68 MB | ✅ PASSED |
| **[R5] Direct Prepared Statements** | 0% | 2000 rps | 0.09 ms | 0.39 ms | 0.91 ms | 600 | 25.78 MB | 5.83 MB | +19.95 MB | 24.88 MB | N/A |
| **[R5] Strategy A: Scheduled Full Refresh** | 94.9% | 2000 rps | 0.05 ms | 0.22 ms | 2.03 ms | 53,422 | 67.12 MB | 5.82 MB | +61.30 MB | 28.24 MB | ✅ PASSED |
| **[R5] Strategy B: Lazy Fetch-on-Miss** | 95.2% | 2000 rps | 0.05 ms | 0.11 ms | 0.40 ms | 51,306 | 42.95 MB | 5.82 MB | +37.13 MB | 29.13 MB | ✅ PASSED |
| **[R5] Strategy C: Active-Only Refresh** | 94.9% | 2000 rps | 0.04 ms | 0.14 ms | 0.28 ms | 601 | 43.92 MB | 5.83 MB | +38.09 MB | 30.77 MB | ✅ PASSED |

### Baseline C. Sustained High-Concurrency Load Test
| Round | Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | Row-Exist Rate | DB Queries | Peak Heap | Base Heap | Heap Growth | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Round 1** | Direct Prepared (No Cache) | 2,648 rps | 11.49 ms | 205.40 ms | 213.67 ms | 94.9% | 80,300 | 30.95 MB | 6.16 MB | +24.79 MB | PASSED |
| **Round 1** | Lazy Fetch-on-Miss | 2,442 rps | 8.16 ms | 207.11 ms | 217.99 ms | 94.9% | 58,242 | 52.27 MB | 6.16 MB | +46.11 MB | PASSED |
| **Round 1** | Active-Only Refresh | 2,546 rps | 7.79 ms | 206.92 ms | 216.02 ms | 94.9% | 60,070 | 52.71 MB | 6.16 MB | +46.55 MB | PASSED |
| **Round 2** | Direct Prepared (No Cache) | 2,581 rps | 10.16 ms | 208.15 ms | 219.32 ms | 94.9% | 77,500 | 31.63 MB | 6.13 MB | +25.50 MB | PASSED |
| **Round 2** | Lazy Fetch-on-Miss | 2,953 rps | 4.65 ms | 203.25 ms | 218.08 ms | 95.0% | 66,720 | 58.01 MB | 6.13 MB | +51.88 MB | PASSED |
| **Round 2** | Active-Only Refresh | 3,530 rps | 3.33 ms | 201.23 ms | 212.90 ms | 95.0% | 76,050 | 66.46 MB | 6.13 MB | +60.33 MB | PASSED |
| **Round 3** | Direct Prepared (No Cache) | 2,866 rps | 9.83 ms | 207.22 ms | 218.73 ms | 95.0% | 86,600 | 31.06 MB | 6.13 MB | +24.93 MB | PASSED |
| **Round 3** | Lazy Fetch-on-Miss | 3,678 rps | 3.70 ms | 145.06 ms | 207.85 ms | 94.9% | 77,780 | 55.96 MB | 6.13 MB | +49.83 MB | PASSED |
| **Round 3** | Active-Only Refresh | 3,668 rps | 3.82 ms | 156.52 ms | 209.34 ms | 95.0% | 77,674 | 55.82 MB | 6.13 MB | +49.69 MB | PASSED |
| **Round 4** | Direct Prepared (No Cache) | 3,135 rps | 9.61 ms | 207.33 ms | 226.41 ms | 95.0% | 94,500 | 31.29 MB | 6.13 MB | +25.16 MB | PASSED |
| **Round 4** | Lazy Fetch-on-Miss | 3,586 rps | 3.42 ms | 138.47 ms | 206.13 ms | 95.1% | 76,366 | 56.89 MB | 6.13 MB | +50.76 MB | PASSED |
| **Round 4** | Active-Only Refresh | 3,886 rps | 3.36 ms | 143.95 ms | 208.14 ms | 95.0% | 80,576 | 58.65 MB | 6.13 MB | +52.52 MB | PASSED |
| **Round 5** | Direct Prepared (No Cache) | 3,363 rps | 9.76 ms | 205.77 ms | 216.21 ms | 94.9% | 101,800 | 30.96 MB | 6.13 MB | +24.83 MB | PASSED |
| **Round 5** | Lazy Fetch-on-Miss | 2,295 rps | 5.40 ms | 205.29 ms | 212.97 ms | 94.9% | 55,140 | 48.77 MB | 6.13 MB | +42.64 MB | PASSED |
| **Round 5** | Active-Only Refresh | 4,150 rps | 3.01 ms | 28.05 ms | 206.07 ms | 95.0% | 84,249 | 60.43 MB | 6.13 MB | +54.30 MB | PASSED |

### Baseline D. New Features Performance ROI
| Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Peak Heap | Base Heap | Heap Growth | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[R1] Direct Prepared** | 21,068 rps | 5.80 ms | 13.89 ms | 204.54 ms | 94,800 | 33.23 MB | 6.21 MB | +27.02 MB | ✅ PASSED |
| **[R1] Old Caching Logic** | 7,969 rps | 22.07 ms | 225.92 ms | 238.55 ms | 127,712 | 54.59 MB | 6.21 MB | +48.38 MB | ✅ PASSED |
| **[R1] New Caching Logic** | **24,860 rps** | **11.83 ms** | **19.42 ms** | **25.19 ms** | **53,230** | **63.31 MB** | 6.21 MB | **+57.10 MB** | ✅ PASSED |
| **[R2] Direct Prepared** | 18,463 rps | 6.62 ms | 19.20 ms | 211.89 ms | 83,300 | 33.31 MB | 6.21 MB | +27.10 MB | ✅ PASSED |
| **[R2] Old Caching Logic** | 8,840 rps | 19.74 ms | 223.74 ms | 242.20 ms | 135,581 | 55.18 MB | 6.21 MB | +48.97 MB | ✅ PASSED |
| **[R2] New Caching Logic** | **25,195 rps** | **11.73 ms** | **19.74 ms** | **26.69 ms** | **54,527** | **62.73 MB** | 6.21 MB | **+56.52 MB** | ✅ PASSED |
| **[R3] Direct Prepared** | 16,884 rps | 6.81 ms | 19.19 ms | 212.45 ms | 76,250 | 31.23 MB | 6.21 MB | +25.02 MB | ✅ PASSED |
| **[R3] Old Caching Logic** | 7,842 rps | 19.95 ms | 223.89 ms | 238.56 ms | 126,527 | 54.50 MB | 6.21 MB | +48.29 MB | ✅ PASSED |
| **[R3] New Caching Logic** | **24,403 rps** | **11.79 ms** | **19.40 ms** | **26.00 ms** | **52,728** | **62.54 MB** | 6.21 MB | **+56.33 MB** | ✅ PASSED |
| **[R4] Direct Prepared** | 19,908 rps | 5.84 ms | 16.30 ms | 206.30 ms | 89,950 | 33.04 MB | 6.21 MB | +26.83 MB | ✅ PASSED |
| **[R4] Old Caching Logic** | 8,754 rps | 20.71 ms | 225.43 ms | 242.06 ms | 134,137 | 54.73 MB | 6.21 MB | +48.52 MB | ✅ PASSED |
| **[R4] New Caching Logic** | **25,309 rps** | **11.40 ms** | **19.68 ms** | **29.54 ms** | **54,553** | **60.07 MB** | 6.21 MB | **+53.86 MB** | ✅ PASSED |
| **[R5] Direct Prepared** | 21,822 rps | 5.07 ms | 13.80 ms | 198.93 ms | 98,100 | 29.98 MB | 6.21 MB | +23.77 MB | ✅ PASSED |
| **[R5] Old Caching Logic** | 9,144 rps | 21.05 ms | 223.23 ms | 236.52 ms | 137,877 | 54.55 MB | 6.21 MB | +48.34 MB | ✅ PASSED |
| **[R5] New Caching Logic** | **25,427 rps** | **11.56 ms** | **19.56 ms** | **27.33 ms** | **54,376** | **60.85 MB** | 6.21 MB | **+54.64 MB** | ✅ PASSED |

### Baseline E. Cache-Penetration Attack Protection
| Round | Strategy | Avg Throughput | p50 Latency | p95 Latency | p99 Latency | DB Queries | Peak Heap | Base Heap | Heap Growth |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **R1** | Direct Prepared (No Cache) | 1,889 rps | 6.68 ms | 10.96 ms | 18.28 ms | 113,750 | 8.37 MB | 5.84 MB | +2.53 MB |
| **R1** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,968 rps | 0.24 ms | 6.18 ms | 9.87 ms | 57,321 | 12.99 MB | 5.84 MB | +7.15 MB |
| **R1** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,023 rps | **0.08 ms** | **0.18 ms** | **0.24 ms** | **3,053** | 13.37 MB | 5.84 MB | +7.53 MB |
| **R2** | Direct Prepared (No Cache) | 1,843 rps | 10.18 ms | 108.22 ms | 208.35 ms | 111,150 | 8.64 MB | 5.84 MB | +2.80 MB |
| **R2** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,930 rps | 0.30 ms | 7.51 ms | 9.33 ms | 55,961 | 13.45 MB | 5.84 MB | +7.61 MB |
| **R2** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,027 rps | **0.09 ms** | **0.19 ms** | **0.24 ms** | **3,053** | 13.32 MB | 5.84 MB | +7.48 MB |
| **R3** | Direct Prepared (No Cache) | 1,820 rps | 10.60 ms | 18.43 ms | 207.60 ms | 109,700 | 9.05 MB | 5.84 MB | +3.21 MB |
| **R3** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,938 rps | 2.17 ms | 8.09 ms | 12.43 ms | 55,756 | 13.39 MB | 5.84 MB | +7.55 MB |
| **R3** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,013 rps | **0.09 ms** | **0.18 ms** | **0.24 ms** | **3,058** | 13.39 MB | 5.84 MB | +7.55 MB |
| **R4** | Direct Prepared (No Cache) | 1,835 rps | 10.04 ms | 108.78 ms | 208.46 ms | 110,500 | 8.52 MB | 5.84 MB | +2.68 MB |
| **R4** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,954 rps | 0.28 ms | 8.21 ms | 10.39 ms | 56,166 | 13.46 MB | 5.84 MB | +7.62 MB |
| **R4** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,013 rps | **0.08 ms** | **0.16 ms** | **0.20 ms** | **3,037** | 13.31 MB | 5.84 MB | +7.47 MB |
| **R5** | Direct Prepared (No Cache) | 1,885 rps | 8.44 ms | 14.38 ms | 109.52 ms | 113,700 | 8.86 MB | 5.84 MB | +3.02 MB |
| **R5** | Cache — Miss Protection **Disabled** (`maxMiss: 0`) | 1,955 rps | 0.71 ms | 7.04 ms | 8.65 ms | 55,817 | 13.24 MB | 5.84 MB | +7.40 MB |
| **R5** | Cache — Miss Protection **Enabled** (`maxMiss: 10000, maxAgeMiss: 20`) | 2,010 rps | **0.08 ms** | **0.16 ms** | **0.21 ms** | **3,064** | 13.41 MB | 5.84 MB | +7.57 MB |
