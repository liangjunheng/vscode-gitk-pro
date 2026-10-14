const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadNativeGitBinding } = require('../out/git/nativeGitBinding');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-binding-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
const binding = loadNativeGitBinding();
const invoke = async (operation, payload = {}) => JSON.parse(await binding.invoke(operation, JSON.stringify({ rootPath: root, ...payload })));
(async () => {
  try {
    git('init');
    git('config', 'user.name', 'Gitk Test');
    git('config', 'user.email', 'gitk@example.com');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(root, 'example.gkt'), 'one\n');
    assert.equal((await invoke('status')).changes[0].path, 'example.gkt');
    await invoke('stage', { paths: ['example.gkt'] });
    assert.equal((await invoke('status')).staged[0].path, 'example.gkt');
    const hash = await invoke('commit', { message: 'subject\n\nbody', amend: false });
    assert.equal(hash, git('rev-parse', 'HEAD'));
    assert.equal((await invoke('commitDetails', { hashes: [hash] }))[0].message, 'subject\n\nbody');
    assert.deepEqual(await invoke('status'), { staged: [], changes: [] });
    git('commit', '--allow-empty', '-m', 'current stage');
    const ours = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'incoming stage');
    const theirs = git('rev-parse', 'HEAD');
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], {
      input: [hash, ours, theirs].map((oid, i) => `160000 ${oid} ${i + 1}\tchild\n`).join(''),
    });
    const conflict = await invoke('status');
    for (const group of [conflict.staged, conflict.changes]) {
      const child = group.find(file => file.path === 'child');
      assert.equal(child.isGitlink, true);
      assert.equal(child.isConflict, true);
      assert.equal(child.gitlinkConflictBaseObjectId, hash, 'native binary must return the base stage');
      assert.equal(child.gitlinkConflictCurrentObjectId, ours, 'native binary must return the current stage');
      assert.equal(child.gitlinkConflictIncomingObjectId, theirs, 'native binary must return the incoming stage');
    }
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], {
      input: `0 ${'0'.repeat(40)}\tchild\n160000 ${hash} 1\tchild\n160000 ${ours} 2\tchild\n`,
    });
    const deletion = await invoke('status');
    assert.equal(deletion.changes.find(file => file.path === 'child').gitlinkConflictIncomingObjectId, '0'.repeat(40), 'absent stages use explicit zero IDs, not missing fields');
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: `0 ${'0'.repeat(40)}\tchild\n` });

    // 同仓库状态读取与 index 写入会从不同 N-API worker 并发进入；
    // 每个快照都必须是写入前或写入后的完整状态，不能出现错误分组或丢失文件。
    fs.writeFileSync(path.join(root, 'example.gkt'), 'two\n');
    for (let round = 0; round < 12; round++) {
      const readers = Array.from({ length: 8 }, () => invoke('status'));
      if (round % 2 === 0) await invoke('stage', { paths: ['example.gkt'] });
      else await invoke('unstage', { paths: ['example.gkt'] });
      for (const snapshot of await Promise.all(readers)) {
        const paths = [...snapshot.staged, ...snapshot.changes].map(file => file.path);
        assert.ok(paths.includes('example.gkt'), `concurrent snapshot lost example.gkt: ${JSON.stringify(snapshot)}`);
      }
      const current = await invoke('status');
      assert.equal(current.staged.some(file => file.path === 'example.gkt'), round % 2 === 0);
      assert.equal(current.changes.some(file => file.path === 'example.gkt'), round % 2 !== 0);
    }

    const discovered = await invoke('discover', { path: root });
    assert.ok(discovered.gitDir && discovered.workdir);
    await assert.rejects(() => invoke('doesNotExist'), /不支持的 libgit2 操作/);
    console.log('N-API binding smoke test passed: status, serialized mutations, commit, history, discover, errors');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
