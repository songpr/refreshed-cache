import DataCache from '../index';

// Helper to check types
function assertType<T>(val: T): void {}

async function runTypeCheck() {
  const fetchFn = async (recentKeys?: string[]): Promise<Array<[string, number]>> => {
    return [['key1', 1]];
  };

  const cache = new DataCache<string, number>(fetchFn, {
    max: 100,
  });

  assertType<number>(cache.max);
}
