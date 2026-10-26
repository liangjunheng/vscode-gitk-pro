const assert = require('node:assert/strict');
const Module = require('node:module');

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const repoEvents = new Emitter(), selectedEvents = new Emitter(), branchEvents = new Emitter(), worktreeEvents = new Emitter();
const repos = Array.from({ length: 9 }, (_, index) => ({ path: 'file:///repo-' + index, label: 'repo-' + index }));
const heads = new Map(repos.map((repository, index) => [repository.path, String(index).repeat(40)]));
const counts = new Map();
let running = 0, maximum = 0, gateResolve;
let gate = new Promise(resolve => { gateResolve = resolve; });
let fail = false, searches = 0, priorityHeads = 0, priorityPages = 0;
const logs = {
  getCurrentGitHeadHash: async uri => heads.get(uri.toString()),
  getGitCommits: async (uri, limit, refs, skip, _progress, signal) => {
    assert.equal(limit, 50); assert.equal(skip, 0);
    const key = uri.toString() + ':' + refs[0]; counts.set(key, (counts.get(key) || 0) + 1);
    running++; maximum = Math.max(maximum, running);
    try {
      await gate;
      if (signal.aborted) throw new Error('aborted');
      if (fail) throw new Error('fixture read failure');
      return Array.from({ length: 50 }, (_, index) => ({ hash: refs[0] + ':' + index, parents: [], refs: [], message: 'commit ' + index }));
    } finally { running--; }
  },
  searchCommits: async () => { searches++; return []; },
};
logs.getCurrentGitHeadHashPriority = async uri => { priorityHeads++; return heads.get(uri.toString()); };
logs.getGitCommitsPriority = async (uri, limit, refs, skip, signal) => { priorityPages++; return logs.getGitCommits(uri, limit, refs, skip, undefined, signal); };
const load = Module._load;
let GitCommitController;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { EventEmitter: Emitter, Uri: { parse: value => ({ toString: () => value }) } };
    if (name === './gitLogProvider') return logs;
    return load.call(this, name, ...args);
  };
  ({ GitCommitController } = require('../out/git/gitCommitController'));
} finally { Module._load = load; }

const branches = () => repos.slice(0, -1).map(repoOption => ({ repoOption, name: 'HEAD', kind: 'current', hash: heads.get(repoOption.path) }));
const controller = new GitCommitController({
  totalRepoList: repos, ontotalRepoListChanged: repoEvents.event, onSelectedRepoListChanged: selectedEvents.event,
}, {
  onSelectedBranchesChanged: branchEvents.event,
}, {
  onEachHeadBranchUncommittedFileChanged: worktreeEvents.event,
  listCurrentHeadBranches: branches,
}, {});
async function settle() {
  for (let i = 0; i < 100 && (controller.firstPageWorkers || controller.pendingFirstPages.size); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.firstPageWorkers, 0, 'prefetch must finish');
}
async function main() {
  let published = 0;
  controller.onSearchedCommitsChanged(() => published++);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, repos.length, 'all repositories must start concurrently before any read finishes');
  assert.equal(controller.pendingFirstPages.size, 0, 'no repository waits for a concurrency slot');
  repoEvents.fire(repos);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, repos.length, 'repeated discovery reuses in-flight pages instead of duplicating reads');
  assert.equal(controller.selectedCommit, undefined);
  assert.equal(controller.isLoading, false, 'prefetch does not put selected UI into loading');
  const shared = controller.readFirstCommitPage(repos[0], heads.get(repos[0].path));
  gateResolve(); await settle(); await shared;
  assert.equal(counts.size, 9, 'all repositories get a first batch by default');
  assert.ok(priorityHeads > 0, 'background HEAD fallback uses the priority native queue');
  assert.ok(priorityPages > 0, 'background first pages use the priority native queue');
  assert.equal(maximum, repos.length);
  assert.equal(published, 0, 'background reads must not publish another repository into selected history');
  const first = await controller.readFirstCommitPage(repos[0], heads.get(repos[0].path));
  first[0].parents.push('modified'); first[0].lane = 5;
  const second = await controller.readFirstCommitPage(repos[0], heads.get(repos[0].path));
  assert.equal(second.length, 50); assert.deepEqual(second[0].parents, []); assert.equal(second[0].lane, undefined);
  assert.equal(counts.get(repos[0].path + ':' + heads.get(repos[0].path)), 1, 'foreground and background share one in-flight request');
  controller.repositories = [repos[0]];
  controller.branchesByRepository = new Map([[repos[0].path, [branches()[0]]]]);
  const page = await controller.readCommits(new Map([[repos[0].path, ['HEAD']]]), [], new AbortController().signal);
  assert.equal(page[0].gitBranchOption.repoOption.path, repos[0].path);
  controller.resetCommitPages(page);
  assert.equal(controller.commitPageOffsetByRepository.get(repos[0].path), 50);
  controller.commitPageByRepository.clear(); controller.commitPageOffsetByRepository.clear();
  const switchedBack = await controller.readCommits(new Map([[repos[0].path, ['HEAD']]]), [], new AbortController().signal);
  assert.equal(switchedBack.length, 50);
  assert.equal(counts.get(repos[0].path + ':' + heads.get(repos[0].path)), 1, 'selection pagination reset must not erase independent cache');
  await controller.readCommits(new Map([[repos[0].path, ['HEAD']]]), ['keyword'], new AbortController().signal);
  assert.equal(searches, 1, 'search must not use a 50-record subset');
  heads.set(repos[0].path, 'f'.repeat(40));
  worktreeEvents.fire({ branch: branches()[0], changes: { staged: [], changes: [] } });
  await settle();
  assert.equal(controller.firstCommitPages.get(repos[0].path).headHash, 'f'.repeat(40));
  fail = true;
  await assert.rejects(controller.readFirstCommitPage(repos[1], 'e'.repeat(40)), /fixture read failure/);
  assert.equal(controller.firstCommitPages.has(repos[1].path), false, 'a failed read must not poison the cache');
  fail = false;
  await controller.readFirstCommitPage(repos[1], 'e'.repeat(40));
  controller.repositories = [repos[0]]; controller.branches = [branches()[0]];
  controller.refresh = async () => {};
  controller.syncWorkingTreeForCurrentBranch = async () => {};
  await controller.forceRefreshCurrentSelection();
  assert.equal(controller.firstCommitPages.has(repos[0].path), false, 'manual refresh invalidates selected cache even when HEAD is unchanged');
  repoEvents.fire(repos.slice(0, 2)); await settle();
  assert.ok([...controller.firstCommitPages.keys()].every(key => repos.slice(0, 2).some(repository => repository.path === key)));
  const cachedBeforeDeselect = controller.firstCommitPages.size;
  controller.branchesController.getSelectedBranchesByRepository = () => new Map();
  controller._isLoading = true; controller.isLoadingMore = true;
  controller.selectedCommitIdentity = { repositoryPath: repos[0].path, hash: 'uncommitted' };
  await controller.selectRepositories([]);
  assert.deepEqual(controller.searchedCommitList, []);
  assert.equal(controller.selectedCommit, undefined);
  assert.equal(controller.isLoading, false); assert.equal(controller.isLoadingMoreCommits, false);
  assert.equal(controller.firstCommitPages.size, cachedBeforeDeselect, 'deselection must not erase prefetched history');
  controller.dispose();
  assert.equal(controller.firstPageAbortController.signal.aborted, true);
  assert.equal(controller.firstCommitPages.size, 0);
  console.log('First-commit-page tests passed: concurrent prefetch for every repository, single flight, selection reuse, graph isolation, search bypass, HEAD invalidation, retry, refresh, removal and disposal.');
}
main().catch(error => { console.error(error); controller.dispose(); process.exitCode = 1; });
