// Workload generator for the miss-cache (cache-penetration) benchmark.
//
// The original benchmark used 5% bogus traffic against a 5,000-key pool. Over a
// 30s run that produced FEWER bogus requests than pool entries, so almost no key
// was ever requested twice — and miss-cache had nothing to absorb. This module
// centralizes the traffic-mix logic and ships a guard (validateAttackConfig) that
// refuses configs where repeat bogus lookups cannot occur.

/** Build a fixed pool of distinct, non-existent keys (a penetration "attack" set). */
function makeBogusPool(size) {
    return Array.from({ length: size }, (_, i) => `bogus-key-${i}`);
}

/**
 * Pick the next key for a request.
 * @param {() => number} rng - returns a float in [0, 1)
 * @param {{ validKeys: string[], bogusKeys: string[], bogusRatio: number }} opts
 * @returns {{ key: string, bogus: boolean }}
 */
function selectKey(rng, { validKeys, bogusKeys, bogusRatio }) {
    const bogus = rng() < bogusRatio;
    const pool = bogus ? bogusKeys : validKeys;
    const key = pool[Math.floor(rng() * pool.length)];
    return { key, bogus };
}

/**
 * Validate that a miss-cache workload will actually exercise the feature.
 *
 * The feature only matters when the SAME bogus key is requested repeatedly, so the
 * expected number of bogus requests must comfortably exceed the bogus-key pool size.
 * `repeatFactor` is expectedBogusRequests / bogusPool; configs below `minRepeatFactor`
 * are rejected.
 */
function validateAttackConfig({ totalRequests, bogusRatio, bogusPool, minRepeatFactor = 3 }) {
    const expectedBogusRequests = totalRequests * bogusRatio;
    const repeatFactor = expectedBogusRequests / bogusPool;
    const ok = repeatFactor >= minRepeatFactor;
    return {
        ok,
        expectedBogusRequests,
        repeatFactor,
        minRepeatFactor,
        message: ok
            ? `OK: ~${Math.round(expectedBogusRequests)} bogus requests over ${bogusPool} keys (${repeatFactor.toFixed(1)}x repeats).`
            : `Workload too sparse: ~${Math.round(expectedBogusRequests)} bogus requests over ${bogusPool} keys (${repeatFactor.toFixed(2)}x). ` +
              `Raise bogusRatio/totalRequests or shrink bogusPool so repeatFactor >= ${minRepeatFactor}.`,
    };
}

module.exports = { makeBogusPool, selectKey, validateAttackConfig };
