const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { invokeNativeGit, invokeNativeGitPriorityRead } = require('../out/git/nativeGitBinding');

function values(name) {
  const result = [];
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) result.push(process.argv[++index]);
  }
  return result;
}

function value(name, fallback) {
  return values(name)[0] ?? fallback;
}

const target = value('--target');
const oldHash = value('--old');
const newHash = value('--new');
const rounds = Number(value('--rounds', '20'));
const delayMs = Number(value('--delay-ms', '10'));
const statusRoots = values('--status-root');

if (!target || !oldHash || !newHash || !Number.isInteger(rounds) || rounds < 1 || !Number.isFinite(delayMs) || delayMs < 0) {
  console.error('Usage: node scripts/benchmark-gitlink-metadata.cjs --target <submodule> --old <sha> --new <sha> [--status-root <repo>]... [--rounds 20] [--delay-ms 10]');
  process.exit(2);
}
for (const directory of [target, ...statusRoots]) {
  if (!fs.existsSync(directory)) throw new Error(`Repository path does not exist: ${directory}`);
}

const normal = (operation, payload) => invokeNativeGit(operation, payload);
const priority = (operation, payload) => invokeNativeGitPriorityRead(operation, payload);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function measure(label, read) {
  const started = performance.now();
  const statuses = Promise.all(statusRoots.map(rootPath => normal('status', { rootPath })));
  if (delayMs > 0) await sleep(delayMs);

  let phase = performance.now();
  const details = await read('commitDetails', { rootPath: target, hashes: [oldHash, newHash] });
  const commitDetailsMs = performance.now() - phase;

  phase = performance.now();
  const range = await read('rangeCommits', { rootPath: target, from: oldHash, to: newHash });
  const rangeCommitsMs = performance.now() - phase;
  const metadataMs = commitDetailsMs + rangeCommitsMs;

  await statuses;
  return {
    label,
    commitDetailsMs,
    rangeCommitsMs,
    metadataMs,
    statusTotalMs: performance.now() - started,
    detailCount: details.length,
    rangeCommitCount: range.length,
  };
}

function percentile(rows, field, ratio) {
  const sorted = rows.map(row => row[field]).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summary(label, rows) {
  const result = { label, rounds: rows.length };
  for (const field of ['commitDetailsMs', 'rangeCommitsMs', 'metadataMs', 'statusTotalMs']) {
    result[field] = {
      median: +percentile(rows, field, 0.5).toFixed(2),
      p95: +percentile(rows, field, 0.95).toFixed(2),
      max: +Math.max(...rows.map(row => row[field])).toFixed(2),
    };
  }
  result.rangeCommitCount = rows[0]?.rangeCommitCount ?? 0;
  return result;
}

(async () => {
  const results = { normal: [], priority: [] };
  for (let round = 0; round < rounds; round++) {
    for (const [label, read] of [['normal', normal], ['priority', priority]]) {
      const row = await measure(label, read);
      results[label].push(row);
      console.log(JSON.stringify({ round: round + 1, ...row }, (_key, item) =>
        typeof item === 'number' ? +item.toFixed(2) : item));
    }
  }
  console.log(JSON.stringify({
    target,
    statusRepositoryCount: statusRoots.length,
    summaries: [summary('normal', results.normal), summary('priority', results.priority)],
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
