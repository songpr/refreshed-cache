import DataCache = require('../index');

// Helper to check types
function assertType<T>(val: T): void {}

async function runTypeCheck() {
  // Test constructor and type parameters (string, number)
  const fetchFn = async (recentKeys?: string[]): Promise<Array<[string, number]>> => {
    if (recentKeys) {
      assertType<string[]>(recentKeys);
    }
    return [['key1', 1], ['key2', 2]];
  };

  const options: DataCache.CacheOptions<string, number> = {
    max: 100,
    maxAge: 60,
    refreshAge: 30,
    refreshAt: { days: 1, at: '04:30:00' },
    resetOnRefresh: true,
    passRecentKeysOnRefresh: true,
    fetchByKey: async (key: string) => {
      assertType<string>(key);
      return key === 'key3' ? 3 : undefined;
    },
    fetchByKeys: async (keys: string[]) => {
      assertType<string[]>(keys);
      const result: Array<[string, number]> = [['key3', 3]];
      return result;
    },
    maxMiss: 10,
    maxAgeMiss: 15,
    onRefresh: (stats) => {
      assertType<number>(stats.durationMs);
      assertType<number>(stats.keysLoaded);
      assertType<number>(stats.keysUpdated);
    },
    onError: (err) => {
      assertType<any>(err);
    },
    checkValidity: (key, value) => {
      assertType<string>(key);
      assertType<number>(value);
      return true;
    },
    isEqual: (a, b) => {
      assertType<number>(a);
      assertType<number>(b);
      return a === b;
    },
    backoffInitialDelay: 2,
    backoffMaxDelay: 30,
    latencySampleRate: 0.05,
  };

  const cache = new DataCache<string, number>(fetchFn, options);

  // Verify properties
  assertType<boolean>(cache.passRecentKeysOnRefresh);
  assertType<number>(cache.maxAge);
  assertType<number>(cache.refreshAge);
  assertType<boolean>(cache.resetOnRefresh);
  assertType<number>(cache.max);
  assertType<number>(cache.size);
  assertType<boolean | undefined>(cache.isClose);
  assertType<number>(cache.latencySampleRate);

  // Verify metrics
  assertType<number>(cache.metrics.hits);
  assertType<number>(cache.metrics.misses);
  assertType<number>(cache.metrics.refreshes);
  assertType<number>(cache.metrics.coalescedFetches);
  assertType<number>(cache.metrics.mismatches);
  assertType<number>(cache.metrics.invalidations);
  assertType<number>(cache.metrics.hitLatency.avgMs);
  assertType<number>(cache.metrics.missFetchLatency.minMs);
  assertType<number>(cache.metrics.missFetchLatency.avgMs);
  assertType<number>(cache.metrics.missFetchLatency.maxMs);
  assertType<number>(cache.metrics.batchFetchLatency.minMs);
  assertType<number>(cache.metrics.batchFetchLatency.avgMs);
  assertType<number>(cache.metrics.batchFetchLatency.maxMs);
  assertType<number>(cache.metrics.refreshLatency.minMs);
  assertType<number>(cache.metrics.refreshLatency.avgMs);
  assertType<number>(cache.metrics.refreshLatency.maxMs);
  assertType<number>(cache.metrics.timeSavedMs);
  assertType<number>(cache.metrics.hitSpeedup);
  assertType<number>(cache.metrics.batchPerKeyMs);
  assertType<number>(cache.metrics.batchEfficiency);

  if (cache.refreshAt) {
    assertType<number>(cache.refreshAt.daysMs);
    assertType<number>(cache.refreshAt.msFrom00_00);
  }

  if (cache.maxMiss !== undefined) {
    assertType<number>(cache.maxMiss);
  }

  if (cache.maxAgeMiss !== undefined) {
    assertType<number>(cache.maxAgeMiss);
  }

  // Verify methods
  await cache.init();
  
  const val1: number | undefined = cache.get('key1');
  cache.set('key3', 3);
  const hasKey: boolean = cache.has('key1');
  
  // entries generator
  const entriesGen = cache.entries();
  for (const [k, v] of entriesGen) {
    assertType<string>(k);
    assertType<number>(v);
  }

  const optVal: number | undefined = await cache.getOrFetch('key3');
  
  const manyVals: Record<any, number> = await cache.getOrFetchMany(['key1', 'key2']);

  cache.delete('key1');
  cache.clear();

  const gainReport = cache.gain();
  assertType<number>(gainReport.timeSavedMs);
  assertType<number>(gainReport.speedupFactor);
  assertType<number>(gainReport.activeSize);
  assertType<number>(gainReport.hitSizeRatio);
  assertType<number>(gainReport.utilization);
  assertType<string>(gainReport.recommendation);

  await cache.asyncRefresh();
  await cache.close();
}
