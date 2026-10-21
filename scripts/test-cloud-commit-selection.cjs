const assert = require('node:assert/strict');
const Module = require('node:module');

// 云端提交(HEAD..upstream)的选中链路: webview 发 selectCommit -> Provider 在本地列表找不到时回落到云端提交 ->
// commitController.selectCommit -> onSelectedCommitChanged -> getCommitFiles(按 hash 读本地对象库)。
class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const repoOption = { path: 'file:///cloud/a', label: 'a', equals: other => other.path === 'file:///cloud/a' };
const head = { repoOption, name: 'refs/heads/main', label: 'main', kind: 'current', hash: 'a'.repeat(40), equals: other => other === head };
const cloudHash = 'f'.repeat(40);
const cloudCommit = { hash: cloudHash, shortHash: 'ffffffff', parents: ['a'.repeat(40)], message: 'cloud tip', rawMessage: 'cloud tip\n\nbody', body: 'body', author: 'cloud', refs: [] };
const fileReads = [];
const vscode = {
  EventEmitter: Emitter,
  Uri: { parse: value => ({ toString: () => value, fsPath: value.replace(/^file:\/\//, '') }), file: p => ({ fsPath: p, toString: () => 'file://' + p }) },
  window: { showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {} },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async () => {} },
  ProgressLocation: { Notification: 15 },
  ThemeIcon: class {},
  Disposable: { from: (...items) => ({ dispose() { items.forEach(item => item.dispose && item.dispose()); } }) },
};
const load = Module._load;
let GitkViewProvider, GitCommitController, store;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === '../git/gitLogProvider') return {
      ...load.call(this, name, ...args),
      getCommitFiles: async (_uri, hash) => { fileReads.push(hash); return [{ path: 'cloud-file.txt', status: 'A', diffKey: 'cloud-file.txt' }]; },
    };
    return load.call(this, name, ...args);
  };
  ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
  ({ store } = require('../out/state/store'));
} finally { Module._load = load; }

(async () => {
  const provider = Object.create(GitkViewProvider.prototype);
  const selected = [];
  const selectedChanged = new Emitter();
  let current;
  Object.defineProperty(provider, 'repositories', { value: [repoOption] });
  Object.assign(provider, {
    cloudCommitsByRepository: new Map([[repoOption.path, [cloudCommit]]]),
    uncommittedFilesWatcher: { listCurrentHeadBranches: () => [head] },
    branchesController: { getCurrentBranch: () => head },
    commitController: {
      findCommit: () => undefined,                       // 本地提交列表里没有它
      selectCommit: commit => { selected.push(commit); current = commit; selectedChanged.fire(commit); return true; },
      get selectedCommit() { return current; },
    },
  });

  // 1) findCommit: 本地没有 -> 回落到云端提交, 带上当前分支作为 gitBranchOption, 其余元数据原样保留
  const found = provider.findCommit(cloudHash, repoOption.path);
  assert.ok(found, 'a commit that only exists upstream is resolvable');
  assert.equal(found.hash, cloudHash);
  assert.equal(found.message, 'cloud tip');
  assert.equal(found.rawMessage, 'cloud tip\n\nbody', 'the full message travels with the commit, so the description matches an ordinary commit');
  assert.equal(found.gitBranchOption, head, 'it is attached to the repository current branch like any commit of that repository');
  assert.equal(provider.findCommit('0'.repeat(40), repoOption.path), undefined, 'unknown hashes still resolve to nothing');
  assert.equal(provider.findCommit(cloudHash, 'file:///other'), undefined, 'a cloud commit is only resolvable inside its own repository');

  // 2) selectCommit effect: 与普通提交同一条路径 -> controller.selectCommit
  provider.runEffect({ type: 'selectCommit', hash: cloudHash, repositoryPath: repoOption.path });
  assert.equal(selected.length, 1, 'selecting a cloud commit reaches the commit controller exactly once');
  assert.equal(selected[0].hash, cloudHash);
  assert.deepEqual(provider.requestedDiffReveal, { hash: cloudHash, repositoryPath: repoOption.path }, 'the diff panel is asked to reveal it, like an ordinary commit');

  // 3) 缓存失效(拉取/外部 fetch)后云端提交不再可解析 —— 不会选中一个已经不存在的云端行
  provider.cloudCommitsByRepository.clear();
  assert.equal(provider.findCommit(cloudHash, repoOption.path), undefined, 'a cleared cloud cache stops resolving');
  console.log('Cloud commit selection passed: resolves outside the local list, same controller path as ordinary commits, repository-scoped, cleared with the sync cache.');
})().catch(error => { console.error(error); process.exitCode = 1; });