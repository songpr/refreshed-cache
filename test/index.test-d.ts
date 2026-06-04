import { expectType, expectError } from 'tsd';
import DataCache = require('../index');

// Setup mock fetch functions
const fetchFn = async (recentKeys?: string[]): Promise<Array<[string, number]>> => {
  return [['key1', 1]];
};

const syncFetchFn = (recentKeys?: string[]): Array<[string, number]> => {
  return [['key1', 1]];
};

// 1. Test instantiation and type parameters
const cache = new DataCache<string, number>(fetchFn);
expectType<DataCache<string, number>>(cache);

const syncCache = new DataCache<string, number>(syncFetchFn);
expectType<DataCache<string, number>>(syncCache);

// 2. Test CacheOptions types
const options: DataCache.CacheOptions<string, number> = {
  max: 100,
  maxAge: 60,
  refreshAge: 30,
  refreshAt: { days: 1, at: '04:30:00' },
  resetOnRefresh: true,
  passRecentKeysOnRefresh: true,
  fetchByKey: async (key: string) => {
    return key === 'key3' ? 3 : undefined;
  },
  fetchByKeys: async (keys: string[]) => {
    return [['key3', 3]];
  },
  maxMiss: 10,
  maxAgeMiss: 15,
  onRefresh: (stats: { durationMs: number; keysLoaded: number; keysUpdated: number }) => {},
  onError: (err: any) => {},
  checkValidity: (key: string, value: number) => true,
  isEqual: (a: number, b: number) => a === b,
  backoffInitialDelay: 2,
  backoffMaxDelay: 30,
};

const cacheWithOptions = new DataCache<string, number>(fetchFn, options);
expectType<DataCache<string, number>>(cacheWithOptions);

// 3. Test instance properties
expectType<boolean>(cache.passRecentKeysOnRefresh);
expectType<number>(cache.maxAge);
expectType<number>(cache.refreshAge);
expectType<boolean>(cache.resetOnRefresh);
expectType<number>(cache.max);
expectType<number>(cache.size);
expectType<boolean | undefined>(cache.isClose);
expectType<number>(cache.latencySampleRate);

// Test metrics properties
expectType<{
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
  hitVsFetchLatencyRatio: number;
  hitSpeedup: number;
  batchPerKeyMs: number;
  batchEfficiency: number;
}>(cache.metrics);

if (cache.refreshAt) {
  expectType<number>(cache.refreshAt.daysMs);
  expectType<number>(cache.refreshAt.msFrom00_00);
}

if (cache.maxMiss !== undefined) {
  expectType<number>(cache.maxMiss);
}

if (cache.maxAgeMiss !== undefined) {
  expectType<number>(cache.maxAgeMiss);
}


// 4. Test instance methods
expectType<Promise<void>>(cache.init());
expectType<Promise<void>>(cache.asyncRefresh());
expectType<number | undefined>(cache.get('key1'));
expectType<void>(cache.set('key1', 123));
expectType<void>(cache.delete('key1'));
expectType<void>(cache.clear());
expectType<Generator<[string, number], void, unknown>>(cache.entries());
expectType<Promise<number | undefined>>(cache.getOrFetch('key1'));
expectType<Promise<Record<any, number>>>(cache.getOrFetchMany(['key1', 'key2']));
expectType<boolean>(cache.has('key1'));
expectType<Promise<void>>(cache.close());
expectType<{
  timeSavedMs: number;
  hitVsFetchLatencyRatio: number;
  speedupFactor: number;
  activeSize: number;
  hitSizeRatio: number;
  utilization: number;
  recommendation: string;
}>(cache.gain());

// 5. Test type error cases
// Expect error on invalid constructor arguments
expectError(new DataCache<string, number>());
expectError(new DataCache<string, number>('not-a-function'));

// Expect error on invalid options
expectError(new DataCache<string, number>(fetchFn, {
  max: 'should-be-a-number'
}));
expectError(new DataCache<string, number>(fetchFn, {
  unknownOption: true
}));

// Expect error on invalid key/value types in operations
expectError(cache.get(123)); // key should be string
expectError(cache.set('key1', 'should-be-a-number')); // value should be number
expectError(cache.has(123)); // key should be string
expectError(cache.getOrFetch(123)); // key should be string
expectError(cache.getOrFetchMany([123])); // keys should be string[]
