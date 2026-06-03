import DataCache from '../index.js';

async function run() {
  const cache = new DataCache(async () => [['a', 1]], { max: 10 });
  await cache.init();
  const val = cache.get('a');
  if (val !== 1) {
    throw new Error(`Expected 1, got ${val}`);
  }
  console.log('ESM Node.js runtime usage test passed!');
  await cache.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
