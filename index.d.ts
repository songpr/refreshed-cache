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
  refreshAt?: { readonly daysMs: number; readonly msFrom00_00: number };
  maxMiss?: number;
  maxAgeMiss?: number;
  readonly size: number;
  readonly isClose?: boolean;

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
  }
}

export = DataCache;
