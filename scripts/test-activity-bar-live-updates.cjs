const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

class EventEmitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => fsPath });
const fileWatchers = [];
const vscode = {
  EventEmitter,
  Uri: { parse: uri, file: uri },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  Disposable: { from: (...items) => ({ dispose() { items.forEach(item => item.dispose()); } }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  workspace: {
    createFileSystemWatcher(pattern) {
      const create = new EventEmitter(), change = new EventEmitter(), remove = new EventEmitter();
      const watcher = { pattern, create, change, remove, onDidCreate: create.event,
        onDidChange: change.event, onDidDelete: remove.event, dispose() {} };
      fileWatchers.push(watcher);
      return watcher;
    },
  },
};

const load = Module._load;
let UncommittedFilesWatcher, CommitPanelViewTitleController, GitkViewProvider, store, WorkingTreeChanges, CommitFile;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === './nativeGitBinding') return { invokeNativeGit: async (_, args) => ({ gitDir: path.join(args.path, '.git') }) };
    return load.call(this, name, ...args);
  };
  ({ UncommittedFilesWatcher } = require('../out/git/uncommittedFilesWatcher'));
  ({ CommitPanelViewTitleController } = require('../out/webview/commitPanelViewTitleController'));
  ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
  ({ store } = require('../out/state/store'));
  ({ WorkingTreeChanges, CommitFile } = require('../out/types'));
} finally { Module._load = load; }

async function main() {
  const roots = ['main', 'child', 'main/nested'].map(name => path.resolve('/badge-fixture', name));
  const branches = roots.map((root, index) => ({ kind: 'current', name: 'main', hash: 'head-1',
    repoOption: { path: root, label: index ? 'child' : 'main', ancestry: [] } }));
  branches[2].repoOption.ancestry = [branches[0].repoOption];
  const snapshots = new Map(roots.map(root => [root, new WorkingTreeChanges()]));
  const changes = (staged = [], unstaged = []) => new WorkingTreeChanges({
    staged: staged.map(filePath => new CommitFile({ path: filePath, status: 'M' })),
    changes: unstaged.map(filePath => new CommitFile({ path: filePath, status: 'M' })),
  });
  let heldRead;
  const backend = {
    getWorkingTreeStatus: async root => snapshots.get(root.fsPath),
    getIndexChangedPaths: async root => new Set(snapshots.get(root.fsPath).staged.map(file => file.path)),
    getWorkingTreeStatusForPaths: async (root, paths) => {
      const snapshot = snapshots.get(root.fsPath);
      if (heldRead) { const hold = heldRead; heldRead = undefined; await hold; }
      return new WorkingTreeChanges({ staged: snapshot.staged.filter(file => paths.includes(file.path)),
        changes: snapshot.changes.filter(file => paths.includes(file.path)) });
    },
  };
  const headEvents = new EventEmitter();
  const headWatcher = { onEachRepoHeadBranchChanged: headEvents.event,
    refreshHeadBranch: async repositoryPath => headEvents.fire({ repositoryPath, headBranch: branches.find(branch => branch.repoOption.path === repositoryPath) }) };
  const watcher = new UncommittedFilesWatcher(headWatcher, backend);
  const title = new CommitPanelViewTitleController(() => {});
  const view = {};
  title.bindView(view, []);
  store.setState({ commitRepositories: [] });
  // No Webview is bound: filesystem events must still update the activity badge.
  const provider = Object.create(GitkViewProvider.prototype);
  Object.assign(provider, { clearWorkingTreeDiffCache() {}, commitPanelViewTitleController: title,
    onDidChangeWorkingTreeSummaryEmitter: new EventEmitter(), commitPanel: { isVisible: () => false } });
  const subscription = watcher.onEachHeadBranchUncommittedFileChanged(event =>
    provider.onRepositoryUncommittedFilesChanged(event.branch, event.changes));
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if ([...watcher.slots.values()].every(slot => !slot.running) && watcher.indexWatcherCreations.size === 0) return;
    }
    throw new Error('Automatic refresh did not settle');
  };
  const fsWatcher = (index, pattern) => fileWatchers.find(item => item.pattern.base.fsPath ===
    (pattern === 'index' ? path.join(roots[index], '.git') : roots[index]) && item.pattern.pattern === pattern);
  const emitFile = (index, event, filePath) => fsWatcher(index, '**/*')[event].fire(uri(path.join(roots[index], filePath)));
  try {
    for (const branch of branches) headEvents.fire({ repositoryPath: branch.repoOption.path, headBranch: branch });
    await settle();
    assert.equal(view.badge, undefined);
    snapshots.set(roots[0], changes([], ['a', 'b', 'c']));
    for (const filePath of ['a', 'b', 'c']) emitFile(0, 'create', filePath);
    await settle();
    assert.equal(view.badge.value, 3, 'file creates automatically update a hidden sidebar badge');
    snapshots.set(roots[0], changes(['a'], ['b', 'c']));
    fsWatcher(0, 'index').change.fire();
    await settle();
    assert.equal(view.badge.value, 3, 'external git add does not double-count');
    snapshots.set(roots[0], changes([], ['a', 'b', 'c']));
    fsWatcher(0, 'index').change.fire();
    await settle();
    assert.equal(view.badge.value, 3, 'external unstage preserves the count');
    snapshots.set(roots[1], changes([], ['a']));
    emitFile(1, 'create', 'a');
    await settle();
    assert.equal(view.badge.value, 4, 'an unselected repository updates the total');
    let release;
    heldRead = new Promise(resolve => { release = resolve; });
    snapshots.set(roots[0], changes([], ['a', 'b', 'c', 'd']));
    emitFile(0, 'create', 'd');
    snapshots.set(roots[0], changes([], ['a', 'b', 'c', 'd', 'e']));
    emitFile(0, 'create', 'e');
    release();
    await settle();
    assert.equal(view.badge.value, 6, 'changes during an in-flight read are drained, not lost');
    watcher.beginWorkingTreeMutation(branches[0]);
    snapshots.set(roots[0], changes());
    await watcher.endWorkingTreeMutation(branches[0], ['a', 'b', 'c', 'd', 'e']);
    assert.equal(view.badge.value, 1, 'discard transaction completion updates the badge');
    snapshots.set(roots[1], changes());
    emitFile(1, 'remove', 'a');
    await settle();
    assert.equal(view.badge, undefined, 'deleting the final changed file hides the badge');
    snapshots.set(roots[0], changes(['committed']));
    fsWatcher(0, 'index').change.fire();
    await settle();
    assert.equal(view.badge.value, 1);
    snapshots.set(roots[0], changes());
    branches[0] = { ...branches[0], hash: 'head-2' };
    await watcher.refreshHeadBranch(roots[0]);
    assert.equal(view.badge, undefined, 'commit HEAD refresh publishes the clean snapshot');
    snapshots.set(roots[0], changes([], ['nested']));
    snapshots.set(roots[2], changes([], ['a']));
    emitFile(2, 'create', 'a');
    await settle();
    assert.equal(view.badge.value, 2, 'submodule changes refresh both child files and the parent gitlink');
    snapshots.set(roots[0], changes());
    snapshots.set(roots[2], changes());
    emitFile(2, 'remove', 'a');
    await settle();
    assert.equal(view.badge, undefined, 'a clean submodule also clears the parent gitlink count');
    console.log('Activity bar live-update tests passed: filesystem, index, hidden sidebar, other repositories, concurrent events, discard and commit.');
  } finally {
    subscription.dispose(); watcher.dispose(); title.dispose(); headEvents.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
