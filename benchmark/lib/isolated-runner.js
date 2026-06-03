// Process-isolation orchestration for the benchmark suite.
//
// Problem this solves: previously every round and every strategy ran inside ONE
// long-lived Node process sharing a single Postgres pool and one V8 heap. That made
// throughput decay round-over-round (JIT deopt + GC pressure) and produced unstable,
// even negative, memory deltas — all measurement artifacts, not library behavior.
//
// Fix: the parent process forks a FRESH child (with --expose-gc) for every
// (round, strategy) pair. Each child opens its own pool, runs exactly one strategy,
// reports its result over the IPC channel, and exits — fully isolating heap and pool
// state. The parent only aggregates and renders the final table; it issues no queries.

const { fork } = require('child_process');

/** Read a `--name=value` CLI arg, or return the default. */
function getArg(name, def) {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : def;
}

// A script is running as an isolated child when it was forked WITH a --strategy
// target (and therefore has an IPC channel). Normal user invocation has neither.
const isChild = typeof process.send === 'function' && getArg('strategy') !== undefined;

/** Child → parent: hand back this strategy's result object. No-op if not forked. */
function emitResult(payload) {
    if (process.send) process.send({ __benchResult: true, payload });
}

/** Fork one fresh process for a single (strategy, round) and resolve its result. */
function forkOne(scriptPath, args) {
    return new Promise((resolve, reject) => {
        const child = fork(scriptPath, args, {
            execArgv: ['--expose-gc'],
            // Inherit stdio so the child's live progress logs still stream to the
            // console; the 4th 'ipc' slot carries the structured result back.
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
        let result = null;
        child.on('message', (m) => {
            if (m && m.__benchResult) result = m.payload;
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0 && result) resolve(result);
            else reject(new Error(`Isolated child [${args.join(' ')}] exited code=${code}, result=${result ? 'received' : 'MISSING'}`));
        });
    });
}

/**
 * Parent entry point. Forks one isolated child per (round, strategyKey), in order,
 * and returns the collected result objects.
 *
 * @param {Object} opts
 * @param {string} opts.scriptPath  Usually __filename of the calling script.
 * @param {string[]} opts.strategyKeys  Keys the child knows how to run.
 * @param {number} opts.rounds
 * @param {string[]} [opts.passArgs]  Extra args to forward (e.g. --duration=30).
 */
async function orchestrate({ scriptPath, strategyKeys, rounds, passArgs = [] }) {
    // Never forward --strategy/--round from the parent invocation; we set them per child.
    const forwarded = passArgs.filter((a) => !a.startsWith('--strategy=') && !a.startsWith('--round='));
    const results = [];
    for (let r = 1; r <= rounds; r++) {
        console.log(`\n\n=== ROUND ${r} OF ${rounds} (isolated processes) ===`);
        for (const key of strategyKeys) {
            const res = await forkOne(scriptPath, [`--strategy=${key}`, `--round=${r}`, ...forwarded]);
            results.push(res);
        }
    }
    return results;
}

module.exports = { getArg, isChild, emitResult, orchestrate };
