const assert = require('node:assert/strict');
const Module = require('node:module');

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

const repository = { path: 'file:///repo', label: 'repo', equals: other => other.path === 'file:///repo' };
const repositoryB = { path: 'file:///repo-b', label: 'repo-b', equals: other => other.path === 'file:///repo-b' };
const current = { repoOption: repository, name: 'main', kind: 'current', hash: 'a', equals: other => other === current };
const currentB = { repoOption: repositoryB, name: 'main-b', kind: 'current', hash: 'b', equals: other => other === currentB };
const local = { repoOption: repository, name: 'topic', kind: 'local', hash: 'b', equals: other => other === local };
const remote = { repoOption: repository, name: 'refs/remotes/origin/topic', kind: 'remote', hash: 'b', equals: other => other === remote };
const detached = { repoOption: repository, name: 'c', kind: 'current', hash: 'c', equals: other => other === detached };
const repoEvents = new Emitter();
const branchEvents = new Emitter();
let branches = [current];
const branchesByRepository = new Map([[repository.path, branches], [repositoryB.path, [currentB]]]);
let complete = false;

const originalLoad = Module._load;
let GitBranchesController;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { EventEmitter: Emitter };
    return originalLoad.call(this, name, ...args);
  };
  ({ GitBranchesController } = require('../out/git/gitBranchesController'));
} finally { Module._load = originalLoad; }

const controller = new GitBranchesController({ onSelectedRepoListChanged: repoEvents.event }, {
  get isLoading() { return false; },
  onRepositoryBranchesChanged: branchEvents.event,
  onBranchesLoadingChanged: new Emitter().event,
  getRepositorySnapshots: () => [],
  isRepositorySnapshotComplete: () => complete,
  getTotalBranches: repositoryOption => branchesByRepository.get(repositoryOption.path) ?? [],
  refreshSelectedRepositories: () => {},
});
const selections = [];
controller.onSelectedBranchesChanged(snapshot => selections.push([...snapshot.values()].flat().map(branch => branch.name)));

async function main() {
  repoEvents.fire([repository]);
  assert.deepEqual(selections.at(-1), ['main'], 'the early HEAD-only snapshot selects only current');

  complete = true;
  branchEvents.fire({ repository, branches, headChanged: false });
  assert.deepEqual(selections.at(-1), ['main'], 'a complete one-branch snapshot keeps the same selection');

  branches = [current, local, remote];
  branchesByRepository.set(repository.path, branches);
  branchEvents.fire({ repository, branches, headChanged: false });
  assert.deepEqual(selections.at(-1), ['main'], 'the complete snapshot keeps only current selected');

  branches = [detached, local, remote];
  branchesByRepository.set(repository.path, branches);
  branchEvents.fire({ repository, branches, headChanged: true });
  assert.deepEqual(selections.at(-1), ['c'], 'detached HEAD replaces the previous current selection');

  assert.equal(controller.selectBranches([local]), true, 'the user can select a non-current branch');
  assert.deepEqual(selections.at(-1), ['topic'], 'the manual branch selection is published');

  // A manual branch choice in one repository must not suppress the default HEAD
  // when the user focuses another repository card.
  repoEvents.fire([repositoryB]);
  assert.deepEqual(selections.at(-1), ['main-b'], 'switching repository cards selects the new repository HEAD');

  // Expanded cards preserve their repository-scoped branch selection when revisited.
  repoEvents.fire([repository]);
  assert.deepEqual(selections.at(-1), ['topic'], 'returning to an expanded repository restores its branch selection');

  // Collapsing a card clears its cache; the next visit starts from the current HEAD.
  controller.clearRepositorySelection(repository.path);
  repoEvents.fire([repositoryB]);
  repoEvents.fire([repository]);
  assert.deepEqual(selections.at(-1), ['c'], 'a collapsed repository resets to its current HEAD');

  // An explicitly empty selection remains authoritative on later snapshots.
  assert.equal(controller.selectBranches([]), true, 'the user can clear the default selection');
  branchEvents.fire({ repository, branches, headChanged: false });
  assert.deepEqual(selections.at(-1), [], 'a user-cleared selection is not defaulted again');
  controller.dispose();
  console.log('Default branch selection tests passed: all refs publish once, user-cleared selection remains authoritative, and switching repositories selects the new repository HEAD.');
}
main().catch(error => { controller.dispose(); console.error(error); process.exitCode = 1; });
