const assert = require('node:assert/strict');
const Module = require('node:module');

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const repoA = { path: 'file:///repo-a', label: 'repo-a', equals: other => other.path === 'file:///repo-a' };
const repoB = { path: 'file:///repo-b', label: 'repo-b', equals: other => other.path === 'file:///repo-b' };
function branch(repoOption, name, kind, hash) {
  const value = { repoOption, name, kind, hash, equals: other => other === value };
  return value;
}
const headA = branch(repoA, 'main', 'current', 'a'.repeat(40));
const topicA = branch(repoA, 'topic', 'local', 'b'.repeat(40));
const otherA = branch(repoA, 'other', 'local', 'c'.repeat(40));
const headB = branch(repoB, 'main', 'current', 'd'.repeat(40));
const topicB = branch(repoB, 'topic', 'local', 'e'.repeat(40));

// 每次读取在发起时领取当时的闸门, 测试可以单独放行某一批读取。
let gate = deferred();
const logs = {
  getCurrentGitHeadHash: async () => undefined,
  getGitCommits: async (_uri, _limit, refs, _skip, _progress, signal) => {
    await gate.promise;
    if (signal.aborted) throw new Error('aborted');
    return [{ hash: refs.join('+') + ':0', parents: [], refs: [], message: 'commit' }];
  },
  searchCommits: async () => [],
};
// getGitCommits 在发起那一刻读取 gate; 上面 await 前的 gate 引用即为本次读取的闸门。

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

const repoEvents = new Emitter();
const branchEvents = new Emitter();
let selected = new Map();
const controller = new GitCommitController({
  totalRepoList: [], ontotalRepoListChanged: new Emitter().event, onSelectedRepoListChanged: repoEvents.event,
}, {
  onSelectedBranchesChanged: branchEvents.event,
  getSelectedBranchesByRepository: () => selected,
  // 本测试模拟用户在分支选择器里点"确认", 不是自动展开默认分支。
  hasManualBranchSelection: true,
}, {
  onEachHeadBranchUncommittedFileChanged: new Emitter().event,
  listCurrentHeadBranches: () => [],
}, {});
controller.syncWorkingTreeForCurrentBranch = async () => {};

const tick = () => new Promise(resolve => setImmediate(resolve));
// 界面据此二选一: overlay 是全屏"正在加载历史提交列表", bar 只是顶部进度条。
const mode = () => !controller.isLoading ? 'idle' : controller.isInPlaceReload ? 'bar' : 'overlay';
async function releaseHeld() {
  const held = gate;
  gate = deferred();
  held.resolve();
  for (let i = 0; i < 100 && controller.isLoading; i++) await tick();
  assert.equal(controller.isLoading, false, 'released reads must finish loading');
}
function confirmBranches(entries) {
  selected = new Map(entries);
  branchEvents.fire(selected);
}

async function main() {
  // 切换仓库: 旧列表不再有参考价值, 允许全屏蒙版。
  selected = new Map([[repoA.path, [headA]]]);
  repoEvents.fire([repoA]);
  await tick();
  assert.equal(mode(), 'overlay', 'switching repository rebuilds the list behind the overlay');
  await releaseHeld();

  // 同一仓库内确认分支选择: 只能是顶部进度条。
  confirmBranches([[repoA.path, [headA, topicA]]]);
  await tick();
  assert.equal(mode(), 'bar', 'confirming branches in the same repository uses the top progress bar');
  await releaseHeld();

  // 在途的手动刷新被新的分支确认接管后, 旧流程收尾不能把呈现方式改回蒙版。
  const forced = controller.forceRefreshCurrentSelection();
  await tick();
  assert.equal(mode(), 'bar', 'manual refresh uses the top progress bar');
  const forcedGate = gate;
  gate = deferred();
  confirmBranches([[repoA.path, [headA, otherA]]]);
  await tick();
  forcedGate.resolve();
  await forced;
  assert.equal(mode(), 'bar', 'a superseded refresh must not turn the new branch load into the overlay');
  await releaseHeld();

  // 切换仓库的重建仍在途时, 同仓库的分支变化继续沿用蒙版, 不在空列表上闪出顶部条。
  selected = new Map([[repoB.path, [headB]]]);
  repoEvents.fire([repoB]);
  await tick();
  assert.equal(mode(), 'overlay');
  confirmBranches([[repoB.path, [headB, topicB]]]);
  await tick();
  assert.equal(mode(), 'overlay', 'a branch change during a repository rebuild keeps the overlay');
  await releaseHeld();

  controller.dispose();
  console.log('Commit loading mode tests passed: repository switch uses the overlay, branch confirmation and manual refresh use the top bar.');
}
main().catch(error => { console.error(error); controller.dispose(); process.exitCode = 1; });