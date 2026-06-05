declare class DataCache<K, V> {
  constructor(
    fetch: (recentKeys?: K[]) => Array<[K, V]> | Iterable<[K, V]> | AsyncIterable<[K, V]> | Promise<Array<[K, V]> | Iterable<[K, V]> | AsyncIterable<[K, V]>>,
    options?: DataCache.CacheOptions<K, V>
  );

  passRecentKeysOnRefresh: boolean;
  maxAge: number;
  refreshAge: number;
  resetOnRefresh: boolean;
  max: number;
  latencySampleRate: number;
  refreshAt?: { readonly daysMs: number; readonly msFrom00_00: number };
  maxMiss?: number;
  maxAgeMiss?: number;
  readonly size: number;
  readonly isClose?: boolean;
  readonly metrics: {
    hits: number;
    misses: number;
    refreshes: number;
    coalescedFetches: number;
    mismatches: number;
    invalidations: number;
    hitLatency: {
      avgMs: number;
    };
    missFetchLatency: {
      minMs: number;
      avgMs: number;
      maxMs: number;
    };
    batchFetchLatency: {
      minMs: number;
      avgMs: number;
      maxMs: number;
    };
    refreshLatency: {
      minMs: number;
      avgMs: number;
      maxMs: number;
    };
    timeSavedMs: number;
    /** Per-operation latency ratio (avg miss-fetch / avg hit). Diagnostic, NOT a throughput speedup. */
    hitVsFetchLatencyRatio: number;
    /** @deprecated Back-compat alias for hitVsFetchLatencyRatio. */
    hitSpeedup: number;
    avgBatchSize: number;
    batchPerKeyMs: number;
    batchEfficiency: number;
    /** Requests short-circuited by the miss-cache (bogus keys absorbed without a fetch). */
    missCacheHits: number;
  };

  init(): Promise<void>;
  asyncRefresh(): Promise<void>;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
  entries(): Generator<[K, V], void, unknown>;
  getOrFetch(key: K): Promise<V | undefined>;
  getOrFetchMany(keys: K[]): Promise<Record<any, V>>;
  has(key: K): boolean;
  close(): Promise<void>;
  gain(): {
    timeSavedMs: number;
    /** Per-operation latency ratio (avg miss-fetch / avg hit). Diagnostic, NOT a throughput speedup. */
    hitVsFetchLatencyRatio: number;
    /** @deprecated Back-compat alias for hitVsFetchLatencyRatio. */
    speedupFactor: number;
    activeSize: number;
    hitSizeRatio: number;
    utilization: number;
    /** Stable diagnosis code for the current workload. */
    code: 'disabled' | 'healthy' | 'thrash' | 'refresh-waste' | 'miss-protected' | 'batch-efficient' | 'low-value' | 'over-provisioned';
    recommendation: string;
  };
}

declare namespace DataCache {
  export interface CacheOptions<K, V> {
    max?: number;
    maxAge?: number;
    refreshAge?: number;
    refreshAt?: { days: number; at: string };
    resetOnRefresh?: boolean;
    passRecentKeysOnRefresh?: boolean;
    fetchByKey?: (key: K) => V | Promise<V | undefined> | undefined;
    fetchByKeys?: (keys: K[]) => Array<[K, V]> | Iterable<[K, V]> | AsyncIterable<[K, V]> | Promise<Array<[K, V]> | Iterable<[K, V]> | AsyncIterable<[K, V]>>;
    maxMiss?: number;
    maxAgeMiss?: number;
    onRefresh?: (stats: { durationMs: number; keysLoaded: number; keysUpdated: number }) => void;
    onError?: (err: any) => void;
    checkValidity?: (key: K, value: V) => boolean;
    isEqual?: (a: V, b: V) => boolean;
    backoffInitialDelay?: number;
    backoffMaxDelay?: number;
    latencySampleRate?: number;
  }
}

export = DataCache;
