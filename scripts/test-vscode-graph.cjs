const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const vscode = { EventEmitter: Emitter, Uri: { parse: value => ({ toString: () => value, fsPath: value }) } };
const load = Module._load;
let GitCommitController;
try {
  Module._load = function(name, ...args) { if (name === 'vscode') return vscode; return load.call(this, name, ...args); };
  ({ GitCommitController } = require('../out/git/gitCommitController'));
} finally { Module._load = load; }

const h = ch => ch.repeat(40);
const repo = { path: 'file:///vscode-graph/a', label: 'repo-a' };
const branch = { repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: h('4') };
const commit = (hash, parents, message) => ({ hash: h(hash), shortHash: hash.repeat(8), parents: parents.map(h), refs: [], message, rawMessage: message, body: '', author: 'me', authorDate: '2026-10-22T00:00:00+08:00' });

(async () => {
  // VS Code / git --topo-order order: merge, second-parent side branch, first-parent main branch, common base.
  const raw = [
    commit('4', ['5', '6'], "Merge remote-tracking branch 'origin/ink_dev' into ink_dev"),
    commit('6', ['3'], 'side: update render'),
    commit('5', ['3'], 'main: share images'),
    commit('3', ['2'], 'common base'),
  ];
  const controller = new GitCommitController(
    { totalRepoList: [repo], ontotalRepoListChanged: new Emitter().event, onSelectedRepoListChanged: new Emitter().event },
    { onSelectedBranchesChanged: new Emitter().event, getSelectedBranchesByRepository: () => new Map() },
    { onEachHeadBranchUncommittedFileChanged: new Emitter().event, listCurrentHeadBranches: () => [] }, {},
  );
  const rows = controller.buildGraph(raw.map(c => ({ ...c, parents: [...c.parents] })), branch.hash)
    .map(c => ({ ...c, key: repo.path + ':' + c.hash, gitBranchOption: branch, authorDateLabel: 'today' }));

  assert.deepEqual(rows.map(c => c.hash), [h('4'), h('6'), h('5'), h('3')], 'topo order keeps the merged side branch next to the merge');
  assert.deepEqual(rows.map(c => c.lane), [0, 1, 0, 0], 'main stays in column 0, side branch occupies column 1');
  assert.equal(rows[0].laneColor, 'var(--vscode-scmGraph-historyItemRefColor, #57a3f8)', 'current branch uses VS Code history item blue');
  assert.equal(rows[1].laneColor, 'var(--vscode-scmGraph-foreground1, #ffb000)', 'first side branch uses VS Code foreground1 orange');
  assert.equal(rows[2].laneColor, rows[0].laneColor, 'first-parent main line inherits blue');
  assert.equal(rows[3].laneColor, rows[0].laneColor, 'the common base resolves to the left/main lane colour');
  assert.deepEqual(rows[3].inputSwimlanes.map(l => l.hash), [h('3'), h('3')], 'both lanes meet at the common base');
  for (const row of rows) {
    const atNode = row.inputSwimlanes.find(lane => lane.hash === row.hash)
      ?? row.outputSwimlanes[row.lane];
    assert.equal(row.laneColor, atNode?.color ?? row.laneColor, row.message + ': node colour equals its swimlane colour');
  }

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 500 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({ body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')), contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const css = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#191a1b;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#929292;--vscode-scmGraph-historyItemRefColor:#57a3f8;--vscode-scmGraph-foreground1:#ffb000;--vscode-scmGraph-foreground2:#dc267f;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    const html = renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + css + '</style>');
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
    await page.setContent(html);
    const state = { repositoryChanges: [], branches: [branch], selectedBranches: [branch.name], selectedRepositoryPaths: [repo.path], commits: rows, workingTreeRows: [], cloudGroups: [], showStashes: false, hiddenStashCount: 0, files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat', selectedCommit: null, isLoading: false, hasMoreCommits: false };
    await page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const domRows = page.locator('#commitVirtualRows .commit-row');
    assert.deepEqual(await domRows.locator('.commit-message-text').allTextContents(), raw.map(c => c.message));
    assert.equal(await domRows.nth(0).locator('circle.current-ref-dot').count(), 1, 'current merge is a filled current-ref node');
    assert.equal(await domRows.nth(1).locator('circle.dot').count(), 1, 'side commit is a filled dot');
    assert.equal(await domRows.nth(2).locator('circle.dot').count(), 1, 'main commit is a filled dot');
    assert.equal(await domRows.nth(3).locator('circle.dot').count(), 1, 'common base is a filled dot, not a hollow join marker');
    assert.equal(await page.locator('#commitVirtualRows circle.join-dot').count(), 0, 'meeting lanes alone never turn a normal commit into a donut');
    const mergeLaneGap = await domRows.nth(0).evaluate(row => {
      const svg = row.querySelector('svg.graph-svg').getBoundingClientRect();
      const summary = row.querySelector('.col-main-summary').getBoundingClientRect();
      // 两条泳道的最右列中心 = 2 * 11px = 22px；VS Code 在后面保留一个完整的 11px 泳道槽再开始标题。
      return Math.round((summary.left - (svg.left + 22)) * 10) / 10;
    });
    assert.equal(mergeLaneGap, 11, 'VS Code keeps one full 11px swimlane slot between the rightmost lane and the title');
    const titleStarts = await domRows.locator('.col-main-summary').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().left * 10) / 10));
    assert.equal(new Set(titleStarts).size, 1, 'merge, side branch, main branch and common base titles are perfectly aligned: ' + JSON.stringify(titleStarts));
    const paint = await page.evaluate(() => [...document.querySelectorAll('#commitVirtualRows .commit-row')].map(row => {
      const circle = row.querySelector('circle'); const css = getComputedStyle(circle), center = row.querySelector('circle.merge-dot-center');
      return { fill: center ? getComputedStyle(center).fill : css.fill, ring: center ? css.stroke : null, background: css.fill, r: Number(circle.getAttribute('r')),
        centerR: center ? Number(center.getAttribute('r')) : null, strokeWidth: Number(circle.getAttribute('stroke-width')), merge: circle.classList.contains('merge-dot') };
    }));
    assert.deepEqual(paint.map(p => p.fill), ['rgb(87, 163, 248)', 'rgb(255, 176, 0)', 'rgb(87, 163, 248)', 'rgb(87, 163, 248)']);
    assert.deepEqual(paint.map(p => p.merge), [true, false, false, false], 'only the merge commit uses the merge icon');
    assert.deepEqual({ ring: paint[0].ring, background: paint[0].background, r: paint[0].r, centerR: paint[0].centerR, width: paint[0].strokeWidth },
      { ring: 'rgb(87, 163, 248)', background: 'rgb(25, 26, 27)', r: 4.75, centerR: 2.25, width: 1.5 }, 'merge icon is a lane-coloured ring with a centre dot');
    assert.deepEqual(paint.slice(1).map(p => p.r), [5, 5, 5], 'ordinary commit dots keep the uniform 5px radius');
    assert.ok(paint.slice(1).every(p => p.strokeWidth === 2), 'ordinary node outline is 2px');
    const mergePaths = await domRows.nth(0).locator('svg path').evaluateAll(paths => paths.map(p => ({ d: p.getAttribute('d'), stroke: getComputedStyle(p).stroke, width: p.getAttribute('stroke-width') })));
    assert.ok(mergePaths.some(p => /A 11 11/.test(p.d) && /H 11/.test(p.d)), 'merge branch uses VS Code 11px arc + horizontal geometry: ' + JSON.stringify(mergePaths));
    assert.ok(mergePaths.filter(p => p.width === '2').length >= 2, 'normal graph lines use the requested 2px stroke');
    const basePaths = await domRows.nth(3).locator('svg path').evaluateAll(paths => paths.map(p => p.getAttribute('d')));
    const mergeIn = basePaths.find(d => /A 11 11/.test(d));
    // VS Code (scmHistory.ts) 画这条汇入曲线时 sweep-flag 是 1。用 0 得到的是水平镜像的弧,
    // 看起来就是"弧线方向反了": 一进入该行立刻向左跳, 而不是先向下再平滑向左收进节点。
    assert.equal(mergeIn, 'M 22 0 V 2 A 11 11 0 0 1 11 13 H 11', 'the side lane bends down-then-left (VS Code sweep flag 1), not its mirror image');
    // 仅断言 d 字符串不够: sweep-flag 写错时坐标完全一样, 只有实际轨迹不同。这里按渲染后的像素验证
    // 曲线在进入该行后仍先保持在右侧泳道, 而不是立刻跳到左侧。
    const arcTrajectory = await domRows.nth(3).evaluate(row => {
      const path = [...row.querySelectorAll('svg path')].find(p => /A 11 11/.test(p.getAttribute('d')));
      const total = path.getTotalLength();
      return [0, 0.15, 0.3, 0.5, 1].map(t => {
        const pt = path.getPointAtLength(total * t);
        return { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 };
      });
    });
    assert.ok(arcTrajectory[1].x > 21, 'shortly after entering the row the lane is still on the right (x>21), i.e. it has not jumped left: ' + JSON.stringify(arcTrajectory));
    assert.ok(arcTrajectory[2].x > arcTrajectory[3].x && arcTrajectory[3].x > 11, 'the curve moves left monotonically and only reaches the node column at the end: ' + JSON.stringify(arcTrajectory));
    assert.deepEqual(errors, []);
    console.log('VS Code graph passed: topo-order side branch block, blue current lane, orange side lane, filled nodes, 11px arcs and 2px lines.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
