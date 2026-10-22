// Stash 的原生绑定冒烟测试: 经真实 N-API 模块调用 stashCreate / stashList / stashFiles / stashApply / stashPop / stashDrop。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadNativeGitBinding } = require('../out/git/nativeGitBinding');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-stash-binding-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const binding = loadNativeGitBinding();
const invoke = async (operation, payload = {}) => JSON.parse(await binding.invoke(operation, JSON.stringify({ rootPath: root, ...payload })));
(async () => {
  git('init', '-q'); git('config', 'user.name', 'Gitk Test'); git('config', 'user.email', 'gitk@example.com'); git('config', 'core.autocrlf', 'false');
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, n), 'base\n');
  git('add', '-A'); git('commit', '-m', 'init');
  const setup = (overlap = true) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'A-staged\n'); fs.writeFileSync(path.join(root, 'c.txt'), 'C-staged\n');
    git('add', 'a.txt', 'c.txt');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B-unstaged\n');
    if (overlap) fs.writeFileSync(path.join(root, 'c.txt'), 'C-staged\nC-unstaged\n');
    fs.writeFileSync(path.join(root, 'u.txt'), 'untracked\n');
  };
  const setupUnstaged = () => {
    fs.writeFileSync(path.join(root, 'b.txt'), 'B-unstaged\n');
    fs.writeFileSync(path.join(root, 'u.txt'), 'untracked\n');
  };
  setup(false);
  // staged scope through the real binding; the no-overlap case uses the pure libgit2 staged implementation.
  const r1 = await invoke('stashCreate', { scope: 'staged' });
  assert.match(r1.stash, /^[0-9a-f]{40}$/); assert.deepEqual(r1.skippedGitlinks, []);
  assert.equal(git('status', '--porcelain=v1'), 'M b.txt\n?? u.txt', 'only the unstaged-only file and the untracked file remain (trim() drops the leading space of " M")');
  // list + files
  const list = await invoke('stashList');
  assert.equal(list.length, 1); assert.equal(list[0].hash, r1.stash); assert.equal(list[0].stashRef, 'stash@{0}'); assert.equal(list[0].stashIndex, 0);
  assert.equal(list[0].hash, git('rev-parse', 'stash@{0}'));
  const files = await invoke('stashFiles', { revision: r1.stash });
  assert.deepEqual(files.map(f => f.path).sort(), ['a.txt', 'c.txt']);
  // The pure libgit2 staged implementation creates the stash commit but returns failure when the same path also has an unstaged edit.
  git('stash', 'drop'); git('checkout', '--', '.'); git('clean', '-fdq'); git('reset', '-q', '--hard');
  setup(true);
  await assert.rejects(() => invoke('stashCreate', { scope: 'staged' }), /移除已暂存修改失败/);
  assert.equal((await invoke('stashList')).length, 1, 'the failed CLI operation still created refs/stash');
  // unstaged scope on a fresh state
  git('stash', 'drop'); git('checkout', '--', '.'); git('clean', '-fdq'); git('reset', '-q', '--hard');
  setup();
  const r2 = await invoke('stashCreate', { scope: 'unstaged' });
  assert.equal(git('status', '--porcelain=v1'), 'M  a.txt\nM  c.txt', 'staged group stays staged');
  const f2 = await invoke('stashFiles', { revision: r2.stash });
  assert.deepEqual(f2.map(f => f.path).sort(), ['a.txt', 'b.txt', 'c.txt', 'u.txt'], 'keep-index stash also records the index and the untracked file');
  // apply / pop / drop through the real binding using a clean-index unstaged stash.
  git('stash', 'drop'); await invoke('restoreAll'); git('clean', '-fdq');
  setupUnstaged();
  const r3 = await invoke('stashCreate', { scope: 'unstaged' });
  assert.equal(git('status', '--porcelain=v1'), '', 'the unstaged stash left a clean tree');
  const applied = await invoke('stashApply', { stash: r3.stash });
  assert.deepEqual(applied, { stash: r3.stash, conflicts: false, dropped: false });
  assert.equal((await invoke('stashList')).length, 1, 'apply keeps the entry');
  assert.match(git('status', '--porcelain=v1'), /b\.txt/, 'the stashed edits are back in the worktree');
  // a second apply is rejected by the libgit2 safety preflight
  await assert.rejects(() => invoke('stashApply', { stash: r3.stash }), /已存在或有本地修改|暂存区/);
  await invoke('restoreAll'); git('clean', '-fdq');
  const popped = await invoke('stashPop', { stash: r3.stash });
  assert.deepEqual(popped, { stash: r3.stash, conflicts: false, dropped: true });
  assert.deepEqual(await invoke('stashList'), [], 'pop removes the entry');
  await invoke('restoreAll'); git('clean', '-fdq');
  setupUnstaged();
  const r4 = await invoke('stashCreate', { scope: 'unstaged' });
  assert.deepEqual(await invoke('stashDrop', { stash: r4.stash }), { stash: r4.stash });
  assert.deepEqual(await invoke('stashList'), [], 'drop removes the entry without touching the worktree');
  await assert.rejects(() => invoke('stashDrop', { stash: r4.stash }), /已不存在/);
  await assert.rejects(() => invoke('stashApply', { stash: 'stash@{0}' }), /无效的 stash 标识/);
  // errors come back as rejected promises, not crashes
  await assert.rejects(() => invoke('stashCreate', { scope: 'nope' }), /不支持的 stash 范围/);
  // clean repositories surface the native no-op diagnostic.
  await invoke('restoreAll');
  git('clean', '-fdq');
  await assert.rejects(() => invoke('stashCreate', { scope: 'unstaged' }), /没有可 stash/);
  assert.deepEqual(await invoke('stashList'), [], 'dropping the stash empties the list');
  console.log('Stash binding passed: stashCreate(staged/unstaged), stashList, stashFiles, stashApply / stashPop / stashDrop and error paths through the real N-API module.');
})().catch(error => { console.error(error); process.exitCode = 1; });
