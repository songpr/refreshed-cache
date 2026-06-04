const DataCache = require('../index.js');
const { trackCaches } = require('./helpers');
const newCache = trackCaches();
const {
    makeBogusPool,
    selectKey,
    validateAttackConfig,
} = require('../benchmark/lib/miss-cache-workload');

// Deterministic PRNG (mulberry32) so traffic-mix assertions are not flaky.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('miss-cache workload helpers', () => {
    test('makeBogusPool builds a fixed pool of distinct non-existent keys', () => {
        const pool = makeBogusPool(5);
        expect(pool).toHaveLength(5);
        expect(new Set(pool).size).toBe(5);
        expect(pool.every((k) => k.startsWith('bogus-'))).toBe(true);
    });

    test('selectKey honors the bogus ratio within tolerance', () => {
        const rng = mulberry32(42);
        const validKeys = Array.from({ length: 200 }, (_, i) => `v${i}`);
        const bogusKeys = makeBogusPool(100);
        let bogus = 0;
        const n = 20000;
        for (let i = 0; i < n; i++) {
            const { key, bogus: isBogus } = selectKey(rng, { validKeys, bogusKeys, bogusRatio: 0.5 });
            if (isBogus) {
                bogus++;
                expect(key.startsWith('bogus-')).toBe(true);
            } else {
                expect(key.startsWith('v')).toBe(true);
            }
        }
        expect(bogus / n).toBeGreaterThan(0.45);
        expect(bogus / n).toBeLessThan(0.55);
    });

    // This is the regression guard for the bug found in the original benchmark:
    // 5% bogus traffic against a 5,000-key pool produced FEWER bogus requests than
    // pool entries, so almost nothing repeated and miss-cache had nothing to absorb.
    test('validateAttackConfig rejects configs where bogus traffic cannot repeat', () => {
        const oldBroken = validateAttackConfig({
            totalRequests: 58500,
            bogusRatio: 0.05,
            bogusPool: 5000,
        });
        expect(oldBroken.ok).toBe(false);
        expect(oldBroken.repeatFactor).toBeLessThan(1);

        const attack = validateAttackConfig({
            totalRequests: 58500,
            bogusRatio: 0.5,
            bogusPool: 1000,
        });
        expect(attack.ok).toBe(true);
        expect(attack.repeatFactor).toBeGreaterThanOrEqual(3);
    });
});

describe('miss-cache effect against the real DataCache', () => {
    const TOTAL_REQUESTS = 6000;
    const BOGUS_POOL = 100;
    const BOGUS_RATIO = 0.5;
    const validKeys = Array.from({ length: 200 }, (_, i) => `v${i}`);
    const validData = new Map(validKeys.map((k) => [k, { uuid: k, name: k }]));
    const bogusKeys = makeBogusPool(BOGUS_POOL);

    async function run(maxMiss) {
        let bogusDbCalls = 0;
        const cache = newCache(async () => [], {
            max: 100000,
            maxAge: 300,
            refreshAge: 300,
            resetOnRefresh: false,
            maxMiss,
            maxAgeMiss: 60,
            fetchByKey: async (key) => {
                if (key.startsWith('bogus-')) bogusDbCalls++;
                return validData.get(key); // undefined for bogus keys
            },
        });
        await cache.init();

        // Pre-warm the valid set so valid lookups are pure cache hits during measurement,
        // isolating the miss-cache signal from ordinary cache warmup.
        for (const k of validKeys) await cache.getOrFetch(k);

        const rng = mulberry32(7);
        let bogusRequests = 0;
        for (let i = 0; i < TOTAL_REQUESTS; i++) {
            const { key, bogus } = selectKey(rng, { validKeys, bogusKeys, bogusRatio: BOGUS_RATIO });
            if (bogus) bogusRequests++;
            await cache.getOrFetch(key);
        }
        await cache.close();
        return { bogusDbCalls, bogusRequests };
    }

    test('maxMiss:0 sends every bogus lookup to the DB', async () => {
        const r = await run(0);
        expect(r.bogusRequests).toBeGreaterThan(2000);
        expect(r.bogusDbCalls).toBe(r.bogusRequests);
    });

    test('miss-cache absorbs repeat bogus lookups (DB calls bounded by pool size)', async () => {
        const r = await run(500);
        expect(r.bogusDbCalls).toBeLessThanOrEqual(BOGUS_POOL);
        expect(r.bogusDbCalls).toBeLessThan(r.bogusRequests / 10);
    });
});
