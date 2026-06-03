# Refreshed Cache - Agents Integration & Operations Guide

This guide is designed for both **AI Coding Agents** (like Claude Code, Antigravity, Gemini) and **System Integration Agents** to understand, configure, and maintain the `refreshed-cache` library.

`refreshed-cache` is a Node.js/TypeScript micro-caching library built on top of `lru-cache`. Its core design philosophy is to encapsulate data loading, caching, evictions, and refresh rules in one single place.

---

## 1. System Architecture

The cache operates on a dual-refresh pattern: **Internal Timer Pull (Self-Refreshing)** and **External Trigger Push (Collaborative/Manual Refreshing)**.

```mermaid
graph TD
    A[Client Request] -->|get / getOrFetch| B(DataCache)
    B -->|Cache Hit| C[Return Cached Value]
    B -->|Cache Miss + fetchByKey| D[fetchByKey]
    D -->|Store & Return| B
    
    %% Self-Refreshing Loops
    subgraph Self-Refreshing (Pull Pattern)
        E[Interval Timer: refreshAge] -->|asyncRefresh| B
        F[Specific Schedule: refreshAt] -->|asyncRefresh| B
    end

    %% External Triggers
    subgraph External Triggers (Push/Event Pattern)
        G[Manual Call: asyncRefresh] -->|Trigger Refresh| B
        H[Pub/Sub Event / Webhook] -->|Trigger Refresh| B
    end
```

---

## 2. Refresh Mechanisms

`refreshed-cache` supports two modes of refreshing:

### A. Self-Refreshing (Automatic / Pull)
The cache maintains its own internal timer loops to keep data fresh without client intervention:
1. **Interval-Based (`refreshAge`)**: Periodically runs `asyncRefresh()` using a standard `setTimeout` loop.
2. **Schedule-Based (`refreshAt`)**: Schedule updates every $X$ days at a specific time of day (e.g. `{days: 1, at: "04:30:00"}`).

### B. Triggered by Others (Manual / Push / Collaborative)
You can force cache updates externally based on system events, background jobs, or user actions:
1. **Direct API Triggers**: Other modules or subscriber agents can call `await cache.asyncRefresh()` upon receiving a database write, message queue event, or cache invalidation webhook.
2. **On-Demand Cache Miss Fetching**: If a client requests a missing key via `cache.getOrFetch(key)`, it invokes the user-provided `fetchByKey(key)` function to lazily populate the cache.
3. **Penetration Protection**: If `fetchByKey` returns `undefined`, the cache tracks this key in an internal `_missCache` for up to `maxAgeMiss` seconds to prevent consecutive calls to the database/API.

---

## 3. Options & Configuration Reference

When instantiating `DataCache`, configure the following properties to optimize refresh and eviction behavior:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `max` | `number` | `10000` | The maximum size of the cache. If `0`, no data is cached. |
| `maxAge` | `number` | `600` | Maximum age of cache entries in seconds (TTL). |
| `refreshAge` | `number` | `maxAge` | Interval in seconds to automatically invoke the `fetch` function. |
| `refreshAt` | `object` | `undefined` | Specific recurring refresh schedule, e.g., `{ days: 2, at: "10:00:00" }`. |
| `resetOnRefresh` | `boolean` | `true` | If `true`, clears all old entries on refresh so only newly fetched items remain. |
| `passRecentKeysOnRefresh` | `boolean` | `false` | If `true`, passes currently cached keys to the `fetch` function on refresh. |
| `fetchByKey` | `Function` | `undefined` | Async/sync function to resolve a single missing key on `getOrFetch`. |
| `maxMiss` | `number` | `2000` | Maximum size of the cache tracking missed keys. |
| `maxAgeMiss` | `number` | `refreshAge` | Expiration (TTL) in seconds for missed key tracking. |

---

## 4. Code Examples

### Standard Self-Refreshing Cache (JavaScript)
```javascript
const Cache = require("refreshed-cache");

// Set up a cache that fetches all data and self-refreshes every 10 minutes
const cache = new Cache(
  async () => {
    const data = await fetchFromDB();
    return Object.entries(data); // returns iterable [key, value] pairs
  },
  {
    max: 500,
    maxAge: 1200,      // TTL: 20 minutes
    refreshAge: 600    // Refresh: every 10 minutes
  }
);

await cache.init();
```

### TypeScript Wrap & Usage (TypeScript)
Since the library is written in vanilla JS, you can declare the interface types below for typescript safety:

```typescript
export interface CacheOptions<K, V> {
  max?: number;
  maxAge?: number;
  refreshAge?: number;
  refreshAt?: { days: number; at: string };
  resetOnRefresh?: boolean;
  passRecentKeysOnRefresh?: boolean;
  fetchByKey?: (key: K) => V | Promise<V | undefined> | undefined;
  maxMiss?: number;
  maxAgeMiss?: number;
}

export class DataCache<K, V> {
  constructor(
    fetchFn: (recentKeys?: K[]) => Array<[K, V]> | Iterable<[K, V]> | AsyncIterable<[K, V]> | Promise<Iterable<[K, V]>>,
    options?: CacheOptions<K, V>
  );

  init(): Promise<void>;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
  entries(): Generator<[K, V], void, unknown>;
  asyncRefresh(): Promise<void>;
  getOrFetch(key: K): Promise<V | undefined>;
  has(key: K): boolean;
  close(): Promise<void>;
  
  readonly size: number;
}
```

---

## 5. Maintenance and Contribution Guide for AI Coding Agents

When working on the `refreshed-cache` codebase, AI Agents must strictly adhere to the following rules:

### A. Testing Instructions
Before submitting any modifications, run the unit test suite:
```bash
# Verify all existing tests pass
npm test
```
All tests use **Jest**. If you introduce new features or change caching behavior, write corresponding test files under the `test/` directory.

### B. Coding Conventions
1. **Vanilla CommonJS**: The package uses standard Node.js CommonJS exports (`module.exports`). Do not use ESM (`export default`) in the library source code.
2. **Resource Cleanup**: Always ensure that timer loops (`_timeoutLoop`, `_refreshAtLoop`) inspect `this.isClose` and terminate when `cache.close()` is called. This prevents open handles in application threads.
3. **No Unhandled Promises**: Ensure `asyncRefresh()` calls inside timeout loops catch errors gracefully, outputting them to `console.error` to avoid crashing the parent process.
4. **Preserve Performance Limits**: Do not exceed configured boundaries (`max` and `maxMiss`) during bulk loading and single-key fetching operations.
