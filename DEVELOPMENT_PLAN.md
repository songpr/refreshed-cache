# Refreshed Cache - Development Plan & Roadmap

Based on the performance benchmarks and real-world high-concurrency simulation results, this document outlines the future development plan and roadmap for `refreshed-cache`.

---

## 1. Why `refreshed-cache` is Worth Developing Over Raw `lru-cache`

Raw `lru-cache` is a passive, in-memory data store with eviction policies. Using it in high-concurrency production systems introduces key challenges that `refreshed-cache` solves:
- **Zero Cache-Miss Penalty (UX)**: Instead of users waiting for a database fetch on cache misses (which can take 200ms+ under load), background refreshing keeps the hot working set fresh, providing `<0.1ms` read latencies.
- **Cache Stampede Protection**: Rather than concurrent requests hammering the database simultaneously on expiration, `refreshed-cache` manages the refresh lifecycle on a single loop.
- **Data Provider Encapsulation**: It keeps the data-fetching logic (`fetchFn`, `fetchByKey`) close to the cache configuration.

---

## 2. Roadmap & Core Features to Build

We have identified three critical directions for future development to make `refreshed-cache` a production-grade, highly resilient library:

### A. Promise Coalescing / Single-flight (High Priority)
- **Problem**: When a cache miss occurs under high concurrency, multiple queries are fired to the database for the same key before the first fetch resolves.
- **Solution**: Track active fetch requests inside a mapping (`_pendingFetches`). If a fetch for `key` is already in progress, subsequent concurrent reads will resolve to the same pending promise instead of triggering new database queries.

### B. Batch loading on Miss (`getOrFetchMany`)
- **Problem**: Querying multiple entities (e.g., retrieving a list of users) currently triggers separate single-key lookups. If multiple keys miss, it causes $N$ database calls.
- **Solution**: Implement `cache.getOrFetchMany(keys)` to group all missed keys and fetch them using a single batch query (e.g. `WHERE id IN (...)`) rather than individual calls.

### C. Distributed Cache Invalidation Hooks (Pub/Sub & Webhooks)
- **Problem**: When scaling Node.js applications horizontally across multiple app nodes/containers, caches can become out-of-sync when writes happen on different nodes.
- **Solution**: Expose lightweight lifecycle hooks and listener interfaces to trigger `cache.asyncRefresh()` or `cache.delete(key)` remotely (via Pub/Sub or Webhooks) to keep distributed in-process caches synchronized.
- **Modern Node.js 24/26 Integration**:
  - **Zero-Dependency HTTP Invalidation**: Leverage Node's new built-in `fetch()` (powered by **Undici v7/v8**) to broadcast HTTP invalidation requests to peer containers. The native connection pooling and smarter load balancing in Undici 8 will speed up webhook invalidations by up to 30% without requiring external HTTP clients (like `axios`).
  - **Native WebSockets Sync**: Use Node's stable native WebSockets client (WHATWG standard) to connect to a centralized cache-sync server. This eliminates the need for heavy external npm dependencies like `ws`, keeping the cache library extremely lightweight and memory-efficient.
