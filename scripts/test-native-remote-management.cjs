const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const binding = require('../out/git/nativeGitBinding');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-native-remotes-'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
let mode = 'native';
let subprocessCalls = 0;
function loadOperations() {
  const original = Module._load;
  const modulePath = require.resolve('../out/git/gitNativeOperations');
  delete require.cache[modulePath];
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, value) => value }) } };
      if (name === 'child_process') return {
        execFile: (...args) => {
          subprocessCalls++;
          if (mode !== 'legacy') throw new Error('Native remote management spawned a subprocess');
          return require('node:child_process').execFile(...args);
        },
      };
      if (name === './nativeGitBinding') return {
        ...binding,
        invokeNativeGitMutation: async (operation, payload) => {
          if (mode === 'legacy') throw new Error('invokeMutation 只允许修改操作: ' + operation);
          if (mode === 'failure') throw new Error('config is locked');
          return binding.invokeNativeGitMutation(operation, payload);
        },
        invokeNativeGitPriorityRead: async (operation, payload) => {
          if (mode === 'legacy') throw new Error('不支持的 libgit2 操作: ' + operation);
          return binding.invokeNativeGitPriorityRead(operation, payload);
        },
      };
      return original.call(this, name, ...args);
    };
    return require(modulePath);
  } finally { Module._load = original; }
}
const operations = loadOperations();
const invoke = (operation, cwd, payload = {}) => binding.invokeNativeGitMutation(operation, { rootPath: cwd, ...payload });
const config = cwd => git(cwd, 'config', '--local', '--list').split(/\r?\n/).filter(Boolean).sort();
const refs = cwd => git(cwd, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)').split(/\r?\n/).filter(Boolean).sort();
async function main() {
  try {
    const seed = path.join(root, 'seed'); fs.mkdirSync(seed);
    git(seed, 'init', '-q'); git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'seed');
    for (const scenario of ['normal', 'shared', 'local-destination', 'push-only']) {
      const source = path.join(root, scenario); fs.cpSync(seed, source, { recursive: true });
      git(source, 'remote', 'add', 'Origin', 'https://example.com/origin');
      git(source, 'remote', 'add', 'Origin.extra', 'https://example.com/extra');
      git(source, 'remote', 'add', 'other', 'https://example.com/other');
      git(source, 'config', 'remote.Origin.pushurl', 'https://example.com/push');
      git(source, 'config', 'branch.topic.with.dots.remote', 'Origin');
      git(source, 'config', '--add', 'branch.topic.with.dots.merge', 'refs/heads/main');
      git(source, 'config', '--add', 'branch.topic.with.dots.merge', 'refs/heads/second');
      git(source, 'config', 'branch.topic.with.dots.pushRemote', 'Origin');
      git(source, 'config', 'branch.single.remote', 'Origin');
      git(source, 'config', 'branch.single.merge', 'refs/heads/main');
      git(source, 'config', 'branch.pushonly.pushRemote', 'Origin');
      git(source, 'config', 'branch.pushonly.merge', 'refs/heads/main');
      git(source, 'config', 'branch.keep.remote', 'other');
      git(source, 'config', 'branch.keep.merge', 'refs/heads/main');
      git(source, 'config', 'remote.pushDefault', 'Origin');
      git(source, 'update-ref', 'refs/remotes/Origin/main', 'HEAD');
      git(source, 'symbolic-ref', 'refs/remotes/Origin/HEAD', 'refs/remotes/Origin/main');
      git(source, 'update-ref', 'refs/remotes/other/main', 'HEAD');
      git(source, 'update-ref', 'refs/heads/local', 'HEAD');
      if (scenario === 'shared') git(source, 'config', '--add', 'remote.other.fetch', '+refs/heads/*:refs/remotes/Origin/*');
      if (scenario === 'local-destination') git(source, 'config', '--add', 'remote.Origin.fetch', '+refs/heads/*:refs/heads/*');
      if (scenario === 'push-only') {
        git(source, 'config', '--unset-all', 'remote.Origin.fetch');
        git(source, 'config', '--add', 'remote.Origin.push', 'refs/heads/*:refs/remotes/other/*');
      }
      const oracle = path.join(root, scenario + '-oracle'); fs.cpSync(source, oracle, { recursive: true });
      for (const operation of ['fetch', 'pull', 'push']) {
        git(source, 'config', '--add', 'fastergit.remote.Origin.' + operation, 'true');
        git(source, 'config', '--add', 'fastergit.remote.Origin.' + operation, 'false');
      }
      git(source, 'config', 'fastergit.remote.Origin.extra.fetch', 'true');
      git(oracle, 'config', 'fastergit.remote.Origin.extra.fetch', 'true');
      git(oracle, 'remote', 'remove', 'Origin');
      await operations.removeRemote({ fsPath: source }, 'Origin');
      assert.deepEqual(refs(source), refs(oracle), scenario + ': reference parity with Git');
      assert.deepEqual(config(source), config(oracle), scenario + ': local configuration parity with Git');
    }
    const local = path.join(root, 'management'); fs.cpSync(seed, local, { recursive: true });
    const uri = { fsPath: local };
    await operations.addRemote(uri, '  origin  ', ' https://example.com/origin ');
    assert.equal(git(local, 'config', '--get', 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*');
    await operations.addRemote(uri, 'Origin', 'https://example.com/upper');
    const before = config(local);
    await assert.rejects(operations.addRemote(uri, 'origin', 'https://example.com/duplicate'));
    await assert.rejects(operations.addRemote(uri, 'bad~name', 'https://example.com/invalid'));
    await assert.rejects(operations.addRemote(uri, 'bad name', 'https://example.com/invalid'));
    await assert.rejects(operations.addRemote(uri, 'empty', '  '));
    assert.deepEqual(config(local), before, 'invalid/duplicate creation does not change config');
    for (const operation of ['fetch', 'pull']) await operations.setFasterGitRemoteOperation(uri, 'origin', operation, false);
    git(local, 'config', 'fastergit.remote.origin.push', 'true');
    const configuredOperations = (await operations.readFasterGitRemoteOperations(uri, ['origin'])).get('origin');
    assert.deepEqual([...configuredOperations.values()], [false, false]);
    assert.equal(configuredOperations.has('push'), false, 'the retired Push setting is ignored when reading Remote state');
    await assert.rejects(invoke('setRemoteOperation', local, { remoteName: 'origin', operation: 'push', enabled: true }), /不支持的 remote 操作/);
    await operations.clearFasterGitRemoteOperations(uri, 'origin');
    await operations.clearFasterGitRemoteOperations(uri, 'origin');
    assert.equal((await operations.readFasterGitRemoteOperations(uri, ['origin'])).size, 0);
    assert.equal(config(local).some(line => line.startsWith('fastergit.remote.origin.push=')), false, 'cleanup removes the retired Push key');
    assert.deepEqual((await operations.listRemotes(uri)).map(remote => remote.name).sort(), ['Origin', 'origin'].sort());
    await assert.rejects(invoke('removeRemote', local, { remoteName: 'missing' }));
    await assert.rejects(binding.invokeNativeGitPriorityRead('removeRemote', { rootPath: local, remoteName: 'origin' }), /只允许读取操作/);
    const lock = path.join(local, '.git', 'config.lock'); fs.writeFileSync(lock, '');
    const lockedConfig = config(local);
    await assert.rejects(operations.addRemote(uri, 'locked', 'https://example.com/locked'));
    assert.deepEqual(config(local), lockedConfig);
    fs.unlinkSync(lock);
    assert.equal(subprocessCalls, 0, 'all native management paths execute without subprocesses');
    mode = 'failure';
    await assert.rejects(operations.addRemote(uri, 'failure', 'https://example.com/failure'), /config is locked/);
    await assert.rejects(operations.clearFasterGitRemoteOperations(uri, 'origin'), /config is locked/);
    await assert.rejects(operations.removeRemote(uri, 'origin'), /config is locked/);
    assert.equal(subprocessCalls, 0, 'real native errors do not trigger CLI fallback');
    mode = 'legacy';
    await operations.addRemote(uri, 'legacy', 'https://example.com/legacy');
    await operations.setFasterGitRemoteOperation(uri, 'legacy', 'fetch', true);
    assert.ok((await operations.listRemotes(uri)).some(remote => remote.name === 'legacy'));
    assert.equal((await operations.readFasterGitRemoteOperations(uri, ['legacy'])).get('legacy').get('fetch'), true);
    await operations.removeRemote(uri, 'legacy');
    assert.equal(git(local, 'remote').includes('legacy'), false);
    assert.ok(subprocessCalls > 0, 'legacy mutation rejection falls back to CLI');
    mode = 'native';
    if (process.argv.includes('--benchmark')) {
      const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { n: values.length, p50: +sorted[Math.floor((sorted.length - 1) * .5)].toFixed(2), p95: +sorted[Math.floor((sorted.length - 1) * .95)].toFixed(2) }; };
      const values = { nativeAdd: [], cliAdd: [], nativeClear: [], cliClear: [], nativeRemove: [], cliRemove: [] };
      for (let i = 0; i < 12; i++) {
        let start = performance.now(); await operations.addRemote(uri, 'native', 'https://example.com/native'); values.nativeAdd.push(performance.now() - start);
        start = performance.now(); git(local, 'remote', 'add', 'cli', 'https://example.com/cli'); values.cliAdd.push(performance.now() - start);
        await operations.setFasterGitRemoteOperation(uri, 'native', 'fetch', true);
        start = performance.now(); await operations.clearFasterGitRemoteOperations(uri, 'native'); values.nativeClear.push(performance.now() - start);
        git(local, 'config', 'fastergit.remote.cli.fetch', 'true');
        start = performance.now(); git(local, 'config', '--local', '--unset-all', 'fastergit.remote.cli.fetch'); values.cliClear.push(performance.now() - start);
        start = performance.now(); await operations.removeRemote(uri, 'native'); values.nativeRemove.push(performance.now() - start);
        start = performance.now(); git(local, 'remote', 'remove', 'cli'); values.cliRemove.push(performance.now() - start);
      }
      console.log(JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, summary(value)])), null, 2));
    }
    console.log('Native remote management passed: Git parity, Fetch/Pull settings, retired Push cleanup, shared/local refs, dotted/case-sensitive names, explicit false, errors, zero subprocesses, legacy fallback.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
