const assert = require('node:assert/strict');
const os = require('node:os');
const { AsyncConcurrencyLimiter, STATUS_READ_CONCURRENCY } = require('../out/git/statusConcurrency');

async function main() {
  assert.equal(STATUS_READ_CONCURRENCY, Math.max(1, os.availableParallelism?.() ?? os.cpus().length));
  const limiter = new AsyncConcurrencyLimiter(2);
  let running = 0, maximum = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => limiter.run(async () => {
    running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => releases.push(resolve));
    running--;
    return index;
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, 2, 'only the configured number of operations start');
  assert.equal(maximum, 2);
  let released = 0;
  while (released < 5) {
    if (releases.length === 0) { await new Promise(resolve => setImmediate(resolve)); continue; }
    releases.shift()(); released++;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maximum, 2, 'queued operations never exceed the concurrency limit');
  assert.throws(() => new AsyncConcurrencyLimiter(0), /正整数/);
  console.log(`Status concurrency passed: CPU default=${STATUS_READ_CONCURRENCY}, bounded queue preserves all results.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
