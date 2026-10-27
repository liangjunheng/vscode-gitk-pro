const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
const nativeCalls = [];
let priorityResolvedRevision = 'a'.repeat(40);
let priorityCommitDetails = async (_uri, hashes) => hashes.map(hash => ({
  hash, shortHash: hash.slice(0, 8), subject: 'subject ' + hash[0], message: 'subject ' + hash[0],
}));
let priorityRangeCommits = async () => [];
let Provider, DiffReader, CommitFile, DiffPayload, WorkingTreeChanges, store;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { Uri: {
      parse: value => ({ fsPath: value, toString: () => value }),
      file: value => ({ fsPath: value, toString: () => 'file://'+value.replaceAll('\\\\','/') }),
    } };
    if (name === '../git/gitNativeOperations') return {
      commitDetails: async () => { nativeCalls.push('commitDetails'); return []; },
      rangeCommits: async () => { nativeCalls.push('rangeCommits'); return []; },
      resolveRevision: async () => { nativeCalls.push('resolveRevision'); return 'a'.repeat(40); },
      commitDetailsPriority: async (...args) => { nativeCalls.push('commitDetailsPriority'); return priorityCommitDetails(...args); },
      rangeCommitsPriority: async (...args) => { nativeCalls.push('rangeCommitsPriority'); return priorityRangeCommits(...args); },
      resolveRevisionPriority: async () => { nativeCalls.push('resolveRevisionPriority'); return priorityResolvedRevision; },
    };
    return originalLoad.call(this, name, ...args);
  };
  ({ GitkViewProvider: Provider } = require('../out/webview/gitkViewProvider'));
  ({ DiffReader } = require('../out/git/diffReader'));
  ({ CommitFile, DiffPayload, WorkingTreeChanges } = require('../out/types'));
  ({ store } = require('../out/state/store'));
} finally { Module._load = originalLoad; }

function fixture(parentHash = 'uncommitted', kind = 'unstaged') {
  const root = { path: 'file:///root' }, child = { path: 'file:///root/child' };
  const head = { repoOption: child, kind: 'current', hash: 'h'.repeat(40) };
  const parentCommit = { hash: parentHash, gitBranchOption: { repoOption: root } };
  const provider = Object.create(Provider.prototype), calls = [], errors = [];
  let reads = 0, changes = new WorkingTreeChanges({ changes: [new CommitFile({ path: 'edit.ts' })] });
  store.setState({ currentHash: parentHash, currentRepositoryPath: root.path,
    selectedPath: kind + ':child', files: [new CommitFile({ path: 'child', isGitlink: true,
      workingTreeKind: kind, diffKey: kind + ':child', isConflict: kind === 'conflict', gitlinkWorktreeDirty: true })] });
  Object.assign(provider, {
    commitController: { selectedCommit: parentCommit }, gitlinkParentNavigationStack: [],
    repoSubmoduleWatcher: { findSubmoduleRepository: () => child },
    uncommittedFilesWatcher: { listCurrentHeadBranches: () => [head],
      getCachedUncommittedFilesByHeadBranch: () => undefined,
      getUncommittedFilesByHeadBranch: async () => { reads++; return changes; } },
    branchesController: { getCurrentBranch: () => head }, findCommit: () => undefined,
    selectGitlinkRepositoryCommit: async (commit, reveal, update, token, prepared) => {
      assert.equal(token.signal.aborted, false);
      update(); calls.push({ commit, token, prepared });
    },
  });
  return { provider, head, root, child, calls, errors, get reads() { return reads; },
    setChanges(value) { changes = value; } };
}

async function main() {
  const sha = 'a'.repeat(40);
  for (const kind of ['unstaged', 'staged', 'conflict']) {
    const f = fixture('uncommitted', kind);
    await f.provider.selectGitlinkCommit('child/', sha, kind + ':child');
    assert.equal(f.calls[0].commit.hash, sha, kind + ': explicit SHA must not redirect to dirty worktree');
    assert.equal(f.reads, 0, 'commit navigation performs no live status read');
    await f.provider.selectGitlinkCommit('child', 'uncommitted', kind + ':child');
    assert.equal(f.calls[1].commit.hash, 'uncommitted', kind + ': worktree entry uses child state');
    assert.equal(f.reads, 1, 'one child snapshot per worktree navigation');
    assert.equal(f.calls[1].prepared.changes[0].path, 'edit.ts');
    f.setChanges(new WorkingTreeChanges());
    await f.provider.selectGitlinkCommit('child', 'uncommitted');
    assert.equal(f.calls[2].commit.hash, f.head.hash, 'stale worktree button falls back to real HEAD');
  }
  const history = fixture('b'.repeat(40));
  await history.provider.selectGitlinkCommit('child', sha);
  assert.equal(history.calls[0].commit.hash, sha);
  assert.equal(history.reads, 0, 'historical Gitlinks are independent of checkout state');
  await history.provider.selectGitlinkCommit('child', 'uncommitted');
  assert.equal(history.calls.length, 1, 'history cannot request a synthetic worktree target');

  const grouped = fixture();
  store.setState({ files: ['unstaged', 'staged'].map(kind => new CommitFile({ path: 'child', isGitlink: true, diffKey: kind + ':child' })), selectedPath: 'unstaged:child' });
  await grouped.provider.selectGitlinkCommit('child', sha, 'staged:child');
  assert.equal(grouped.provider.gitlinkParentNavigationStack[0].revealPath, 'staged:child');

  const racing = fixture();
  let release;
  racing.provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = () => new Promise(resolve => { release = resolve; });
  const slow = racing.provider.selectGitlinkCommit('child', 'uncommitted');
  await Promise.resolve();
  const obsoleteToken = racing.provider.gitlinkNavigationAbortController;
  await racing.provider.selectGitlinkCommit('child', sha);
  assert.equal(obsoleteToken.signal.aborted, true);
  release(new WorkingTreeChanges({ changes: [new CommitFile({ path: 'late.ts' })] }));
  await slow;
  assert.deepEqual(racing.calls.map(call => call.commit.hash), [sha], 'old navigation cannot run after a newer token replaces it');

  const reader = Object.create(DiffReader.prototype);
  // Exercise the real repository-selection method with the same prepared
  // snapshot and token, rather than relying only on the routing spy above.
  const actual = fixture();
  delete actual.provider.selectGitlinkRepositoryCommit;
  actual.provider.selectCommitPanelRepository = async branch => branch;
  actual.provider.multiDiffPanel = { setParentCommitNavigation() {} };
  actual.provider.schedulePushState = () => {};
  actual.provider.view = { webview: { postMessage() {} } };
  let selected;
  actual.provider.commitController.selectCommit = commit => { selected = commit; return true; };
  await actual.provider.selectGitlinkCommit('child', 'uncommitted');
  assert.equal(actual.reads, 1, 'repository selection must reuse the prepared child snapshot');
  assert.equal(selected.hash, 'uncommitted');
  assert.equal(actual.provider.pendingGitlinkWorktreeSnapshot.changes.changes[0].path, 'edit.ts');
  assert.equal(actual.provider.gitlinkNavigationAbortController, undefined, 'finished request releases its token');
  await actual.provider.selectGitlinkCommit('child', sha);
  assert.equal(selected.hash, sha, 'a later explicit SHA replaces the prepared worktree target');
  assert.equal(actual.provider.pendingGitlinkWorktreeSnapshot, undefined, 'explicit SHA clears worktree snapshot');

  const cancelled = fixture();
  let releaseCancelled;
  cancelled.provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = () => new Promise(resolve => { releaseCancelled = resolve; });
  const abandoned = cancelled.provider.selectGitlinkCommit('child', 'uncommitted');
  await Promise.resolve();
  cancelled.provider.gitlinkNavigationAbortController.abort();
  releaseCancelled(new WorkingTreeChanges());
  await abandoned;
  assert.equal(cancelled.calls.length, 0, 'manual repository focus cancels pending navigation');
  assert.equal(cancelled.provider.gitlinkNavigationAbortController, undefined);

  const initial = new DiffPayload({ path: 'child', diffKey: 'conflict:child', isGitlink: true });
  const metadata = new CommitFile({ path: 'child', diffKey: 'conflict:child',
    gitlinkConflictBaseObjectId: sha, gitlinkConflictCurrentObjectId: 'c'.repeat(40),
    gitlinkConflictIncomingObjectId: 'd'.repeat(40),
    gitlinkConflictIncomingCommit: { hash: 'd'.repeat(40), shortHash: 'ddddddd', subject: 'incoming loaded' } });
  const result = reader.updateGitlinkPayloads([initial], [metadata])[0];
  assert.equal(result.gitlinkConflictIncomingCommit.subject, 'incoming loaded');
  assert.equal(result.gitlinkConflictBaseObjectId, sha);
  const dirtyGitlink = new CommitFile({ path: 'child', isGitlink: true, gitlinkWorktreeDirty: true,
    oldObjectId: sha, newObjectId: sha, oldGitlinkCommit: { hash: sha, shortHash: 'aaaaaaa' },
    newGitlinkCommit: { hash: sha, shortHash: 'aaaaaaa' } });
  const dirtyPayload = reader.updateGitlinkPayloads([new DiffPayload({ path: 'child', isGitlink: true })], [dirtyGitlink])[0];
  assert.equal(dirtyPayload.original, '');
  assert.equal(dirtyPayload.modified, '');

  const nonBlocking = fixture();
  const oldHash = 'b'.repeat(40), newHash = 'c'.repeat(40);
  let releaseStatus, refreshSettled = false;
  nonBlocking.provider.commitFilesGeneration = 7;
  nonBlocking.provider.diffReader = reader;
  nonBlocking.provider.gitBackend = { getWorkingTreeStatus: async () => new WorkingTreeChanges() };
  nonBlocking.provider.uncommittedFilesWatcher.listCurrentHeadBranches = () => [{
    kind: 'current', hash: 'h'.repeat(40),
    repoOption: { path: 'file://' + path.resolve('/root', 'child') },
  }];
  nonBlocking.provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = () =>
    new Promise(resolve => { releaseStatus = resolve; });
  priorityResolvedRevision = newHash;
  priorityRangeCommits = async () => [{ hash: newHash, shortHash: newHash.slice(0, 8), subject: 'range commit', message: 'range commit' }];
  nativeCalls.length = 0;
  const source = new CommitFile({ path: 'child', diffKey: 'unstaged:child', isGitlink: true,
    workingTreeKind: 'unstaged', gitlinkWorktreeDirty: true, gitlinkScanPending: true,
    oldObjectId: oldHash, newObjectId: '0'.repeat(40), status: 'M' });
  store.setState({ currentRepositoryPath: nonBlocking.root.path, files: [new DiffPayload({ ...source, original: '', modified: '' })] });
  const refresh = nonBlocking.provider.refreshGitlinkDiffs(
    { fsPath: '/root', toString: () => nonBlocking.root.path }, [source], 7,
  ).then(() => { refreshSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const metadataFirst = store.getState().files[0];
  assert.equal(metadataFirst.gitlinkScanPending, false, 'commit metadata clears the spinner without waiting for child status');
  assert.equal(metadataFirst.newObjectId, newHash, 'the priority HEAD read supplies the real unstaged gitlink target');
  assert.equal(metadataFirst.gitlinkRangeCommits[0].subject, 'range commit');
  assert.equal(refreshSettled, false, 'the background child status may still be running after metadata is visible');
  assert.ok(nativeCalls.includes('resolveRevisionPriority') && nativeCalls.includes('commitDetailsPriority')
    && nativeCalls.includes('rangeCommitsPriority'), 'Gitlink metadata uses the priority read channel');
  assert.equal(nativeCalls.some(call => ['resolveRevision', 'commitDetails', 'rangeCommits'].includes(call)), false,
    'Gitlink metadata never falls back to the saturated normal read queue');
  releaseStatus(new WorkingTreeChanges({ changes: [new CommitFile({ path: 'late.ts' })] }));
  await refresh;
  assert.equal(store.getState().files[0].gitlinkWorktreeChangeCount, 1, 'child status enriches the already-visible card later');

  const independentCards = fixture('d'.repeat(40));
  independentCards.provider.commitFilesGeneration = 8;
  independentCards.provider.diffReader = reader;
  let releaseSlowMetadata;
  priorityCommitDetails = async (uri, hashes) => {
    if (uri.fsPath.endsWith('slow')) await new Promise(resolve => { releaseSlowMetadata = resolve; });
    return hashes.map(hash => ({ hash, shortHash: hash.slice(0, 8), subject: uri.fsPath, message: uri.fsPath }));
  };
  priorityRangeCommits = async () => [];
  const cardFiles = ['slow', 'fast'].map((filePath, index) => new CommitFile({
    path: filePath, diffKey: filePath, isGitlink: true, gitlinkScanPending: true, status: 'M',
    oldObjectId: String(index + 1).repeat(40), newObjectId: String(index + 2).repeat(40),
  }));
  store.setState({ currentRepositoryPath: independentCards.root.path,
    files: cardFiles.map(file => new DiffPayload({ ...file, original: '', modified: '' })) });
  const independentRefresh = independentCards.provider.refreshGitlinkDiffs(
    { fsPath: '/root', toString: () => independentCards.root.path }, cardFiles, 8,
  );
  await new Promise(resolve => setImmediate(resolve));
  const partiallyLoaded = store.getState().files;
  assert.equal(partiallyLoaded.find(file => file.path === 'fast').gitlinkScanPending, false,
    'a fast Gitlink publishes without waiting for another card');
  assert.equal(partiallyLoaded.find(file => file.path === 'slow').gitlinkScanPending, true,
    'the slow Gitlink keeps only its own spinner');
  independentCards.provider.commitFilesGeneration = 9;
  store.setState({ files: [new DiffPayload({ path: 'new-selection', original: '', modified: '' })] });
  releaseSlowMetadata();
  await independentRefresh;
  assert.deepEqual(store.getState().files.map(file => file.path), ['new-selection'],
    'a slow Gitlink from the old generation cannot overwrite a newer selection');

  const transientMetadata = fixture();
  transientMetadata.provider.gitBackend = {
    getWorkingTreeStatus: async () => new WorkingTreeChanges({
      staged: [new CommitFile({ path: 'staged.cpp' })],
      changes: [new CommitFile({ path: 'staged.cpp' }), new CommitFile({ path: 'unstaged.cpp' })],
    }),
  };
  transientMetadata.provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = async () => new WorkingTreeChanges();
  const transient = new CommitFile({ path: 'child', isGitlink: true, workingTreeKind: 'unstaged',
    gitlinkWorktreeDirty: true, oldObjectId: sha, newObjectId: sha });
  await transientMetadata.provider.refreshGitlinkWorktreeStates({ fsPath: '/root', toString: () => 'file:///root' }, [transient]);
  assert.equal(transient.gitlinkWorktreeDirty, true, 'an empty watcher bootstrap cannot hide a dirty child worktree');
  assert.equal(transient.gitlinkWorktreeChangeCount, 2, 'the card uses the direct child snapshot count');
  console.log('Gitlink navigation: explicit SHA, all worktree groups, clean fallback, card ownership, cancellation and metadata patches passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
