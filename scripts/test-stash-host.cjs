const assert = require('node:assert/strict');
const Module = require('node:module');

// Stash 的宿主侧链路:
//  1) 列表: 选中解析（stash 不在任何提交列表里）、stateUpdate 下发（开关/搜索/多仓库）、变更文件读取走 stash 专用读取。
//  2) 动作: unstaged 只保存该分组路径，重叠 staged 文件先列出确认；staged 保持 -S；覆盖队列与错误处理。
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
let nativeStashReadResult = async () => [];
let nativeCommitDetailsResult = async () => [];
let actualGetStashes;
const stashCalls = [], fileReads = [], commitFileReads = [], warnings = [], dialogs = [], controllerCalls = [], stashOperationWrites = [], stashOperationClears = [], stashCheckpointPaths = [];
const configurationValues = new Map([['showStashes', false]]);
const configurationWrites = [];
let dialogChoice, pendingOperation;
let stashFilesResult = [{ path: 'stashed.txt', status: 'M', diffKey: 'stashed.txt' }];
let backendStashImpl = async () => ({ stash: 'x', skippedGitlinks: [] });
const opCalls = [];
let backendOpImpl = async (operation, hash) => ({ stash: hash, conflicts: false, dropped: operation === 'pop' });
const vscode = {
  EventEmitter: Emitter,
  Uri: { parse: value => ({ toString: () => value, fsPath: value.replace(/^file:\/\//, '') }), file: p => ({ fsPath: p, toString: () => 'file://' + p }) },
  window: {
    showWarningMessage: (message, options, ...items) => {
      if (options && options.modal) {
        dialogs.push({ message, options, items });
        const selectedItem = items.find(item => item && typeof item === 'object' && item.title === dialogChoice);
        return Promise.resolve(selectedItem || dialogChoice);
      }
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
    if (name === './nativeGitBinding') {
      const actual = load.call(this, name, ...args);
      return {
        ...actual,
        invokeNativeGitPriorityRead: async (operation, payload) => operation === 'stashList'
          ? nativeStashReadResult(operation, payload)
          : operation === 'commitDetails'
            ? nativeCommitDetailsResult(operation, payload)
            : actual.invokeNativeGitPriorityRead(operation, payload),
      };
    }
    if (name === '../git/mergeOperation') return {
      readMergeOperation: async () => pendingOperation,
      runMergeOperation: async () => {},
      describeMergeOperation: operation => operation,
      clearStashOperation: async root => { stashOperationClears.push(root.toString()); },
      beginStashOperation: async (root, action, stash, head, paths, checkpointPaths) => {
        stashOperationWrites.push([root.toString(), action, stash, head, [...new Set(paths)].sort(), 'applying']);
        stashCheckpointPaths.push([...new Set(checkpointPaths)].sort());
        return { operationId: '11111111-1111-4111-8111-111111111111', action, stash, head };
      },
      markStashOperationConflicted: async (root, handle, paths) => {
        stashOperationWrites.push([root.toString(), handle.action, handle.stash, handle.head, [...new Set(paths)].sort(), 'conflicted']);
      },
      writeStashOperation: async (root, action, stash, head, paths, phase = 'conflicted') => {
        stashOperationWrites.push([root.toString(), action, stash, head, [...new Set(paths)].sort(), phase]);
      },
    };
    if (name === '../git/gitNativeOperations') return {
      ...load.call(this, name, ...args),
      resolveRevision: async () => heads[repoA.path].hash,
    };
    if (name === '../git/gitLogProvider') {
      const actual = load.call(this, name, ...args);
      actualGetStashes ??= actual.getStashes;
      return {
        ...actual,
        getStashFiles: async (_uri, hash) => { fileReads.push(hash); return stashFilesResult.map(file => ({ ...file })); },
        getStashes: async () => stashReadResult(),
        getCommitFiles: async (_uri, hash) => { commitFileReads.push(hash); return []; },
      };
    }
    return load.call(this, name, ...args);
  };
  ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
  ({ store } = require('../out/state/store'));
} finally { Module._load = load; }

const file = (path, extra = {}) => ({ path, status: 'M', ...extra });

(async () => {
  nativeStashReadResult = async () => { throw new Error('native stash read failed'); };
  await assert.rejects(() => actualGetStashes(vscode.Uri.parse(repoA.path)), /native stash read failed/,
    'a native stash read failure is not converted into an authoritative empty list');
  nativeStashReadResult = async () => [];
  assert.deepEqual(await actualGetStashes(vscode.Uri.parse(repoA.path)), [],
    'a successful empty native result remains an authoritative empty list');
  nativeStashReadResult = async () => { throw new Error('不支持的 libgit2 操作: stashList'); };
  assert.deepEqual(await actualGetStashes(vscode.Uri.parse(repoA.path)), [],
    'an older native module without stashList keeps the compatibility fallback');

  // 每条 stash 带上基线提交的改写身份; 读取基线信息失败只影响定位, 不影响 stash 列表。
  const nativeBase = 'b'.repeat(40);
  nativeStashReadResult = async () => [{ hash: '1'.repeat(40), shortHash: '11111111', parents: [nativeBase, 'c'.repeat(40)], author: 'me', committer: 'me',
    authorDate: '2026-10-28T10:00:00+08:00', message: 'WIP on main: base', refs: [], stashIndex: 0, stashRef: 'stash@{0}' }];
  let detailRequests = [];
  nativeCommitDetailsResult = async (_operation, payload) => { detailRequests.push(payload.hashes); return [{ hash: nativeBase,
    message: 'base subject\n\nbody\n', author: 'me', authorEmail: 'me@example.com', authorDate: '2026-10-28T09:00:00+08:00' }]; };
  const withIdentity = await actualGetStashes(vscode.Uri.parse(repoA.path));
  assert.deepEqual(detailRequests, [[nativeBase]], 'only the base commit of each stash is read');
  assert.equal(withIdentity[0].stashBaseIdentity,
    JSON.stringify(['me', 'me@example.com', '2026-10-28T09:00:00+08:00', 'base subject\n\nbody\n']));
  nativeCommitDetailsResult = async () => { throw new Error('details failed'); };
  const withoutIdentity = await actualGetStashes(vscode.Uri.parse(repoA.path));
  assert.equal(withoutIdentity.length, 1, 'a failed base-detail read keeps the stash list');
  assert.equal(withoutIdentity[0].stashBaseIdentity, undefined);
  nativeStashReadResult = async () => [];
  nativeCommitDetailsResult = async () => [];

  const provider = Object.create(GitkViewProvider.prototype);
  let published;
  const selected = [];
  let snapshot = { staged: [], changes: [] };
  let cachedSnapshot;
  const completedMutations = [];
  const endedMutations = [];
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
    mergeOperations: new Map(), mergeOperationBusy: new Set(), mergeOperationReads: new Map(),
    loadRepositorySyncState: async () => {}, loadRepositoryStashes: async () => {},
    schedulePushState: () => {}, commitPanel: { isVisible: () => false, update() {} },
    repoSubmoduleWatcher: { findSubmoduleRepository: () => undefined, getRepositoryAncestry: () => [] },
    commitPanelViewTitleController: { update() {} },
    branchesController: { getCurrentBranch: repo => heads[repo.path], clearRepositorySelection() {} },
    getRepoRootUri: path => vscode.Uri.parse(path),
    gitBackend: {
      stash: async (root, scope, paths, mergeStagedIntoUnstaged, allUnstagedPaths) => {
        stashCalls.push([root.toString(), scope, paths ? [...paths] : undefined,
          Boolean(mergeStagedIntoUnstaged), Boolean(allUnstagedPaths)]);
        return backendStashImpl(root, scope, paths, mergeStagedIntoUnstaged, allUnstagedPaths);
      },
      stashApply: async (root, hash) => { assert.equal(provider.mergeOperationBusy.has(root.toString()), true); opCalls.push(['apply', root.toString(), hash]); return backendOpImpl('apply', hash); },
      stashRestorePaths: async (root, hash, paths) => { opCalls.push(['restore', root.toString(), hash, [...paths]]); },
      stashPop: async (root, hash) => { assert.equal(provider.mergeOperationBusy.has(root.toString()), true); opCalls.push(['pop', root.toString(), hash]); return backendOpImpl('pop', hash); },
      stashDrop: async (root, hash) => { opCalls.push(['drop', root.toString(), hash]); return backendOpImpl('drop', hash); },
      getWorkingTreeStatus: async () => snapshot,
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
      beginWorkingTreeMutation() {},
      endWorkingTreeMutation: async (_branch, paths, fullRefresh, waitForRefresh) => {
        if (opCalls.at(-1)?.[0] === 'apply' || opCalls.at(-1)?.[0] === 'pop') assert.equal(provider.mergeOperationBusy.has(repoA.path), true);
        endedMutations.push({ paths: [...paths], fullRefresh, waitForRefresh });
      },
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
    store.setState({
      stagedFiles: staged,
      unstagedFiles: changes,
      commitRepositories: [{ repositoryPath: repoA.path, staged, unstaged: changes }],
    });
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
  const compiledRepositoryChanges = require('node:fs').readFileSync(require.resolve('../out/webview/repositoryChangesSubPanel'), 'utf8');
  assert.match(compiledRepositoryChanges, /stashSnapshot\s*\?\s*['"]贮藏变更['"]/, 'a repository card names a selected stash section 贮藏变更');
  assert.match(compiledRepositoryChanges, /repoChangesIcon\(['"]restoreStash['"],\s*['"]discard['"],\s*['"]还原全部贮藏变更['"]\)/, 'a stash section has a restore-all action');
  assert.match(compiledRepositoryChanges, /repoChangesIcon\(['"]restoreStash['"],\s*['"]discard['"],\s*['"]还原贮藏['"]\)/, 'every stash file has a restore action');
  assert.match(compiledRepositoryChanges, /restore\.innerHTML[^;]+还原贮藏/, 'the stash file context menu exposes 还原贮藏');
  assert.match(compiledProvider, /isStash:\s*selectedCommitMetadata\.isStash\s*===\s*true/, 'selected stash identity is published to repository cards');

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
  const reset = () => { stashCalls.length = 0; dialogs.length = 0; warnings.length = 0; dialogChoice = undefined; provider.workingTreeActionQueue.length = 0; backendStashImpl = async () => ({ stash: 'x', skippedGitlinks: [] }); };

  // 5a) Unstaged 分组始终把该分组精确路径传给原生后端，不夹带 staged 文件。
  reset(); setSnapshot([], [file('b.txt'), file('u.txt', { isUntracked: true })]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged', ['b.txt', 'u.txt'], false, true]]);

  // 5b) Staged 始终执行 staged-only Stash（stash -S），不弹窗。
  reset(); runSection = 'staged'; setSnapshot([file('a.txt')], []);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'staged', ['a.txt'], false, false]]);

  // 5b-file) 单文件 stash 只把按钮所在路径传给原生后端，不受多选集影响。
  reset(); runSection = 'unstaged'; setSnapshot([file('a.txt')], [file('b.txt'), file('c.txt')]);
  await provider.runStashAction(repoA.path, 'unstaged', ['b.txt']); await drain();
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged', ['b.txt'], false, false]]);
  let routedStash;
  const originalRunStashAction = provider.runStashAction;
  provider.runStashAction = async (...args) => { routedStash = args; };
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repoA.path, action: 'stash', section: 'unstaged', path: 'b.txt', paths: ['b.txt', 'c.txt'] });
  assert.deepEqual(routedStash, [repoA.path, 'unstaged', ['b.txt', 'c.txt']], 'repository-card stash keeps the current multi-selection');
  routedStash = undefined;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repoA.path, action: 'stash', section: 'unstaged', paths: ['b.txt', 'c.txt'] });
  assert.deepEqual(routedStash, [repoA.path, 'unstaged', ['b.txt', 'c.txt']], 'right-click stash uses the selected paths even without a clicked path');
  provider.runStashAction = originalRunStashAction;

  // 5c) 两组路径不重叠时不询问，unstaged 只传自己的文件。
  reset(); runSection = 'unstaged'; setSnapshot([file('a.txt')], [file('b.txt')]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged', ['b.txt'], false, true]]);
  reset(); runSection = 'staged'; setSnapshot([file('a.txt')], [file('b.txt')]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'staged', ['a.txt'], false, false]]);

  // 5d) Unstaged 与 staged 同文件时，弹窗完整列出多个文件；确认后只把内容合入 unstaged 快照，不改变 Staged 分组。
  reset(); runSection = 'unstaged';
  setSnapshot([file('c.txt'), file('a.txt'), file('d.txt')], [file('c.txt'), file('b.txt'), file('d.txt')]);
  // 当前选中虚拟行投影可以滞后；弹窗必须以 Repository Changes 正在显示的发布快照为准。
  store.setState({ stagedFiles: [], unstagedFiles: snapshot.changes });
  dialogChoice = '合并修改并贮藏';
  await run();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].message, '确认贮藏未暂存修改冲突方案');
  assert.match(dialogs[0].options.detail, /仓库：a[\s\S]*以下 2 个文件同时包含已暂存和未暂存的修改：[\s\S]*• c\.txt[\s\S]*• d\.txt[\s\S]*请选择本次贮藏方式：[\s\S]*仅贮藏未暂存修改：只保存未暂存差异，已暂存内容不会进入贮藏。[\s\S]*合并修改并贮藏：保存这些文件的完整修改，包括已暂存和未暂存内容。[\s\S]*无论选择哪一种方式，当前暂存区都保持不变。/);
  assert.deepEqual(dialogs[0].items, [
    { title: '合并修改并贮藏' },
    { title: '仅贮藏未暂存修改' },
    { title: '取消', isCloseAffordance: true },
  ], "the Chinese close affordance replaces VS Code default Cancel button");
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged', ['c.txt', 'b.txt', 'd.txt'], true, true]]);

  // 选择仅 Stash Unstaged 时继续操作，但不合入 staged 修改。
  reset(); setSnapshot([file('c.txt')], [file('c.txt'), file('b.txt')]);
  dialogChoice = '仅贮藏未暂存修改';
  await run();
  assert.deepEqual(stashCalls, [[repoA.path, 'unstaged', ['c.txt', 'b.txt'], false, true]]);

  // 取消确认时不执行 stash。
  reset(); setSnapshot([file('c.txt')], [file('c.txt'), file('b.txt')]);
  dialogChoice = '取消';
  await run();
  assert.deepEqual(stashCalls, []);
  // Staged 分组仍由 staged-only 原生实现处理，不弹交叉分组确认。
  reset(); runSection = 'staged'; setSnapshot([file('c.txt'), file('a.txt')], [file('c.txt'), file('b.txt')]);
  await run();
  assert.equal(dialogs.length, 0);
  assert.deepEqual(stashCalls, [[repoA.path, 'staged', ['c.txt', 'a.txt'], false, false]]);

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

  // 5m) Git-compatible no-op success must not project files away.
  reset(); completedMutations.length = 0;
  cachedSnapshot = { staged: [file('a.txt')], changes: [file('b.txt')] };
  runSection = 'staged'; setSnapshot(cachedSnapshot.staged, cachedSnapshot.changes);
  backendStashImpl = async () => ({ stash: '', created: false, skippedGitlinks: [] });
  await run();
  assert.equal(completedMutations.length, 0, 'no-op stash publishes no mutation projection');
  assert.deepEqual(store.getState().stagedFiles.map(item => item.path), ['a.txt']);
  assert.deepEqual(store.getState().unstagedFiles.map(item => item.path), ['b.txt']);

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
  const resetOps = () => { opCalls.length = 0; dialogs.length = 0; warnings.length = 0; controllerCalls.length = 0; selected.length = 0; endedMutations.length = 0; stashOperationWrites.length = 0; stashOperationClears.length = 0; stashCheckpointPaths.length = 0; provider.mergeOperations.clear(); provider.mergeOperationBusy.clear(); provider.workingTreeActionQueue.length = 0; backendOpImpl = async (operation, hash) => ({ stash: hash, conflicts: false, dropped: operation === 'pop' }); snapshot = { staged: [], changes: [] }; dialogChoice = undefined; pendingOperation = undefined; };
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

  // 7b) 仓库卡片的贮藏还原支持行按钮、右键菜单与多选路径。
  let routedRestore;
  const originalRunStashRestorePaths = provider.runStashRestorePaths;
  provider.runStashRestorePaths = async (...args) => { routedRestore = args; };
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repoA.path, action: 'restoreStash', hash: stashHash, paths: ['stashed.txt', 'new-name.txt'] });
  assert.deepEqual(routedRestore, [stashHash, repoA.path, ['stashed.txt', 'new-name.txt']], 'repository-card stash restore preserves the selected files');
  provider.runStashRestorePaths = originalRunStashRestorePaths;
  provider.processWorkingTreeActionQueue = async () => {};
  resetOps(); setStashList([newest, older]);
  await provider.runStashRestorePaths(stashHash, repoA.path, ['new-name.txt']);
  assert.equal(provider.workingTreeActionQueue.length, 1);
  assert.equal(provider.workingTreeActionQueue[0].action, 'stashRestore');
  assert.deepEqual(provider.workingTreeActionQueue[0].paths.sort(), ['new-name.txt', 'old-name.txt'], 'renamed stash files restore both path sides');

  // 7c) apply / pop 入队, 不弹窗; 队列里是 stashApply / stashPop, 不会落入默认的取消暂存分支
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
  resetOps(); setStashList([newest, older]); pendingOperation = 'stash-pop';
  await provider.runStashCommitAction('stashApply', stashHash, repoA.path);
  assert.equal(provider.workingTreeActionQueue.length, 0, 'a persisted conflict operation blocks another Apply/Pop');
  assert.ok(warnings.some(w => /完成或中止.*stash-pop/.test(w)));

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
  await provider.runStashRestorePaths(stashHash, repoA.path, ['stashed.txt']); await drainQueue();
  assert.deepEqual(opCalls, [['restore', repoA.path, stashHash, ['stashed.txt']]], 'selected stash files are restored without applying or deleting the whole stash');

  resetOps(); setStashList([newest, older]); reloaded = [];
  await queue('stashApply');
  assert.deepEqual(opCalls, [['apply', repoA.path, stashHash]]);
  assert.deepEqual(stashOperationWrites, [[repoA.path, 'stash-apply', stashHash, heads[repoA.path].hash, ['new-name.txt', 'old-name.txt', 'stashed.txt'], 'applying']], 'Apply records recovery state before native execution');
  assert.deepEqual(stashOperationClears, [repoA.path], 'a clean Apply clears its recovery state');
  assert.deepEqual(stashCheckpointPaths, [['new-name.txt', 'old-name.txt', 'stashed.txt']], 'the checkpoint covers every Stash path');
  assert.deepEqual(reloaded, [[repoA.path, true]], 'the stash list is re-read after apply');
  assert.deepEqual(selected, [], 'apply keeps the entry, so the selection stays');
  assert.equal(provider.mergeOperationBusy.has(repoA.path), false, 'Apply unlocks merge controls after completion');

  resetOps(); setStashList([newest, older]);
  setSnapshot([], [file('unrelated-local.txt')]);
  await queue('stashApply');
  assert.deepEqual(opCalls, [['apply', repoA.path, stashHash]], 'non-overlapping local changes do not block Apply');
  assert.deepEqual(stashCheckpointPaths, [['new-name.txt', 'old-name.txt', 'stashed.txt', 'unrelated-local.txt']], 'the checkpoint also captures unrelated dirty paths that could enter a moved-base conflict');

  resetOps(); setStashList([newest, older]);
  store.setState({ currentHash: stashHash, currentRepositoryPath: repoA.path });
  const baseCommit = { hash: newest.parents[0], gitBranchOption: heads[repoA.path] };
  provider.commitController.findCommit = (hash) => hash === baseCommit.hash ? baseCommit : undefined;
  await queue('stashPop');
  assert.deepEqual(opCalls, [['pop', repoA.path, stashHash]]);
  assert.deepEqual(stashOperationWrites, [[repoA.path, 'stash-pop', stashHash, heads[repoA.path].hash, ['new-name.txt', 'old-name.txt', 'stashed.txt'], 'applying']], 'Pop records recovery state before native execution');
  assert.deepEqual(stashOperationClears, [repoA.path], 'a clean Pop clears its recovery state');
  assert.deepEqual(selected, [baseCommit], 'popping the selected stash moves the selection to its base commit');

  resetOps(); setStashList([newest, older]);
  store.setState({ currentHash: 'a'.repeat(40), currentRepositoryPath: repoA.path });
  await queue('stashPop');
  assert.deepEqual(selected, [], 'popping a stash that is not selected leaves the selection alone');

  resetOps(); setStashList([newest, older]);
  backendOpImpl = async (operation, hash) => {
    setSnapshot([file('conflict.txt', { isConflict: true })], [file('conflict.txt', { isConflict: true })]);
    return { stash: hash, conflicts: true, dropped: false };
  };
  store.setState({ currentHash: stashHash, currentRepositoryPath: repoA.path });
  await queue('stashPop');
  assert.ok(warnings.some(w => /存在冲突.*点击 √.*点击 ×/.test(w)), 'a conflicting pop explains the finish and abort actions: ' + JSON.stringify(warnings));
  assert.deepEqual(stashOperationWrites, [[repoA.path, 'stash-pop', stashHash, heads[repoA.path].hash, ['new-name.txt', 'old-name.txt', 'stashed.txt'], 'applying'], [repoA.path, 'stash-pop', stashHash, heads[repoA.path].hash, ['conflict.txt', 'new-name.txt', 'old-name.txt', 'stashed.txt'], 'conflicted']], 'a conflicting pop records intent first, then persists exact rollback paths');
  assert.equal(provider.mergeOperations.get(repoA.path), 'stash-pop');
  assert.deepEqual(stashOperationClears, [], 'a conflict keeps its recovery state');
  assert.deepEqual(selected, [], 'the entry is kept until the persisted Pop is completed');

  resetOps(); setStashList([newest, older]);
  backendOpImpl = async () => {
    setSnapshot([file('conflict.txt', { isConflict: true })], [file('conflict.txt', { isConflict: true })]);
    throw new Error('native conflict');
  };
  await queue('stashApply');
  assert.deepEqual(stashOperationWrites, [[repoA.path, 'stash-apply', stashHash, heads[repoA.path].hash, ['new-name.txt', 'old-name.txt', 'stashed.txt'], 'applying']], 'a thrown error never upgrades itself to a confirmed conflict');
  assert.deepEqual(stashOperationClears, [], 'an uncertain thrown conflict keeps the non-actionable applying record');
  assert.equal(provider.mergeOperations.has(repoA.path), false, 'uncertain conflicts are not exposed as continuable operations');
  assert.ok(warnings.some(w => /异常退出后留下了冲突.*执行结果尚未确认/.test(w)), 'the uncertain state is explained');
  assert.ok(warnings.some(w => /ERROR Git 操作失败: native conflict/.test(w)), 'the native error is still surfaced');

  resetOps(); setStashList([newest, older]);
  setSnapshot([file('existing.txt', { isConflict: true })], [file('existing.txt', { isConflict: true })]);
  await queue('stashApply');
  assert.deepEqual(opCalls, [], 'pre-existing conflicts stop before native Apply');
  assert.deepEqual(stashOperationWrites, [], 'pre-existing conflicts never create an applying marker');
  assert.ok(warnings.some(w => /存在未解决的冲突，不能应用 Stash/.test(w)));

  resetOps(); setStashList([newest, older]);
  setSnapshot([], [file('stashed.txt')]);
  await queue('stashApply');
  assert.deepEqual(opCalls, [], 'overlapping local modifications stop before native Apply');
  assert.deepEqual(stashOperationWrites, [], 'overlap refusal never creates an applying marker');
  assert.ok(warnings.some(w => /Stash 路径已有本地修改.*stashed.txt/.test(w)));

  resetOps(); setStashList([newest, older]);
  setSnapshot([file('stashed.txt')], [file('stashed.txt')]);
  await queue('stashApply');
  assert.deepEqual(opCalls, [], 'a staged path that also has unstaged edits still stops before native Apply');

  resetOps(); setStashList([newest, older]);
  setSnapshot([file('stashed.txt')], []);
  await queue('stashApply');
  assert.deepEqual(opCalls, [['apply', repoA.path, stashHash]], 'a staged-only Stash path is merged by Git instead of being refused');
  assert.deepEqual(stashCheckpointPaths, [['new-name.txt', 'old-name.txt', 'stashed.txt']], 'the checkpoint captures the staged pre-state for Abort');

  for (const [action, nativeAction, mergeAction] of [['stashApply', 'apply', 'stash-apply'], ['stashPop', 'pop', 'stash-pop']]) {
    resetOps(); setStashList([newest, older]);
    setSnapshot([file('stashed.txt')], []);
    backendOpImpl = async (_operation, hash) => {
      setSnapshot([file('stashed.txt', { isConflict: true })], [file('stashed.txt', { isConflict: true })]);
      return { stash: hash, conflicts: true, dropped: false };
    };
    await queue(action);
    assert.deepEqual(opCalls, [[nativeAction, repoA.path, stashHash]], 'staged-only conflicts reach native Apply/Pop');
    assert.equal(provider.mergeOperations.get(repoA.path), mergeAction, 'staged-only conflicts publish Merge Changes');
    assert.deepEqual(stashOperationClears, [], 'conflicting Apply/Pop keeps its checkpoint');
    assert.ok(warnings.some(w => /存在冲突.*点击 √.*点击 ×/.test(w)));
  }

  resetOps(); setStashList([newest, older]);
  setSnapshot([], [file('stashed.txt', { isUntracked: true })]);
  await queue('stashPop');
  assert.deepEqual(opCalls, [], 'overlapping untracked files still block Pop');

  resetOps(); setStashList([newest, older]);
  setSnapshot([], [file('stashed.txt/nested-local.txt')]);
  await queue('stashApply');
  assert.deepEqual(opCalls, [], 'a nested local path overlapping a Stash file stops before native Apply');
  assert.deepEqual(stashOperationWrites, [], 'path-prefix overlap never creates an applying marker');
  assert.ok(warnings.some(w => /Stash 路径已有本地修改.*nested-local.txt/.test(w)));

  if (process.platform === 'win32') {
    resetOps(); setStashList([newest, older]);
    setSnapshot([], [file('STASHED.TXT')]);
    await queue('stashApply');
    assert.deepEqual(opCalls, [], 'Windows path overlap is case-insensitive');
    assert.deepEqual(stashOperationWrites, []);
  }

  resetOps(); setStashList([newest, older]);
  backendOpImpl = async () => { throw new Error('index is not clean'); };
  setSnapshot([], []);
  await queue('stashApply');
  assert.deepEqual(stashOperationWrites, [[repoA.path, 'stash-apply', stashHash, heads[repoA.path].hash, ['new-name.txt', 'old-name.txt', 'stashed.txt'], 'applying']], 'a refusal still has a pre-operation recovery record');
  assert.deepEqual(stashOperationClears, [repoA.path], 'a refusal without conflicts clears the recovery record');
  assert.ok(warnings.some(w => /ERROR Git 操作失败: index is not clean/.test(w)), 'refusals surface: ' + JSON.stringify(warnings));
  assert.equal(endedMutations.at(-1)?.waitForRefresh, false, 'apply refusal releases the UI before the background path refresh finishes');

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
  retry.stashesByRepository.set(repoA.path, [newest]);
  const failures = await Promise.allSettled([retry.loadRepositoryStashes(repoA.path, true), retry.loadRepositoryStashes(repoA.path, true)]);
  assert.ok(failures.every(result => result.status === 'fulfilled'), 'a failed refresh is absorbed after preserving the cache');
  assert.deepEqual(retry.stashesByRepository.get(repoA.path).map(entry => entry.hash), [newest.hash],
    'a failed read keeps the last known stash list');
  assert.deepEqual(loaderPublications, [], 'a failed read never publishes an empty list');
  await retry.loadRepositoryStashes(repoA.path, true);
  assert.equal(reads, 2, 'a failed shared read must not poison later refreshes');
  assert.deepEqual(retry.stashesByRepository.get(repoA.path).map(entry => entry.hash), [older.hash],
    'the next successful refresh replaces the preserved cache');
  assert.deepEqual(loaderPublications, [[older.hash]]);
  stashReadResult = async () => { reads++; return []; };
  await retry.loadRepositoryStashes(repoA.path, true);
  assert.deepEqual(retry.stashesByRepository.get(repoA.path), [], 'a successful empty read still clears the cache');
  assert.deepEqual(loaderPublications.at(-1), [], 'the confirmed empty list is published to the controller');

  loaderPublications.length = 0; reads = 0;
  stashReadResult = async () => { reads++; throw new Error('persistent read failure'); };
  const passiveRetry = makeLoader();
  await passiveRetry.loadRepositoryStashes(repoA.path);
  await passiveRetry.loadRepositoryStashes(repoA.path);
  assert.equal(reads, 1, 'passive state publishes do not retry a failed first stash read');
  assert.equal(passiveRetry.stashesByRepository.has(repoA.path), false, 'a failed first read is not cached as an empty list');
  stashReadResult = async () => { reads++; return [older]; };
  await passiveRetry.loadRepositoryStashes(repoA.path, true);
  assert.equal(reads, 2, 'an explicit or watcher refresh still retries after a failure');
  assert.deepEqual(passiveRetry.stashesByRepository.get(repoA.path).map(entry => entry.hash), [older.hash]);

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

  console.log('Stash host passed: selection fallback, stateUpdate groups (toggle/search/multi-repo), stash file reader, unstaged-only path routing with multi-file overlap confirmation and staged-only exact-path routing, conflict/empty guards, gitlink notice, error surfacing, queue routing, apply / pop / drop routing, confirmation, selection hand-off.');
})().catch(error => { console.error(error); process.exitCode = 1; });
