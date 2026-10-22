const assert = require('node:assert/strict');
const Module = require('node:module');

// Stash 穿插进提交图: 用真实的 GitCommitController 验证
//  - stash 作为单一父提交(基线)的一行, 放在第一条等于基线的提交之前, 并带上正确的泳道;
//  - 基线未加载的 stash 不进图, 计入 hiddenStashCount;
//  - 开关/搜索关闭它; 缓存页只存真实提交 (分页偏移不被 stash 污染); 默认选中的是真实提交。
class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const repo = { path: 'file:///repo-a', label: 'repo-a' };
const other = { path: 'file:///repo-b', label: 'repo-b' };
const h = ch => ch.repeat(40);
// 线性历史 (最新在前): c4 -> c3 -> c2 -> c1
const linear = [['4', '3'], ['3', '2'], ['2', '1'], ['1', null]].map(([hash, parent]) => ({
  hash: h(hash), shortHash: hash.repeat(8), parents: parent ? [h(parent)] : [], refs: [], message: 'c' + hash, rawMessage: 'c' + hash, author: 'me', authorDate: '2026-10-21T10:00:00+08:00',
}));
const logs = {
  getCurrentGitHeadHash: async () => h('4'),
  getGitCommits: async (_uri, _limit, _refs, skip) => (skip === 0 ? linear.map(c => ({ ...c, parents: [...c.parents] })) : []),
  searchCommits: async () => linear.slice(0, 1).map(c => ({ ...c })),
};
const load = Module._load;
let GitCommitController;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { EventEmitter: Emitter, Uri: { parse: value => ({ toString: () => value, fsPath: value }) } };
    if (name === './gitLogProvider') return logs;
    return load.call(this, name, ...args);
  };
  ({ GitCommitController } = require('../out/git/gitCommitController'));
} finally { Module._load = load; }

const branch = (repoOption, hash) => ({ repoOption, name: 'refs/heads/main', label: 'main', kind: 'current', hash });
const makeController = () => new GitCommitController(
  { totalRepoList: [repo, other], ontotalRepoListChanged: new Emitter().event, onSelectedRepoListChanged: new Emitter().event },
  { onSelectedBranchesChanged: new Emitter().event, getSelectedBranchesByRepository: () => new Map() },
  { onEachHeadBranchUncommittedFileChanged: new Emitter().event, listCurrentHeadBranches: () => [] },
  {},
);
// 控制器默认不显示 stash(开关默认不选中); 其余用例关心的是穿插逻辑, 所以统一显式打开。
const make = () => { const controller = makeController(); controller.setStashesVisible(true); return controller; };
const stash = (hash, base, index) => ({ hash: h(hash), shortHash: hash.repeat(8), parents: [h(base), h('a'), h('b')], refs: [], message: 'WIP on main: s' + index,
  rawMessage: 'WIP on main: s' + index, author: 'me', authorDate: '2026-10-21T11:00:00+08:00', isStash: true, stashRef: 'stash@{' + index + '}', stashIndex: index });

async function prime(controller, repository) {
  // 与 refresh 的最后一步等价: 读出提交 -> 缓存分页 -> 建图
  controller.repositories = [repository];
  controller.branchesByRepository = new Map([[repository.path, [branch(repository, h('4'))]]]);
  controller.branches = [branch(repository, h('4'))];
  const page = await controller.readCommits(new Map([[repository.path, ['refs/heads/main']]]), [], new AbortController().signal);
  controller.searched = page;
  controller.resetCommitPages(page);
  return page;
}
const rows = controller => controller.searchedCommitList.map(c => (c.isStash ? 'stash:' + c.stashRef : 'c' + c.hash[0]));

(async () => {
  // 0) 默认不显示: 即使宿主已经把 stash 列表推进来, 图里也没有 stash 行, 也不计入“未加载”数量;
  //    打开开关后才出现, 关闭后消失。
  {
    const controller = makeController();
    assert.equal(controller.stashesVisible, false, 'stashes are hidden by default');
    await prime(controller, repo);
    controller.setStashes(repo.path, [stash('5', '2', 0), stash('9', 'f', 1)]);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'c2', 'c1'], 'no stash row by default');
    assert.equal(controller.hiddenStashCounts.get(repo.path), undefined, 'and nothing is reported as hidden while the toggle is off');
    assert.equal(controller.setStashesVisible(true), true);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'stash:stash@{0}', 'c2', 'c1'], 'turning the toggle on shows the loaded stash');
    assert.equal(controller.hiddenStashCounts.get(repo.path), 1, 'and now the stash without a loaded base is counted');
    controller.setStashesVisible(false);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'c2', 'c1'], 'turning it off hides them again');
  }

  // 1) 穿插: stash 在其基线 c2 之上
  {
    const controller = make();
    await prime(controller, repo);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'c2', 'c1'], 'no stash yet');
    assert.equal(controller.setStashes(repo.path, [stash('5', '2', 0)]), true, 'adding a stash rebuilds the graph');
    assert.deepEqual(rows(controller), ['c4', 'c3', 'stash:stash@{0}', 'c2', 'c1'], 'the stash sits right above its base commit');
    const list = controller.searchedCommitList;
    const s = list.find(c => c.isStash);
    assert.deepEqual(s.parents, [h('2')], 'only the base survives as a parent; index / untracked helper parents are not history');
    assert.deepEqual(s.refs, []);
    assert.equal(s.gitBranchOption.repoOption.path, repo.path, 'it belongs to the repository like any commit');

    // 泳道: stash 不是侧枝, 不占泳道: 它是基线所在泳道上的一颗珠子 (同一列, 不开新泳道, 不分配颜色)
    const base = list.find(c => c.hash === h('2'));
    assert.equal(s.laneStartsHere, false, 'the stash does not open a lane');
    assert.equal(s.lane, base.lane, 'it sits on the base commit\'s own column');
    assert.deepEqual(s.inputSwimlanes.map(l => l.hash), s.outputSwimlanes.map(l => l.hash), 'it passes the lane state through unchanged');
    assert.equal(s.indentDepth, base.indentDepth, 'and takes the base commit\'s indent depth');
    // 普通提交的泳道没有被 stash 弄乱: c4 -> c3 -> c2 -> c1 仍在同一条线上
    const mainLane = list.find(c => c.hash === h('4')).lane;
    for (const hash of ['3', '2', '1']) assert.equal(list.find(c => c.hash === h(hash)).lane, mainLane, 'c' + hash + ' stays on the main lane');
    assert.equal(controller.hiddenStashCounts.get(repo.path), undefined, 'nothing is hidden');
    // 显示/隐藏 stash 不改变任何真实提交的列、颜色、缩进层数、泳道状态
    const real = controller.searchedCommitList.filter(c => !c.isStash).map(c => JSON.stringify([c.hash, c.lane, c.laneColor, c.indentDepth, c.inputSwimlanes, c.outputSwimlanes]));
    controller.setStashesVisible(false);
    const bare = controller.searchedCommitList.map(c => JSON.stringify([c.hash, c.lane, c.laneColor, c.indentDepth, c.inputSwimlanes, c.outputSwimlanes]));
    controller.setStashesVisible(true);
    assert.deepEqual(real, bare, 'showing stashes leaves every real commit exactly as it was');
  }

  // 1b) 多个 stash 同一基线: 仍然都在同一列, 没有一个 stash 把基线所在泳道挤到别处
  {
    const controller = make();
    await prime(controller, repo);
    controller.setStashes(repo.path, [stash('5', '2', 0), stash('6', '2', 1), stash('7', '2', 2)]);
    const list = controller.searchedCommitList;
    const base = list.find(c => c.hash === h('2'));
    const stashes = list.filter(c => c.isStash);
    assert.equal(stashes.length, 3);
    assert.ok(stashes.every(s => s.lane === base.lane && !s.laneStartsHere), 'three stashes on one base: all on the base column, none opens a lane');
    assert.equal(Math.max(...list.map(c => Math.max(c.lane, c.inputSwimlanes.length - 1, c.outputSwimlanes.length - 1))), 0, 'the graph stays one column wide');
  }

  // 2) 多个 stash: 同一基线 -> 都在基线之上, 最新的在最上面; 不同基线 -> 各归其位
  {
    const controller = make();
    await prime(controller, repo);
    controller.setStashes(repo.path, [stash('6', '2', 0), stash('7', '2', 1), stash('8', '4', 2)]);
    assert.deepEqual(rows(controller), ['stash:stash@{2}', 'c4', 'c3', 'stash:stash@{0}', 'stash:stash@{1}', 'c2', 'c1'], 'each stash above its own base; newest first among the same base');
  }

  // 3) 基线没加载 (分页没到 / 不在所选分支): 不进图, 如实计数
  {
    const controller = make();
    await prime(controller, repo);
    controller.setStashes(repo.path, [stash('5', '2', 0), stash('9', 'f', 1)]);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'stash:stash@{0}', 'c2', 'c1']);
    assert.equal(controller.hiddenStashCounts.get(repo.path), 1, 'the stash whose base is not loaded is counted, not silently dropped');
  }

  // 4) 开关关闭: 图里没有 stash; 重新打开恢复; 不重新读取 git log
  {
    const controller = make();
    await prime(controller, repo);
    let reads = 0; const originalReader = logs.getGitCommits; logs.getGitCommits = async (...args) => { reads++; return originalReader(...args); };
    controller.setStashes(repo.path, [stash('5', '2', 0)]);
    assert.equal(controller.setStashesVisible(false), true);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'c2', 'c1'], 'toggled off');
    assert.equal(controller.setStashesVisible(false), false, 'no-op when unchanged');
    controller.setStashesVisible(true);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'stash:stash@{0}', 'c2', 'c1'], 'toggled back on');
    assert.equal(reads, 0, 'toggling and adding stashes rebuild from the cached pages, never re-read git log');
    logs.getGitCommits = originalReader;
  }

  // 5) 缓存页只存真实提交: 分页偏移 = 真实提交数, 重建不会把 stash 当成历史页
  {
    const controller = make();
    const page = await prime(controller, repo);
    controller.setStashes(repo.path, [stash('5', '2', 0)]);
    controller.resetCommitPages(controller.searchedCommitList);
    assert.equal(controller.commitPageOffsetByRepository.get(repo.path), 4, 'offset counts the 4 real commits, not the stash row');
    assert.ok(controller.commitPageByRepository.get(repo.path).every(c => !c.isStash), 'cached pages hold real commits only');
    controller.setStashes(repo.path, [stash('5', '2', 0), stash('6', '2', 1)]);
    assert.equal(controller.searchedCommitList.filter(c => c.isStash).length, 2, 'a second rebuild does not duplicate or drop stashes');
    assert.equal(page.length, 4);
  }

  // 6) 搜索中隐藏 stash (搜索结果不展示拓扑)
  {
    const controller = make();
    await prime(controller, repo);
    controller.setStashes(repo.path, [stash('5', '2', 0)]);
    controller.keywords = ['c4'];
    assert.deepEqual(controller.buildPagedCommits().map(c => c.hash[0]), ['4', '3', '2', '1'].map(String), 'with keywords the rebuilt list has no stash row');
    controller.keywords = [];
  }

  // 7) 仓库最新提交 / 默认选中: 永远是真实提交, 即便 stash 行排在最前
  {
    const controller = make();
    await prime(controller, repo);
    controller.setStashes(repo.path, [stash('8', '4', 0)]);
    assert.equal(controller.searchedCommitList[0].isStash, true, 'the stash is the first row of the list');
    controller.total = controller.searchedCommitList.map(c => ({ ...c }));
    assert.equal(controller.latestCommitOf(repo.path).hash, h('4'), 'the newest commit of a repository skips stash rows');
    assert.equal(controller.latestCommitOf(other.path), undefined, 'and is repository-scoped');
  }

  // 8) 其他仓库的 stash 不影响本仓库
  {
    const controller = make();
    await prime(controller, repo);
    controller.setStashes(other.path, [stash('5', '2', 0)]);
    assert.deepEqual(rows(controller), ['c4', 'c3', 'c2', 'c1'], 'a stash of another repository does not appear here');
    controller.forgetStashes(other.path);
  }

  // 9) 读取中不重建 (避免与进行中的读取互相覆盖); 读取完成后由读取流程自己带上 stash
  {
    const controller = make();
    await prime(controller, repo);
    controller._isLoading = true;
    assert.equal(controller.setStashes(repo.path, [stash('5', '2', 0)]), false, 'no rebuild while a read is in flight');
    controller._isLoading = false;
    const page = await controller.readCommits(new Map([[repo.path, ['refs/heads/main']]]), [], new AbortController().signal);
    assert.deepEqual(page.map(c => (c.isStash ? 's' : 'c')), ['c', 'c', 's', 'c', 'c'], 'the next read picks the cached stash up by itself');
  }

  // 10) 加载更多: 之前基线没加载的 stash, 在基线所在的页加载进来后出现在基线之上
  {
    const controller = make();
    // 先只缓存新的两条(c4, c3); stash 的基线 c1 还没加载
    controller.repositories = [repo];
    controller.branchesByRepository = new Map([[repo.path, [branch(repo, h('4'))]]]);
    controller.commitPageByRepository.set(repo.path, linear.slice(0, 2).map(c => ({ ...c, parents: [...c.parents], gitBranchOption: branch(repo, c.hash) })));
    controller.commitPageOffsetByRepository.set(repo.path, 2);
    controller.setStashes(repo.path, [stash('5', '1', 0)]);
    assert.deepEqual(rows(controller), ['c4', 'c3'], 'the base is not loaded yet, so no stash row');
    assert.equal(controller.hiddenStashCounts.get(repo.path), 1, 'and it is reported as not yet shown');
    // loadMoreCommits 追加下一页后会走同一条重建路径
    controller.commitPageByRepository.set(repo.path, [...controller.commitPageByRepository.get(repo.path), ...linear.slice(2).map(c => ({ ...c, parents: [...c.parents], gitBranchOption: branch(repo, c.hash) }))]);
    controller.commitPageOffsetByRepository.set(repo.path, 4);
    controller.searched = controller.buildPagedCommits();
    assert.deepEqual(rows(controller), ['c4', 'c3', 'c2', 'stash:stash@{0}', 'c1'], 'once the base page is loaded the stash appears above it');
    assert.equal(controller.hiddenStashCounts.get(repo.path), undefined, 'and is no longer counted as hidden');
    assert.ok(controller.searchedCommitList.every(c => c.gitBranchOption && c.gitBranchOption.repoOption.path === repo.path), 'every row, stash included, carries its repository branch');
  }

  console.log('Stash graph passed: interleaved above the base commit on the base lane, same-base ordering, unloaded-base count, toggle without re-reading git, real-commit-only pages, search hides stashes, latest/default selection skips stash rows, repository isolation, in-flight guard.');
})().catch(error => { console.error(error); process.exitCode = 1; });
