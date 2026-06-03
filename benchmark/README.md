# Refreshed Cache - Postgres Benchmarking Suite

This directory contains a benchmark suite that compares the performance, memory usage, and correctness of `refreshed-cache` against direct Postgres querying using the `postgres` library.

---

## 1. Prerequisites

- **Node.js** (v18+)
- **Docker** or **OrbStack**

---

## 2. Benchmark Setup & Database Size

The database is populated with **10,000,000** records generated via a fast SQL generator (`generate_series`). Each row contains:
- `id` (SERIAL PRIMARY KEY)
- `uuid` (VARCHAR UNIQUE) - indexed
- `name` (VARCHAR)
- `email` (VARCHAR)
- `metadata` (JSONB) - containing nested properties simulating user profiles

### Physical DB Sizes at 10M Rows:
* **Table Data Size (Relation Size)**: `1,850 MB` (1.85 GB)
* **Total Table Size (Data + Indexes)**: `3,524 MB` (3.52 GB)
* **Overall Database Size**: `3,532 MB` (3.53 GB)

---

## 3. Files & Architecture

- `docker-compose.yml`: Spins up Postgres 17 on port `5439`.
- `schema.sql`: Table definitions and index structures.
- `seed.js`: Database seeding script.
- `run-benchmark.js`: Measures standard scenario throughput (hits vs. misses) and tracks `DB Queries Triggered`.
- `run-long-benchmark.js`: Simulates caching strategies over multiple intervals, verifying memory limits and garbage collection behavior.
- `run-load-test.js`: Sustained concurrent user load test comparing local caching against Direct Prepared Statements (No Cache).
- `run-new-features-benchmark.js`: Evaluates performance ROI of Single-flight Promise Coalescing and Bulk Batch Loading.

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

### Run Benchmarks (with Optional `--rounds=N` and `--duration=S` args)
Each script can be run with `--rounds` (default: 1) and `--duration` (for load simulations, in seconds) to gather comprehensive data.

```bash
# 1. Standard Benchmark (5 rounds)
node benchmark/run-benchmark.js --rounds=5

# 2. Strategy Simulation (5 rounds, 30s duration)
node benchmark/run-long-benchmark.js --rounds=5 --duration=30

# 3. Sustained Load Test (5 rounds, 30s duration)
node benchmark/run-load-test.js --rounds=5 --duration=30

# 4. New Features Benchmark (5 rounds, 30s duration)
node benchmark/run-new-features-benchmark.js --rounds=5 --duration=30
```

---

## 5. Benchmark Results (10,000,000 Total DB Rows)

### A. Standard Scenario Throughput (50,000 Lookups, 5-Rounds Run)
Simulates 50,000 read queries with a realistic traffic distribution of 70% cache hits, 25% cache misses (exist in DB), and 5% hard misses.

*Direct Prepared Statements (No Cache) are compared directly against the Cache as a baseline.*

| Scenario | Cache Size | Init Time | Avg DB Ops/sec | DB Queries Direct | Avg Cache Ops/sec | DB Queries Cache | Speedup | Correctness |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Small Cache** (1% coverage) | 10,000 | ~20 ms | ~17,600 | 50,000 | ~48,600 | 20,800 | **2.76x** | ✅ PASSED |
| **Medium Cache** (10% coverage) | 100,000 | ~130 ms | ~15,600 | 50,000 | ~42,800 | 16,200 | **2.74x** | ✅ PASSED |
| **Large Cache** (50% coverage) | 500,000 | ~580 ms | ~15,100 | 50,000 | ~37,600 | 15,300 | **2.49x** | ✅ PASSED |

---

### B. Long-Running Caching Strategies (5 Rounds, max: 100,000)
Evaluates strategies under a shifting hot key load (sliding window) using a strict limit of `max: 100000` keys to test process RAM safety and GC leaks:

- **Direct Prepared Statements (No Cache)**: Database queries match the exact traffic volume (high database load).
- **Strategy A (Scheduled Full Refresh)**: Periodically pulls the first 100,000 items, triggering significant DB traffic during sync.
- **Strategy B (Lazy Fetch-on-Miss)**: Populates the cache dynamically on misses.
- **Strategy C (Active-Only Refresh)**: Keeps active items fresh by passing recent keys to the fetcher, reducing database lookups to only the active working set.

**Key Observation**: `Strategy C` achieves the same **95% hit rate** as Strategy A/B, but reduces database query traffic by **over 90x** (from 50,000+ lookups to under 601), keeping memory flat and growth minimal (~4 MB).

---

### C. Sustained High-Concurrency Load Test (Cache vs. Prepared Statements)
Under sustained high-concurrency concurrent traffic, direct database queries suffer from connection pooling and queueing delays, causing tail latencies to spike. 

- **Prepared Statement Baseline**: Latencies (p95/p99) consistently exceed **200 ms - 250 ms** under heavy traffic.
- **In-Process Cache**: Bypasses connection queuing completely, resolving p50 latencies in under **10 ms** and keeping heap memory bounded and garbage collected successfully.

---

### D. New Features Performance ROI (Promise Coalescing & Bulk Batching)
By preventing the thundering herd problem (coalescing duplicate read requests) and bulk fetching missed keys:

1. **Throughput**: Throughput scales from **~6,000 rps** (old caching architecture) to **~24,500 rps** (new caching architecture with coalescing and batching).
2. **Tail Latency (p99)**: drops from **~260 ms** to **~25 ms**.
3. **Database Protection**: Reduces total database queries triggered by nearly **2x**.
4. **Correctness**: Verified 100% data consistency against Postgres post-load.
