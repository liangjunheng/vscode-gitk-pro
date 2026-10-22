// Before/after real-N-API benchmarks. Setup, git add/reset and cleanup are not timed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { loadBinding, fixture, git, write, invoke } = require('./test-stash-parity.cjs');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const samples = Number(option('--samples') || 3);
const changed = Number(option('--files') || 100);
const total = Math.max(changed, Number(option('--tracked') || 500));
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 30);
assert.ok(Number.isSafeInteger(changed) && changed > 1 && changed <= 10000);
assert.ok(Number.isSafeInteger(total) && total <= 100000);
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(n => +n.toFixed(3)), medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3), minMs: +sorted[0].toFixed(3), maxMs: +sorted.at(-1).toFixed(3) };
};
async function worker() {
  const binding = loadBinding();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-stash-perf-'));
  fixture(root);
  for (let i = 0; i < total; i++) write(root, `f${i}`, 'base\n');
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'benchmark files']);
  const config = {};
  for (const key of ['core.autocrlf', 'filter.lfs.clean', 'filter.lfs.process']) config[key] = await invoke(binding, root, 'configGet', { key });
  const rows = [];
  const measure = async (name, prepare, operation, validate, finish = async () => {}) => {
    const times = [];
    for (let i = 0; i < samples; i++) {
      git(root, ['reset', '--hard', '-q']); git(root, ['clean', '-fdq']);
      const context = await prepare(i);
      const start = performance.now(); const result = await operation(context); times.push(performance.now() - start);
      await validate(context, result); await finish(context, result);
    }
    rows.push({ name, ...stats(times) });
  };
  for (const scope of ['unstaged', 'staged']) await measure(`create_${scope}`, async iteration => {
    for (let i = 0; i < changed; i++) write(root, `f${i}`, (`change-${iteration}-${i}\n`).repeat(80));
    const staged = Array.from({ length: Math.floor(changed / 2) }, (_, i) => `f${i}`);
    git(root, ['add', '--', ...staged]);
    for (let i = 0; i < Math.floor(changed / 5); i++) write(root, `new${i}`, `new-${i}\n`);
    return { index: git(root, ['write-tree']).stdout };
  }, () => invoke(binding, root, 'stashCreate', { scope }), async (context, result) => {
    assert.match(result.stash, /^[0-9a-f]{40}$/);
    if (scope === 'unstaged') assert.equal(git(root, ['write-tree']).stdout, context.index);
    else assert.equal(git(root, ['write-tree']).stdout, git(root, ['rev-parse', 'HEAD^{tree}']).stdout);
  }, async (_context, result) => { await invoke(binding, root, 'stashDrop', { stash: result.stash }); });
  for (const action of ['stashApply', 'stashPop']) await measure(action, async () => {
    write(root, 'a', 'saved\n'); const stash = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
    for (let i = 0; i < changed; i++) { write(root, `f${i}`, `unrelated edit ${i}\n`); write(root, `untracked/${i}`, `new ${i}\n`); }
    return stash;
  }, stash => invoke(binding, root, action, { stash: stash.stash }), async (_context, result) => {
    assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'saved\n');
    assert.equal(fs.readFileSync(path.join(root, `f${changed - 1}`), 'utf8'), `unrelated edit ${changed - 1}\n`);
    assert.equal(result.dropped, action === 'stashPop');
  }, async (stash, result) => { if (!result.dropped) await invoke(binding, root, 'stashDrop', { stash: stash.stash }); });
  const seedList = () => {
    const base = git(root, ['rev-parse', 'HEAD']).stdout, tree = git(root, ['rev-parse', 'HEAD^{tree}']).stdout;
    const ids = [];
    for (let i = 0; i < 160; i++) {
      const raw = Buffer.from(`tree ${tree}\nparent ${base}\nparent ${base}\nauthor Bench <bench@example.com> 1700000000 +0000\ncommitter Bench <bench@example.com> 1700000000 +0000\n\nWIP on main: ${i}\n`);
      const object = Buffer.concat([Buffer.from(`commit ${raw.length}\0`), raw]);
      const id = crypto.createHash('sha1').update(object).digest('hex'); ids.push(id);
      const file = path.join(root, '.git/objects', id.slice(0, 2), id.slice(2));
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.deflateSync(object));
    }
    write(root, '.git/refs/stash', ids.at(-1) + '\n');
    write(root, '.git/logs/refs/stash', ids.map((id, i) => `${i ? ids[i - 1] : '0'.repeat(40)} ${id} Bench <bench@example.com> 1700000000 +0000\tWIP on main: ${i}\n`).join(''));
    return ids;
  };
  await measure('list_160', async () => seedList(), () => invoke(binding, root, 'stashList'), async (_context, result) => assert.equal(result.length, 160));
  await measure('drop_middle_160', async () => seedList(), ids => invoke(binding, root, 'stashDrop', { stash: ids[40] }), async ids => {
    const entries = await invoke(binding, root, 'stashList'); assert.equal(entries.length, 159); assert.ok(!entries.some(entry => entry.hash === ids[40]));
  });
  git(root, ['stash', 'clear']);
  await measure('files_modifications', async () => {
    for (let i = 0; i < changed; i++) write(root, `f${i}`, `edit ${i}\n`);
    git(root, ['add', '-A']); return invoke(binding, root, 'stashCreate', { scope: 'staged' });
  }, stash => invoke(binding, root, 'stashFiles', { revision: stash.stash }), async (_context, result) => assert.equal(result.length, changed), async stash => { await invoke(binding, root, 'stashDrop', { stash: stash.stash }); });
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  return { platform: `${process.platform}/${process.arch}`, libgit2: binding.libgit2Version(), samples, changed, tracked: total, nativeConfig: config, rows };
}
if (process.argv.includes('--worker')) {
  worker().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const run = file => {
    const env = { ...process.env };
    if (file) env.STASH_NATIVE_BINDING = path.resolve(file); else delete env.STASH_NATIVE_BINDING;
    const result = spawnSync(process.execPath, [__filename, '--worker', '--samples', String(samples), '--files', String(changed), '--tracked', String(total)], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout.trim());
  };
  const baseline = option('--baseline') ? run(option('--baseline')) : undefined;
  const current = run(option('--binding'));
  if (baseline) assert.deepEqual(current.nativeConfig, baseline.nativeConfig, 'both modules must use equivalent effective native configuration');
  const comparison = current.rows.map(row => {
    const old = baseline?.rows.find(other => other.name === row.name);
    return { operation: row.name, beforeMs: old?.medianMs, afterMs: row.medianMs, speedup: old ? +(old.medianMs / row.medianMs).toFixed(2) : undefined };
  });
  const output = { baseline, current, comparison };
  if (option('--json')) fs.writeFileSync(path.resolve(option('--json')), JSON.stringify(output, null, 2) + '\n');
  console.table(comparison);
  console.log('Benchmark uses separate processes per module, identical workload sizes, excludes setup and records effective native filter configuration.');
}
