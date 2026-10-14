const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let Provider, DiffReader, CommitFile, DiffPayload, WorkingTreeChanges, store;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { Uri: { parse: value => ({ fsPath: value, toString: () => value }) } };
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
  console.log('Gitlink navigation: explicit SHA, all worktree groups, clean fallback, card ownership, cancellation and metadata patches passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
