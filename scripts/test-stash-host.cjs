const assert = require('node:assert/strict');
const Module = require('node:module');

// Stash 的宿主侧链路:
//  1) 列表: 选中解析（stash 不在任何提交列表里）、stateUpdate 下发（开关/搜索/多仓库）、变更文件读取走 stash 专用读取。
//  2) 动作: 分组头 stash 固定映射到 unstaged(-k -u) / staged(-S)，不弹确认框；覆盖队列执行与错误处理。
class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const repoA = { path: 'file:///stash/a', label: 'a', equals: other => other.path === 'file:///stash/a' };
const repoB = { path: 'file:///stash/b', label: 'b', equals: other => other.path === 'file:///stash/b' };
const headOf = repo => ({ repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: 'a'.repeat(40), equals: other => other === headOf });
const heads = { [repoA.path]: headOf(repoA), [repoB.path]: headOf(repoB) };
const stashHash = '1'.repeat(40);
const stashEntry = (hash, index, message) => ({ hash, shortHash: hash.slice(0, 8), parents: ['a'.repeat(40), 'b'.repeat(40)], message, rawMessage: message, body: '', author: 'me', authorDateLabel: 'today', stashIndex: index, stashRef: 'stash@{' + index + '}' });

let stashReadResult = () => [];
const stashCalls = [], fileReads = [], commitFileReads = [], warnings = [], dialogs = [], controllerCalls = [];
const configurationValues = new Map([['showStashes', false]]);
const configurationWrites = [];
let dialogChoice;
let stashFilesResult = [{ path: 'stashed.txt', status: 'M', diffKey: 'stashed.txt' }];
let backendStashImpl = async () => ({ stash: 'x', skippedGitlinks: [] });
const opCalls = [];
let backendOpImpl = async (operation, hash) => ({ stash: hash, conflicts: false, dropped: operation === 'pop' });
const vscode = {
  EventEmitter: Emitter,
  Uri: { parse: value => ({ toString: () => value, fsPath: value.replace(/^file:\/\//, '') }), file: p => ({ fsPath: p, toString: () => 'file://' + p }) },
  window: {
    showWarningMessage: (message, options, ...items) => {
      if (options && options.modal) { dialogs.push({ message, items }); return Promise.resolve(dialogChoice); }
      warnings.push(message); return Promise.resolve(undefined);
    },
    showErrorMessage(message) { warnings.push('ERROR ' + message); }, showInformationMessage() {},
    withProgress: async (_options, task) => task({ report() {} }),
  },
  workspace: {
    getConfiguration: section => ({
      get: (key, defaultValue) => configurationValues.has(key) ? configurationValues.get(key) : defaultValue,
      update: (key, value, target) => { configurationValues.set(key, value); configurationWrites.push({ section, key, value, target }); return Promise.resolve(); },
    }),
    fs: { delete: async () => {} },
  },
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async () => {} },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  ThemeIcon: class {},
  Disposable: { from: (...items) => ({ dispose() { items.forEach(item => item.dispose && item.dispose()); } }) },
};
const load = Module._load;
let GitkViewProvider, store;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === '../git/gitLogProvider') return {
      ...load.call(this, name, ...args),
      getStashFiles: async (_uri, hash) => { fileReads.push(hash); return stashFilesResult.map(file => ({ ...file })); },
      getStashes: async () => stashReadResult(),
      getCommitFiles: async (_uri, hash) => { commitFileReads.push(hash); return []; },
    };
    return load.call(this, name, ...args);
  };
  ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
  ({ store } = require('../out/state/store'));
} finally { Module._load = load; }

const file = (path, extra = {}) => ({ path, status: 'M', ...extra });

(async () => {
  const provider = Object.create(GitkViewProvider.prototype);
  let published;
  const selected = [];
  let snapshot = { staged: [], changes: [] };
  let cachedSnapshot;
  const completedMutations = [];
  let selectedPaths = [repoA.path];
  Object.defineProperties(provider, {
    repositories: { value: [repoA, repoB] },
    selectedRepositoryPaths: { get: () => selectedPaths },
    branches: { value: [] }, selectedBranches: { value: [] }, commitLoadingMode: { value: 'bar' },
  });
  Object.assign(provider, {
    view: { webview: { postMessage: value => { published = value; } } },
    stashesByRepository: new Map([[repoA.path, [stashEntry(stashHash, 0, 'WIP on main: newest'), stashEntry('2'.repeat(40), 1, 'On main: older')]]]),
    stashLoadingByRepository: new Map(), showStashes: true,
    cloudCommitsByRepository: new Map(), unpushedCommitCountByRepository: new Map(), behindCommitCountByRepository: new Map(),
    changedFileSummaryCache: new WeakMap(), commitMessageByRepo: new Map(), commitCommittingByRepo: new Set(), repositoryCardDisplayLocks: new Set(),
    pushTargetByRepository: new Map(), lastPushedTargetByRepository: new Map(), commitAmendByRepo: new Map(),
    repositorySyncKeyByRepository: new Map(), repositorySyncStateLoadingByHead: new Set(), repositorySyncRevisionByRepository: new Map(),
    selectedBranchesMap: new Map(),
    loadRepositorySyncState: async () => {}, loadRepositoryStashes: async () => {},
    schedulePushState: () => {}, commitPanel: { isVisible: () => false, update() {} },
    repoSubmoduleWatcher: { findSubmoduleRepository: () => undefined, getRepositoryAncestry: () => [] },
    commitPanelViewTitleController: { update() {} },
    branchesController: { getCurrentBranch: repo => heads[repo.path], clearRepositorySelection() {} },
    getRepoRootUri: path => vscode.Uri.parse(path),
    gitBackend: {
      stash: async (root, scope) => { stashCalls.push([root.toString(), scope]); return backendStashImpl(root, scope); },
      stashApply: async (root, hash) => { opCalls.push(['apply', root.toString(), hash]); return backendOpImpl('apply', hash); },
      stashPop: async (root, hash) => { opCalls.push(['pop', root.toString(), hash]); return backendOpImpl('pop', hash); },
      stashDrop: async (root, hash) => { opCalls.push(['drop', root.toString(), hash]); return backendOpImpl('drop', hash); },
      stage: async () => {},
      unstage: async (root, paths) => { opCalls.push(['unstage', root.toString(), [...paths]]); },
    },
    commitController: {
      isLoading: false, searchedCommitList: [], displayedSearchKeywords: [], totalCommitList: [], uncommittedRepositoryPath: repoA.path,
      hiddenStashCounts: new Map(),
      setStashes: (repositoryPath, stashes) => { controllerCalls.push(['setStashes', repositoryPath, stashes.map(s => s.hash)]); return true; },
      setStashesVisible: visible => { controllerCalls.push(['setStashesVisible', visible]); return true; },
      forgetStashes: repositoryPath => { controllerCalls.push(['forgetStashes', repositoryPath]); },
      latestCommitOf: () => undefined,
      findCommit: () => undefined,
      requestUncommittedPresenceCheck() {},
      selectCommit: commit => { selected.push(commit); return true; },
    },
    uncommittedFilesWatcher: {
      listCurrentHeadBranches: () => [heads[repoA.path], heads[repoB.path]],
      getUncommittedFilesByHeadBranch: async () => snapshot,
      beginWorkingTreeMutation() {}, endWorkingTreeMutation: async () => {},
      completeWorkingTreeMutation: async (_branch, changes, affectedPaths, verificationPaths) => {
        completedMutations.push({ changes, affectedPaths: [...affectedPaths], verificationPaths: [...verificationPaths] });
        cachedSnapshot = changes;
      },
      getCachedUncommittedFilesByHeadBranch: () => cachedSnapshot,
    },
    workingTreeUiMutations: new Set(), deferredWorkingTreeChanges: new Map(),
    workingTreeActionQueue: [], processingWorkingTreeActions: false,
    applyWorkingTreeChanges: async () => {},
    getCachedUncommittedFilesByHeadBranch: () => undefined,
    commitController_requestUncommittedPresenceCheck: () => {},
  });
  const setSnapshot = (staged, changes) => {
    snapshot = { staged, changes };
    store.setState({ stagedFiles: staged, unstagedFiles: changes });
  };

  // ---- 1) 选中解析
  const found = provider.findCommit(stashHash, repoA.path);
  assert.ok(found, 'a stash outside every commit list is resolvable');
  assert.equal(found.hash, stashHash);
  assert.equal(found.gitBranchOption, heads[repoA.path], 'it is attached to the repository current branch like a cloud commit');
  assert.equal(provider.findCommit('0'.repeat(40), repoA.path), undefined, 'unknown hashes resolve to nothing');
  assert.equal(provider.findCommit(stashHash, repoB.path), undefined, 'a stash only resolves inside its own repository');
  assert.equal(provider.isStashHash(stashHash, repoA.path), true);
  assert.equal(provider.isStashHash('a'.repeat(40), repoA.path), false);

  // ---- 2) 状态下发: stash 行已经在控制器建好的提交图里; 宿主只下发开关状态和“基线未加载”的数量
  provider.pushStateToWebview();
  assert.equal(published.state.showStashes, true, 'the fixture opts in so the list below can be exercised');
  // 夹具用 Object.create 绕过构造, 字段初始值不会执行; 真实默认值只能对编译产物做源码级断言(GitkViewProvider 的构造依赖整个扩展上下文, 无法在这里实例化)。
  const compiledProvider = require('node:fs').readFileSync(require.resolve('../out/webview/gitkViewProvider'), 'utf8');
  assert.match(compiledProvider, /this\.showStashes = false;/, 'the provider field keeps a safe pre-constructor fallback');
  assert.doesNotMatch(compiledProvider, /this\.showStashes = true;/);
  assert.match(compiledProvider, /configuration\.get\(['"]showStashes['"], true\)/, 'the constructor restores the saved showStashes setting with an on fallback');
  assert.match(compiledProvider, /affectsConfiguration\(['"]fastergit\.showStashes['"]\)/, 'external Settings changes update the live view');
  assert.match(compiledProvider, /\.update\([\s\S]*?['"]showStashes['"][\s\S]*?ConfigurationTarget\.Global/, 'the toolbar toggle persists globally');
  const packageJson = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../package.json'), 'utf8'));
  assert.deepEqual(packageJson.contributes.configuration.properties['fastergit.showStashes'], {
    type: 'boolean', default: true, scope: 'application',
    description: '在 Commit 列表中显示 Stash。列表右上角的 Stash 按钮会同步更新此设置。',
  }, 'the preference is public in Settings and defaults to on');
  const compiledCommitCard = require('node:fs').readFileSync(require.resolve('../out/webview/commitCardScript'), 'utf8');
  assert.match(compiledCommitCard, /stashStaged\.hidden=conflictCount>0;/, 'Commit Panel hides staged stash while conflicts exist');
  assert.match(compiledCommitCard, /stashUnstaged\.hidden=conflictCount>0;/, 'Commit Panel hides unstaged stash while conflicts exist');
  const compiledChangedFiles = require('node:fs').readFileSync(require.resolve('../out/webview/changedFilesSubPanel'), 'utf8');
  assert.match(compiledChangedFiles, /const stashAction\s*=\s*hasConflicts\s*\?\s*['"]{2}\s*:/, 'Changed Files omits stash actions while conflicts exist');

  assert.equal('stashGroups' in published.state, false, 'there is no separate stash group payload any more');
  assert.equal(published.state.hiddenStashCount, 0);
  provider.showStashes = false; provider.pushStateToWebview();
  assert.equal(published.state.showStashes, false);
  provider.showStashes = true;
  provider.commitController.hiddenStashCounts = new Map([[repoA.path, 2], [repoB.path, 5]]);
  provider.pushStateToWebview();
  assert.equal(published.state.hiddenStashCount, 2, 'only selected repositories contribute to the hidden count');
  selectedPaths = [repoA.path, repoB.path]; provider.pushStateToWebview();
  assert.equal(published.state.hiddenStashCount, 7, 'summed across the selected repositories');
  selectedPaths = [repoA.path];
  provider.commitController.hiddenStashCounts = new Map();

  // 控制器拿到 stash 列表: loadRepositoryStashes -> setStashes (就地重建图, 不重读 git log)
  {
    const original = provider.loadRepositoryStashes; delete provider.loadRepositoryStashes;
    provider.stashesByRepository.clear(); provider.stashLoadingByRepository.clear();
    controllerCalls.length = 0;
    stashReadResult = () => [stashEntry(stashHash, 0, 'WIP on main: newest'), stashEntry('2'.repeat(40), 1, 'On main: older')];
    await GitkViewProvider.prototype.loadRepositoryStashes.call(provider, repoA.path, true);
    assert.deepEqual(controllerCalls.map(call => call[0]), ['setStashes'], 'the loaded stashes are handed to the controller');
    assert.deepEqual(controllerCalls[0][2], [stashHash, '2'.repeat(40)]);
    assert.equal(controllerCalls[0][1], repoA.path);
    controllerCalls.length = 0;
    await GitkViewProvider.prototype.loadRepositoryStashes.call(provider, repoA.path, true);
    assert.deepEqual(controllerCalls, [], 'an unchanged list is not pushed again');
    provider.loadRepositoryStashes = original;
  }

  // ---- 3) 开关意图 -> Store -> 宿主
  assert.deepEqual(store.dispatch({ type: 'toggleStashes', visible: false }), [{ type: 'toggleStashes', visible: false }]);
  assert.deepEqual(store.dispatch({ type: 'toggleStashes', visible: 'no' }), [], 'non-boolean values are rejected');
  controllerCalls.length = 0; configurationWrites.length = 0;
  provider.runEffect({ type: 'toggleStashes', visible: false }); assert.equal(provider.showStashes, false);
  assert.deepEqual(controllerCalls, [['setStashesVisible', false]], 'the controller rebuilds the graph without stash rows');
  assert.deepEqual(configurationWrites.at(-1), { section: 'fastergit', key: 'showStashes', value: false, target: vscode.ConfigurationTarget.Global }, 'explicit off is saved globally');
  provider.runEffect({ type: 'toggleStashes' }); assert.equal(provider.showStashes, true, 'no value flips the state');
  assert.deepEqual(controllerCalls.at(-1), ['setStashesVisible', true]);
  assert.deepEqual(configurationWrites.at(-1), { section: 'fastergit', key: 'showStashes', value: true, target: vscode.ConfigurationTarget.Global }, 'the new preference is saved for the next session');

  // ---- 4) 变更文件: stash 走专用读取，普通提交仍走 getCommitFiles
  provider.commitFilesGeneration = 0;
  store.setState({ files: [], filesLoading: true });
  await provider.setCommitFiles(stashHash, repoA.path, 0, undefined, false);
  assert.deepEqual(fileReads, [stashHash], 'a stash reads its files with the stash reader');
  assert.deepEqual(commitFileReads, []);
  await provider.setCommitFiles('a'.repeat(40), repoA.path, 0, undefined, false);
  assert.deepEqual(commitFileReads, ['a'.repeat(40)], 'an ordinary commit still uses the commit reader');

  // ---- 5) 动作决策
  // 动作入队后由后台队列执行；等队列排空再断言，而不是依赖 microtask 的碰巧顺序。
  const drain = async () => {
    for (let i = 0; i < 200 && (provider.processingWorkingTreeActions || provider.workingTreeActionQueue.length > 0); i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const run = async () => { await provider.runStashAction(repoA.path, runSection); await drain(); };
  let runSection = 'unstaged';
  const reset = () => { stashCalls.length = 0; dialogs.length = 0; warnings.length = 0; provider.workingTreeActionQueue.length = 0; backendStashImpl = async () => ({ stash: 'x', skippedGitlinks: [] }); };

  // 5a) Unstaged 始终执行 libgit2 KEEP_INDEX | INCLUDE_UNTRACKED（stash -k -u），不弹窗。
  reset(); setSnapshot([], [file('b.txt'), file('u.txt', { isUntracked: true })]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged']]);

  // 5b) Staged 始终执行 staged-only Stash（stash -S），不弹窗。
  reset(); runSection = 'staged'; setSnapshot([file('a.txt')], []);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'staged']]);

  // 5c) 另一个分组有文件时也不跨作用域、不询问。
  reset(); runSection = 'unstaged'; setSnapshot([file('a.txt')], [file('b.txt')]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged']]);
  reset(); runSection = 'staged'; setSnapshot([file('a.txt')], [file('b.txt')]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'staged']]);

  // 5d) 同一文件同时有 staged/unstaged 修改时仍直接交给 staged-only 原生实现处理。
  reset(); runSection = 'staged'; setSnapshot([file('c.txt'), file('a.txt')], [file('c.txt'), file('b.txt')]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'staged']]);

  // 5h) 冲突 -> 拒绝并提示
  runSection = 'unstaged';
  reset(); setSnapshot([file('m.txt', { isConflict: true })], [file('b.txt')]);
  await run();
  assert.deepEqual(stashCalls, []); assert.match(warnings[0], /未解决的合并冲突/);

  // 5i) 两个分组都空 -> 无事发生
  reset(); setSnapshot([], []);
  await run();
  assert.deepEqual(stashCalls, []); assert.equal(dialogs.length, 0);

  // 5j) 子模块条目被跳过时给出提示，stash 仍然成功
  reset(); setSnapshot([], [file('b.txt')]);
  backendStashImpl = async () => ({ stash: 'x', skippedGitlinks: ['sub'] });
  await run();
  assert.ok(warnings.some(w => /子模块变更不会被 stash.*sub/.test(w)), 'skipped gitlinks are reported');

  // 5k) 后端失败 -> 以错误提示呈现，不抛出未处理异常
  reset(); setSnapshot([], [file('b.txt')]);
  backendStashImpl = async () => { throw new Error('boom'); };
  await run();
  assert.ok(warnings.some(w => /ERROR Git 操作失败: boom/.test(w)), 'backend errors surface to the user: ' + JSON.stringify(warnings));

  // 5l) Staged stash 与批量取消暂存直接发布操作语义能确定的缓存补丁，不再同步重扫全部路径。
  reset(); completedMutations.length = 0; cachedSnapshot = { staged: [file('a.txt')], changes: [file('b.txt')] };
  runSection = 'staged'; setSnapshot(cachedSnapshot.staged, cachedSnapshot.changes);
  await run();
  assert.equal(completedMutations.length, 1, 'staged stash completes with an authoritative mutation patch');
  assert.deepEqual(completedMutations[0].changes.staged.map(item => item.path), []);
  assert.deepEqual(completedMutations[0].changes.changes.map(item => item.path), ['b.txt']);
  assert.deepEqual(completedMutations[0].verificationPaths, []);

  completedMutations.length = 0; opCalls.length = 0;
  cachedSnapshot = { staged: [file('a.txt')], changes: [file('b.txt')] };
  await provider.runCommitPanelWorkingTreeAction(repoA.path, 'unstage', 'staged', ['a.txt'], []);
  await drain();
  assert.deepEqual(opCalls, [['unstage', repoA.path, ['a.txt']]]);
  assert.equal(completedMutations.length, 1, 'staged-only unstage completes without a status scan');
  assert.deepEqual(completedMutations[0].changes.staged.map(item => item.path), []);
  assert.deepEqual(completedMutations[0].changes.changes.map(item => item.path).sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(completedMutations[0].verificationPaths, []);
  cachedSnapshot = undefined;

  // ---- 6) 入口白名单：stash 不会被当成 stage/unstage 的默认分支吞掉
  assert.deepEqual(store.dispatch({ type: 'workingTreeAction', action: 'stash', section: 'unstaged' }).map(e => e.action), ['stash']);
  assert.deepEqual(store.dispatch({ type: 'workingTreeAction', action: 'stash', section: 'conflict' }), [], 'conflict section can not be stashed');
  assert.deepEqual(store.dispatch({ type: 'workingTreeAction', action: 'bogus', section: 'unstaged' }), []);
  provider.processWorkingTreeActionQueue = async () => {};
  reset(); setSnapshot([], [file('b.txt')]);
  await provider.runStashAction(repoA.path, 'unstaged');
  assert.equal(provider.workingTreeActionQueue.length, 1);
  assert.equal(provider.workingTreeActionQueue[0].action, 'stash', 'the queued operation is a stash, never the default unstage branch');
  assert.equal(provider.workingTreeActionQueue[0].stashScope, 'unstaged');

  // ---- 7) 右键菜单动作: apply / pop 走工作区队列, drop 确认后直接执行; stash 用 hash 定位
  provider.processWorkingTreeActionQueue = GitkViewProvider.prototype.processWorkingTreeActionQueue;
  const resetOps = () => { opCalls.length = 0; dialogs.length = 0; warnings.length = 0; controllerCalls.length = 0; selected.length = 0; provider.workingTreeActionQueue.length = 0; backendOpImpl = async (operation, hash) => ({ stash: hash, conflicts: false, dropped: operation === 'pop' }); dialogChoice = undefined; };
  const newest = stashEntry(stashHash, 0, 'WIP on main: newest');
  const older = stashEntry('2'.repeat(40), 1, 'On main: older');
  const setStashList = list => { provider.stashesByRepository.set(repoA.path, list); };
  let reloaded = [];
  provider.loadRepositoryStashes = async (path, force) => { reloaded.push([path, force]); };
  stashFilesResult = [{ path: 'stashed.txt', status: 'M', diffKey: 'stashed.txt' }, { path: 'new-name.txt', oldPath: 'old-name.txt', status: 'R', diffKey: 'new-name.txt' }];

  // 7a) 路由: stash 动作进入 runStashCommitAction, 提交类动作对 stash 行不执行, 复制 hash 放行
  const routed = [], ordinaryRuns = [];
  provider.runStashCommitAction = async (...args) => { routed.push(args); };
  provider.gitActions = { runCommitAction: (...args) => { ordinaryRuns.push(args); } };
  setStashList([newest, older]);
  for (const action of ['stashApply', 'stashPop', 'stashDrop']) provider.runEffect({ type: 'commitAction', action, hash: stashHash, repositoryPath: repoA.path });
  assert.deepEqual(routed.map(args => args[0]), ['stashApply', 'stashPop', 'stashDrop']);
  assert.deepEqual(routed.every(args => args[1] === stashHash && args[2] === repoA.path), true);
  provider.runEffect({ type: 'commitAction', action: 'checkout', hash: stashHash, repositoryPath: repoA.path });
  provider.runEffect({ type: 'commitAction', action: 'reset', hash: stashHash, repositoryPath: repoA.path });
  assert.deepEqual(ordinaryRuns, [], 'checkout / reset never run against a stash commit, even from a stale menu message');
  provider.runEffect({ type: 'commitAction', action: 'copyHash', hash: stashHash, repositoryPath: repoA.path });
  provider.runEffect({ type: 'commitAction', action: 'checkout', hash: 'a'.repeat(40), repositoryPath: repoA.path });
  assert.deepEqual(ordinaryRuns.map(args => args[0]), ['copyHash', 'checkout'], 'copy hash works on a stash and ordinary commits are untouched');
  delete provider.runStashCommitAction;

  // 7b) apply / pop 入队, 不弹窗; 队列里是 stashApply / stashPop, 不会落入默认的取消暂存分支
  provider.processWorkingTreeActionQueue = async () => {};
  for (const [action, expected] of [['stashApply', 'stashApply'], ['stashPop', 'stashPop']]) {
    resetOps(); setStashList([newest, older]);
    await provider.runStashCommitAction(action, stashHash, repoA.path);
    assert.equal(dialogs.length, 0, action + ' asks nothing');
    assert.equal(provider.workingTreeActionQueue.length, 1);
    const queued = provider.workingTreeActionQueue[0];
    assert.equal(queued.action, expected);
    assert.equal(queued.stashHash, stashHash, 'targets the stash by hash');
    assert.deepEqual([...queued.paths].sort(), ['new-name.txt', 'old-name.txt', 'stashed.txt'], 'a rename refreshes both the old and the new path');
  }
  // 7c) 条目已不存在: 提示并重读, 不入队
  resetOps(); setStashList([older]); reloaded = [];
  await provider.runStashCommitAction('stashApply', stashHash, repoA.path);
  assert.equal(provider.workingTreeActionQueue.length, 0);
  assert.ok(warnings.some(w => /已不存在/.test(w)));
  assert.deepEqual(reloaded, [[repoA.path, true]]);

  // 7d) 队列执行: apply 保留条目, pop 删除条目; 冲突时给出提示; 条目被 pop 后选中项离开已不存在的 stash
  provider.processWorkingTreeActionQueue = GitkViewProvider.prototype.processWorkingTreeActionQueue;
  const drainQueue = async () => {
    for (let i = 0; i < 200 && (provider.processingWorkingTreeActions || provider.workingTreeActionQueue.length > 0); i++) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };
  const queue = async (action) => { await provider.runStashCommitAction(action, stashHash, repoA.path); await drainQueue(); };
  resetOps(); setStashList([newest, older]); reloaded = [];
  await queue('stashApply');
  assert.deepEqual(opCalls, [['apply', repoA.path, stashHash]]);
  assert.deepEqual(reloaded, [[repoA.path, true]], 'the stash list is re-read after apply');
  assert.deepEqual(selected, [], 'apply keeps the entry, so the selection stays');

  resetOps(); setStashList([newest, older]);
  store.setState({ currentHash: stashHash, currentRepositoryPath: repoA.path });
  const baseCommit = { hash: newest.parents[0], gitBranchOption: heads[repoA.path] };
  provider.commitController.findCommit = (hash) => hash === baseCommit.hash ? baseCommit : undefined;
  await queue('stashPop');
  assert.deepEqual(opCalls, [['pop', repoA.path, stashHash]]);
  assert.deepEqual(selected, [baseCommit], 'popping the selected stash moves the selection to its base commit');

  resetOps(); setStashList([newest, older]);
  store.setState({ currentHash: 'a'.repeat(40), currentRepositoryPath: repoA.path });
  await queue('stashPop');
  assert.deepEqual(selected, [], 'popping a stash that is not selected leaves the selection alone');

  resetOps(); setStashList([newest, older]);
  backendOpImpl = async (operation, hash) => ({ stash: hash, conflicts: true, dropped: false });
  store.setState({ currentHash: stashHash, currentRepositoryPath: repoA.path });
  await queue('stashPop');
  assert.ok(warnings.some(w => /存在冲突.*Stash 条目已保留/.test(w)), 'a conflicting pop explains that the entry is kept: ' + JSON.stringify(warnings));
  assert.deepEqual(selected, [], 'the entry is kept, so the selection stays');

  resetOps(); setStashList([newest, older]);
  backendOpImpl = async () => { throw new Error('index is not clean'); };
  await queue('stashApply');
  assert.ok(warnings.some(w => /ERROR Git 操作失败: index is not clean/.test(w)), 'refusals surface: ' + JSON.stringify(warnings));

  // 7e) drop: 先确认; 取消不动; 确认后按 hash 删除并重读; 选中项离开
  resetOps(); setStashList([newest, older]); dialogChoice = undefined; reloaded = [];
  await provider.runStashCommitAction('stashDrop', stashHash, repoA.path);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /stash@\{0\}.*WIP on main: newest/);
  assert.deepEqual(dialogs[0].items, ['删除']);
  assert.deepEqual(opCalls, [], 'dismissing the dialog drops nothing');

  resetOps(); setStashList([newest, older]); dialogChoice = '删除'; reloaded = [];
  store.setState({ currentHash: stashHash, currentRepositoryPath: repoA.path });
  provider.loadRepositoryStashes = async (path, force) => { reloaded.push([path, force]); setStashList([older]); };
  await provider.runStashCommitAction('stashDrop', stashHash, repoA.path);
  assert.deepEqual(opCalls, [['drop', repoA.path, stashHash]]);
  assert.deepEqual(reloaded, [[repoA.path, true]]);
  assert.deepEqual(selected, [baseCommit], 'dropping the selected stash moves the selection to its base commit');

  resetOps(); setStashList([newest, older]); dialogChoice = '删除'; reloaded = [];
  backendOpImpl = async () => { throw new Error('no stashed state'); };
  provider.loadRepositoryStashes = async (path, force) => { reloaded.push([path, force]); setStashList([older]); };
  await provider.runStashCommitAction('stashDrop', stashHash, repoA.path);
  assert.ok(warnings.some(w => /ERROR Git 操作失败: no stashed state/.test(w)));
  assert.deepEqual(reloaded, [[repoA.path, true]], 'a failed drop still re-reads the list so the cache matches git');

  // Overlapping watcher + explicit refresh requests share I/O, not merely publication.
  const makeLoader = () => Object.assign(Object.create(GitkViewProvider.prototype), {
    stashesByRepository: new Map(), stashLoadingByRepository: new Map(),
    getRepoRootUri: path => vscode.Uri.parse(path),
    commitController: { setStashes: (_path, entries) => loaderPublications.push(entries.map(entry => entry.hash)) },
    schedulePushState() {},
  });
  const loaderPublications = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  let reads = 0;
  stashReadResult = async () => { reads++; return [newest]; };
  const coalesced = makeLoader();
  await Promise.all(Array.from({ length: 8 }, () => coalesced.loadRepositoryStashes(repoA.path, true)));
  assert.equal(reads, 1, 'same-turn duplicate reloads issue one native read');
  assert.deepEqual(loaderPublications, [[newest.hash]]);

  let releaseFirst;
  loaderPublications.length = 0; reads = 0;
  stashReadResult = () => ++reads === 1 ? new Promise(resolve => { releaseFirst = resolve; }) : [older];
  const invalidated = makeLoader();
  const firstLoad = invalidated.loadRepositoryStashes(repoA.path, true);
  await tick();
  const followups = Array.from({ length: 8 }, () => invalidated.loadRepositoryStashes(repoA.path, true));
  releaseFirst([newest]);
  await Promise.all([firstLoad, ...followups]);
  assert.equal(reads, 2, 'invalidations during I/O request exactly one fresh pass');
  assert.deepEqual(loaderPublications, [[older.hash]], 'never publish the invalidated read');

  loaderPublications.length = 0; reads = 0;
  stashReadResult = async () => { if (++reads === 1) throw new Error('read failed'); return [older]; };
  const retry = makeLoader();
  const failures = await Promise.allSettled([retry.loadRepositoryStashes(repoA.path, true), retry.loadRepositoryStashes(repoA.path, true)]);
  assert.ok(failures.every(result => result.status === 'rejected'));
  await retry.loadRepositoryStashes(repoA.path, true);
  assert.equal(reads, 2, 'a failed shared read must not poison later refreshes');

  loaderPublications.length = 0; reads = 0;
  stashReadResult = () => ++reads === 1 ? new Promise(resolve => { releaseFirst = resolve; }) : [older];
  const removed = makeLoader();
  const oldLoad = removed.loadRepositoryStashes(repoA.path, true);
  await tick();
  removed.stashLoadingByRepository.delete(repoA.path);
  removed.stashLoadsInFlight.delete(repoA.path);
  await removed.loadRepositoryStashes(repoA.path, true);
  releaseFirst([newest]);
  await oldLoad;
  assert.deepEqual(loaderPublications, [[older.hash]], 'a removed/re-added repository rejects the previous load');

  console.log('Stash host passed: selection fallback, stateUpdate groups (toggle/search/multi-repo), stash file reader, fixed unstaged/staged native scopes without confirmation dialogs, conflict/empty guards, gitlink notice, error surfacing, queue routing, apply / pop / drop routing, confirmation, selection hand-off.');
})().catch(error => { console.error(error); process.exitCode = 1; });
