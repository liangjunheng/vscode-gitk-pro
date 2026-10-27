const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const binding = require('../out/git/nativeGitBinding');

// Git CLI is only the oracle here; production calls must not spawn processes.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-native-local-ops-'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-global') },
}).trim();
let subprocessCalls = 0;
function loadOperations() {
  const original = Module._load;
  const modulePath = require.resolve('../out/git/gitNativeOperations');
  delete require.cache[modulePath];
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, value) => value }) } };
      if (name === 'child_process') return {
        execFile: (...args) => { subprocessCalls++; return require('node:child_process').execFile(...args); },
      };
      return original.call(this, name, ...args);
    };
    return require(modulePath);
  } finally { Module._load = original; }
}
const operations = loadOperations();
const seed = name => {
  const repo = path.join(root, name); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'file.gkt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  return repo;
};
const localBranchConfig = repo => { try { return git(repo, 'config', '--local', '--get-regexp', '^branch\\.').split(/\r?\n/).sort(); } catch { return []; } };

async function verifyTags() {
  const repo = seed('tags');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'light'); git(repo, 'tag', '-a', 'annotated', '-m', 'a');
  git(repo, 'tag', '-a', 'nested-annotated', '-m', 'n', 'annotated');
  git(repo, 'tag', 'tree-tag', 'HEAD^{tree}');
  git(repo, 'remote', 'add', 'origin', 'https://example.com/o'); git(repo, 'remote', 'add', 'Upstream', 'https://example.com/u');
  const oracle = new Map(git(repo, 'for-each-ref', '--format=%(refname:strip=2) %(*objectname) %(objectname)', 'refs/tags')
    .split(/\r?\n/).map(line => { const [name, peeled, direct] = line.split(' '); return [name, peeled || direct]; }));
  const native = await binding.invokeNativeGitPriorityRead('tagTargets', { rootPath: repo });
  for (const name of ['light', 'annotated']) assert.equal(native.tags[name], head, name + ' targets the commit like for-each-ref');
  assert.equal(native.tags['tree-tag'], oracle.get('tree-tag'), 'a non-commit tag keeps its object id');
  assert.equal(native.tags['nested-annotated'], head, 'a tag of a tag is peeled to the commit');
  assert.deepEqual([...native.remotes].sort(), git(repo, 'remote').split(/\r?\n/).sort(), 'remote names match git remote');

  const before = subprocessCalls;
  await operations.deleteLocalTag({ fsPath: repo }, 'annotated');
  assert.equal(subprocessCalls, before, 'deleteLocalTag spawns no process');
  assert.equal(git(repo, 'tag', '--list', 'annotated'), '', 'annotated tag ref removed');
  assert.equal(git(repo, 'tag', '--list', 'light'), 'light', 'other tags are untouched');
  await assert.rejects(operations.deleteLocalTag({ fsPath: repo }, 'missing'), /not found/);
  await assert.rejects(binding.invokeNativeGitMutation('deleteTag', { rootPath: repo, name: 'bad..name' }), /Invalid tag name/);
}

async function verifyTrackingBranch() {
  const base = seed('tracking-base');
  git(base, 'checkout', '-q', '-b', 'source'); fs.writeFileSync(path.join(base, 'file.gkt'), 'remote\n'); git(base, 'commit', '-q', '-am', 'remote');
  const remoteHead = git(base, 'rev-parse', 'HEAD');
  git(base, 'checkout', '-q', 'main');
  git(base, 'remote', 'add', 'origin', 'https://example.com/o');
  git(base, 'update-ref', 'refs/remotes/origin/team/topic', remoteHead);
  git(base, 'remote', 'add', 'mirror', 'https://example.com/m');
  git(base, 'config', '--add', 'remote.mirror.fetch', '+refs/pull/*:refs/remotes/mirror/pr/*');
  git(base, 'update-ref', 'refs/remotes/mirror/pr/7', remoteHead);
  git(base, 'update-ref', 'refs/remotes/stray/x', remoteHead);
  for (const [ref, local] of [['refs/remotes/origin/team/topic', 'team/topic'], ['refs/remotes/mirror/pr/7', 'pr7']]) {
    const nativeRepo = path.join(root, 'native-' + local.replace('/', '-')); fs.cpSync(base, nativeRepo, { recursive: true });
    const oracleRepo = path.join(root, 'oracle-' + local.replace('/', '-')); fs.cpSync(base, oracleRepo, { recursive: true });
    git(oracleRepo, 'checkout', '-q', '--track', '-b', local, ref);
    const before = subprocessCalls;
    await operations.checkoutRemoteBranch({ fsPath: nativeRepo }, ref, local);
    assert.equal(subprocessCalls, before, 'checkoutRemoteBranch spawns no process');
    assert.deepEqual(localBranchConfig(nativeRepo), localBranchConfig(oracleRepo), local + ': tracking config matches git checkout --track');
    assert.equal(git(nativeRepo, 'branch', '--show-current'), local);
    assert.equal(git(nativeRepo, 'rev-parse', 'HEAD'), remoteHead);
    assert.equal(fs.readFileSync(path.join(nativeRepo, 'file.gkt'), 'utf8'), 'remote\n');
  }
  // Refusals: stray ref, existing branch, invalid names, dirty conflicting worktree.
  const repo = path.join(root, 'native-refusals'); fs.cpSync(base, repo, { recursive: true });
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(operations.checkoutRemoteBranch({ fsPath: repo }, 'refs/remotes/stray/x', 'strayx'), /not a branch/);
  for (const name of ['invalid name', 'HEAD', 'a@{b', 'a..b']) {
    await assert.rejects(operations.checkoutRemoteBranch({ fsPath: repo }, 'refs/remotes/origin/team/topic', name), /not a valid branch name/);
  }
  await assert.rejects(operations.checkoutRemoteBranch({ fsPath: repo }, 'refs/remotes/origin/team/topic', 'main'), /already exists/);
  fs.writeFileSync(path.join(repo, 'file.gkt'), 'local edits\n');
  await assert.rejects(operations.checkoutRemoteBranch({ fsPath: repo }, 'refs/remotes/origin/team/topic', 'team/topic'));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'refused checkout keeps HEAD');
  assert.equal(fs.readFileSync(path.join(repo, 'file.gkt'), 'utf8'), 'local edits\n', 'refused checkout keeps local edits');
  assert.equal(git(repo, 'branch', '--list', 'team/topic'), '', 'refused checkout rolls back the new branch');
  assert.deepEqual(localBranchConfig(repo), [], 'refused checkout rolls back tracking config');
}

async function verifyProxyDetection() {
  const repo = seed('proxy');
  git(repo, 'remote', 'add', 'origin', 'https://example.com/o');
  const oracle = () => { try { git(repo, 'config', '--get-regexp', '^(http\\.proxy|remote\\..*\\.proxy)$'); return true; } catch { return false; } };
  const cases = [
    ['none', () => {}],
    ['remote proxy', () => git(repo, 'config', 'remote.origin.proxy', 'http://p:1')],
    ['empty http.proxy', () => { git(repo, 'config', '--unset', 'remote.origin.proxy'); git(repo, 'config', 'http.proxy', ''); }],
    ['url-scoped proxy is not counted', () => { git(repo, 'config', '--unset', 'http.proxy'); git(repo, 'config', 'http.https://x.test.proxy', 'http://p:2'); }],
  ];
  for (const [label, mutate] of cases) {
    mutate();
    const native = await binding.invokeNativeGitPriorityRead('explicitProxyConfigured', { rootPath: repo });
    assert.equal(native, oracle(), label + ': native proxy detection matches git config --get-regexp');
  }
  // libgit2 resolves the global file from HOME/USERPROFILE once at init and ignores
  // GIT_CONFIG_GLOBAL for discovered repositories, so check the global level in a child
  // process whose home directory is isolated before the binding loads.
  git(repo, 'config', '--unset', 'http.https://x.test.proxy');
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const probe = expected => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: '', XDG_CONFIG_HOME: path.join(home, 'xdg') };
    delete env.GIT_CONFIG_GLOBAL;
    const script = "require(process.argv[1]).invokeNativeGitPriorityRead('explicitProxyConfigured', { rootPath: process.argv[2] }).then(v => process.stdout.write(String(v)))";
    const actual = execFileSync(process.execPath, ['-e', script, require.resolve('../out/git/nativeGitBinding'), repo], { encoding: 'utf8', env, windowsHide: true }).trim();
    const oracle = (() => { try { execFileSync('git', ['-C', repo, 'config', '--get-regexp', '^(http\\.proxy|remote\\..*\\.proxy)$'], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore', windowsHide: true }); return 'true'; } catch { return 'false'; } })();
    assert.equal(oracle, String(expected), 'Git oracle sees the isolated global config');
    assert.equal(actual, String(expected), 'native proxy detection reads the global config level');
  };
  probe(false);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[http]\n\tproxy = http://g:3\n');
  probe(true);
}

(async () => {
  try {
    fs.writeFileSync(path.join(root, 'empty-global'), '');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-global');
    await verifyTags();
    await verifyTrackingBranch();
    await verifyProxyDetection();
    console.log('Native local Git operations passed: tag targets/delete, tracking branch parity and rollback, proxy detection parity, zero subprocesses.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
