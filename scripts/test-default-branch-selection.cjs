const assert = require('node:assert/strict');
const Module = require('node:module');

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

const repository = { path: 'file:///repo', label: 'repo', equals: other => other.path === 'file:///repo' };
const current = { repoOption: repository, name: 'main', kind: 'current', hash: 'a', equals: other => other === current };
const local = { repoOption: repository, name: 'topic', kind: 'local', hash: 'b', equals: other => other === local };
const remote = { repoOption: repository, name: 'refs/remotes/origin/topic', kind: 'remote', hash: 'b', equals: other => other === remote };
const repoEvents = new Emitter();
const branchEvents = new Emitter();
let branches = [current];
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
  getTotalBranches: () => branches,
  refreshSelectedRepositories: () => {},
});
const selections = [];
controller.onSelectedBranchesChanged(snapshot => selections.push([...snapshot.values()].flat().map(branch => branch.name)));

async function main() {
  repoEvents.fire([repository]);
  assert.deepEqual(selections.at(-1), ['main'], 'the early HEAD-only snapshot is available for the first commit page');

  complete = true;
  branchEvents.fire({ repository, branches, headChanged: false });
  assert.deepEqual(selections.at(-1), ['main'], 'a complete one-branch snapshot keeps the same selection');

  branches = [current, local, remote];
  branchEvents.fire({ repository, branches, headChanged: false });
  assert.deepEqual(selections.at(-1), ['main', 'topic', 'refs/remotes/origin/topic'], 'the completed snapshot defaults to every branch');

  assert.equal(controller.selectBranches([]), true, 'the user can clear the default selection');
  branchEvents.fire({ repository, branches, headChanged: true });
  assert.deepEqual(selections.at(-1), [], 'a user-cleared selection is not defaulted again');
  controller.dispose();
  console.log('Default branch selection tests passed: all refs publish once after the complete snapshot and user selection remains authoritative.');
}
main().catch(error => { controller.dispose(); console.error(error); process.exitCode = 1; });
