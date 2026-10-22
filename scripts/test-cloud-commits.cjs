const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// 云端提交(HEAD..upstream): 搜索行下方的全宽折叠条, 默认折叠; 展开后云端行出现在未提交行之上, 同一个提交列表。
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
      contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const css = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8')
      .replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-icon-foreground:#aeb4bc;--vscode-descriptionForeground:#929292;--vscode-editorGroup-border:#343434;--vscode-widget-border:#343434;--vscode-panel-border:#303030;--vscode-sideBarSectionHeader-background:#181818;--vscode-input-background:#1f1f1f;--vscode-input-foreground:#cccccc;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    const html = renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + css + '</style>');
    for (const match of html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);

    const repoA = { path: 'file:///cloud/a', label: 'repo-a' };
    const repoB = { path: 'file:///cloud/b', label: 'repo-b' };
    const branchOption = (repo, hash) => ({ repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash });
    const localCommit = (repo, hash, parent, message) => ({ hash, shortHash: hash.slice(0, 8), key: repo.path + ':' + hash, parents: parent ? [parent] : [], refs: [], message, rawMessage: message, body: '', author: 'local', authorEmail: 'local@example.com', authorDateLabel: 'today', gitBranchOption: branchOption(repo, hash) });
    const cloudCommit = (hash, parent, message, refs) => ({ hash, shortHash: hash.slice(0, 8), parents: parent ? [parent] : [], message, rawMessage: message + '\n\nbody of ' + message, body: 'body of ' + message, author: 'cloud author', authorEmail: 'cloud@example.com', authorDate: '2026-10-21T10:00:00+08:00', authorDateLabel: '2026-10-21 10:00:00', refs: refs || [] });
    const h = ch => ch.repeat(40);
    const cloudA = { repositoryPath: repoA.path, repositoryLabel: repoA.label, branchLabel: 'main', count: 3,
      commits: [cloudCommit(h('f'), h('e'), 'cloud three', ['origin/main', 'tag: v-cloud']), cloudCommit(h('e'), h('d'), 'cloud two'), cloudCommit(h('d'), h('a'), 'cloud one')] };
    const cloudB = { repositoryPath: repoB.path, repositoryLabel: repoB.label, branchLabel: 'main', count: 1,
      commits: [cloudCommit(h('9'), h('8'), 'b cloud')] };
    const state = {
      repositoryChanges: [], branches: [branchOption(repoA, h('a')), { repoOption: repoA, name: 'refs/remotes/origin/main', label: 'origin/main', kind: 'remote', hash: h('f') }], selectedBranches: ['refs/heads/main'], selectedRepositoryPaths: [repoA.path],
      commits: [localCommit(repoA, h('a'), h('0'), 'local head')],
      workingTreeRows: [{ hash: 'uncommitted', label: 'Uncommitted Changes', repositoryPath: repoA.path, headHash: h('a'), enabled: true, stagedCount: 0, changesCount: 2 }],
      cloudGroups: [cloudA], files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat',
      selectedCommit: null, isLoading: false, hasMoreCommits: false,
    };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const bars = () => page.locator('#cloudCommitBars .cloud-commit-bar');
    await publish();

    // 1) 默认折叠: 折叠条在搜索行下方、占满宽度、提示拉取数量; 云端行不渲染。
    assert.equal(await bars().count(), 1);
    assert.equal(await bars().first().locator('.cloud-commit-bar-text').textContent(), '3 条提交待拉取');
    assert.equal(await bars().first().getAttribute('aria-expanded'), 'false', 'collapsed by default');
    assert.equal(await page.locator('#commitCloudRows .commit-row.cloud').count(), 0, 'collapsed: no cloud rows');
    const geometry = await page.evaluate(() => {
      const search = document.getElementById('commitSearchRow').getBoundingClientRect();
      const bar = document.querySelector('.cloud-commit-bar').getBoundingClientRect();
      const graph = document.getElementById('graph').getBoundingClientRect();
      return { belowSearch: Math.abs(bar.top - search.bottom) < 1.5, fullWidth: Math.abs(bar.width - graph.width) < 2, search: search.bottom, bar: bar.top };
    });
    assert.equal(geometry.belowSearch, true, 'the bar sits directly below the search row: ' + JSON.stringify(geometry));
    assert.equal(geometry.fullWidth, true, 'the bar spans the full width');

    // 2) 展开: 云端行在同一个提交列表里, 位于未提交行之上, 带云图标, 最新在前。
    await bars().first().click();
    assert.equal(await bars().first().getAttribute('aria-expanded'), 'true');
    const cloudRows = page.locator('#commitList #commitCloudRows .commit-row.cloud');
    assert.equal(await cloudRows.count(), 3);
    assert.deepEqual(await cloudRows.locator('.commit-message-text').allTextContents(), ['cloud three', 'cloud two', 'cloud one']);
    assert.equal(await cloudRows.locator('.col-main-summary .codicon').count(), 0, 'the title has no icon in front of it any more');
    assert.equal(await cloudRows.locator('.col-main-summary > .commit-message-text:first-child').count(), 3, 'the description is the first thing in the summary');
    assert.equal(await cloudRows.locator('svg circle').count(), 0, 'the lane node is no longer a circle');
    assert.equal(await cloudRows.locator('svg g[data-cloud-node] path').count(), 6, 'every cloud commit row draws a cloud-shaped node on its lane (backing + outline)');
    const order = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#commitList .commit-row')];
      const top = selector => nodes.findIndex(node => node.matches(selector));
      return { firstCloud: top('.cloud'), lastCloud: nodes.map(n => n.classList.contains('cloud')).lastIndexOf(true), uncommitted: top('.working-tree'), local: top('[data-hash="' + 'a'.repeat(40) + '"]') };
    });
    assert.ok(order.lastCloud < order.uncommitted, 'cloud rows are above the Uncommitted Changes row: ' + JSON.stringify(order));
    assert.ok(order.uncommitted < order.local, 'Uncommitted Changes stays above the local HEAD');

    // 3) 泳道全部是虚线; 最后一条云端行向下虚线衔接未提交行, 未提交行顶部有虚线接入。
    const lanes = await page.evaluate(() => {
      // 泳道线 = 不在云图标节点分组里的路径; 云图标节点本身是实心轮廓, 不属于虚线。
      const cloudPaths = [...document.querySelectorAll('.commit-row.cloud svg path')].filter(p => !p.closest('g[data-cloud-node]'));
      const wt = document.querySelector('.commit-row.working-tree svg');
      return {
        cloudPaths: cloudPaths.length,
        allDashed: cloudPaths.every(p => p.getAttribute('stroke-dasharray') === '2 2'),
        wtTopStub: [...wt.querySelectorAll('path')].some(p => p.getAttribute('stroke-dasharray') === '2 2' && /^M [\d.]+ 0 V /.test(p.getAttribute('d'))),
        lastCloudReachesBottom: [...document.querySelectorAll('.commit-row.cloud')].at(-1).querySelector('svg path[d$=" 26"]') !== null,
      };
    });
    assert.ok(lanes.cloudPaths >= 3, 'cloud rows draw lane segments');
    assert.equal(lanes.allDashed, true, 'every cloud lane segment is dashed');
    assert.equal(lanes.cloudPaths, await page.locator('.commit-row.cloud svg > path').count(), 'lane segments are exactly the paths outside the cloud node');
    assert.equal(lanes.wtTopStub, true, 'the Uncommitted Changes node receives the dashed lane from above');
    assert.equal(lanes.lastCloudReachesBottom, true, 'the last cloud row continues down into the next row');

    // 3b) 云图标就是泳道节点: 与普通提交的圆形节点同一列、同一行中线, 描述左缘与普通提交一致。
    const spacing = await page.evaluate(() => {
      const r = element => element.getBoundingClientRect();
      const center = box => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
      const ordinary = document.querySelector('#commitVirtualRows .commit-row[data-hash]');
      const cloud = document.querySelector('#commitCloudRows .commit-row.cloud');
      const node = center(r(cloud.querySelector('svg g[data-cloud-node]')));
      const ordinaryNode = center(r(ordinary.querySelector('svg circle')));
      return {
        nodeColumnDelta: Math.abs(node.x - ordinaryNode.x),
        nodeRowMiddleDelta: Math.abs(node.y - (r(cloud).top + r(cloud).height / 2)),
        ordinaryTextLeft: r(ordinary.querySelector('.commit-message-text')).left,
        cloudTextLeft: r(cloud.querySelector('.commit-message-text')).left,
        nodeWidth: r(cloud.querySelector('svg g[data-cloud-node]')).width,
        nodeRight: r(cloud.querySelector('svg g[data-cloud-node]')).right,
        ordinaryNodeWidth: r(ordinary.querySelector('svg circle')).width,
        ordinaryRadius: Number(ordinary.querySelector('svg circle').getAttribute('r')),
        ordinaryStrokeWidth: Number(ordinary.querySelector('svg circle').getAttribute('stroke-width')),
        // 描述与泳道的间隔 = 节点右缘到描述左缘; 云端行与普通行必须相同。
        ordinaryGap: r(ordinary.querySelector('.commit-message-text')).left - r(ordinary.querySelector('svg circle')).right,
        cloudGap: r(cloud.querySelector('.commit-message-text')).left - r(cloud.querySelector('svg g[data-cloud-node]')).right,
      };
    });
    assert.ok(Math.abs(spacing.cloudGap - spacing.ordinaryGap) < 0.01, 'the gap between the lane node and the description is the same for cloud and ordinary commits: ' + JSON.stringify(spacing));
    assert.ok(Math.abs(spacing.nodeWidth - 12.25) < 0.05, 'the cloud icon keeps its confirmed 14px size (about 12.25px of ink), it is not shrunk to match the circle: ' + JSON.stringify(spacing));
    assert.ok(spacing.nodeColumnDelta < 0.75, 'the cloud node sits in the same lane column as an ordinary node: ' + JSON.stringify(spacing));
    assert.ok(spacing.nodeRowMiddleDelta < 0.75, 'the cloud node is vertically centred on its row: ' + JSON.stringify(spacing));
    assert.ok(Math.abs(spacing.cloudTextLeft - spacing.ordinaryTextLeft - 2.125) < 0.01, 'the lane column adds only the cloud icon overhang beyond the uniform 4px commit dot: ' + JSON.stringify(spacing));
    assert.equal(spacing.ordinaryRadius, 4, 'all circular commit nodes use a uniform 4px radius: ' + JSON.stringify(spacing));
    assert.equal(spacing.ordinaryGap, 7, "the uniform dot keeps a 7px node-edge-to-title gap inside VS Code's extra lane slot: " + JSON.stringify(spacing));
    assert.equal(spacing.cloudGap, 7, 'cloud rows keep the same node-to-title gap: ' + JSON.stringify(spacing));
    const workingTree = await page.evaluate(() => {
      const r = el => el.getBoundingClientRect();
      const row = document.querySelector('.commit-row.working-tree');
      return { gap: r(row.querySelector('.col-main-summary')).left - r(row.querySelector('svg circle')).right, textLeft: r(row.querySelector('.col-main-summary')).left, radius: Number(row.querySelector('svg circle').getAttribute('r')) };
    });
    assert.equal(workingTree.radius, 4, 'the working-tree circle uses the same 4px radius');
    assert.equal(workingTree.gap, spacing.ordinaryGap, 'the Uncommitted Changes row keeps exactly the same lane-to-description gap as an ordinary commit: ' + JSON.stringify({ workingTree, spacing }));
    assert.equal(workingTree.textLeft, spacing.ordinaryTextLeft, 'and its label starts in the same column as an ordinary commit title');
    assert.ok(spacing.nodeRight < spacing.cloudTextLeft, 'the cloud node does not run into the description: ' + JSON.stringify(spacing));

    // 4) 云端行与普通提交行为一致: 点击即选中并发出 selectCommit(哈希 + 仓库), 变更文件与 Diff 由后端按哈希读取。
    await page.evaluate(() => { window.messages.length = 0; });
    await cloudRows.first().click();
    assert.deepEqual(await page.evaluate(() => window.messages.filter(m => m.type === 'selectCommit')), [{ type: 'selectCommit', hash: 'f'.repeat(40), repositoryPath: 'file:///cloud/a' }], 'clicking a cloud row selects it exactly like an ordinary commit');
    assert.equal(await page.locator('.commit-row.cloud.selected').count(), 1, 'the clicked cloud row is highlighted');
    assert.equal(await cloudRows.first().getAttribute('data-hash'), 'f'.repeat(40), 'cloud rows carry the same data-hash/data-repository-path as ordinary rows');
    assert.equal(await cloudRows.first().getAttribute('data-repository-path'), 'file:///cloud/a');
    // 后端回推选中状态(真实环境由 Store 回显), 再点一次: 展开描述, 与普通提交一致; 展开后泳道随行高拉长。
    state.selectedCommit = { key: 'file:///cloud/a:' + 'f'.repeat(40), hash: 'f'.repeat(40), repositoryPath: 'file:///cloud/a', kind: 'commit' };
    await publish();
    assert.equal(await cloudRows.first().evaluate(node => node.classList.contains('selected')), true, 'the echoed selection keeps the cloud row highlighted');
    await cloudRows.first().click();
    assert.equal(await cloudRows.first().evaluate(node => node.classList.contains('expanded')), true, 'a selected cloud row expands its description on the second click');
    assert.match(await cloudRows.first().locator('.commit-description').textContent(), /body of cloud three/, 'the description shows the commit body');
    assert.match(await cloudRows.first().locator('.commit-description').textContent(), /cloud@example\.com/, 'and the same detail rows (author email) as an ordinary commit');
    const expandedGeometry = await cloudRows.first().evaluate(node => ({ row: node.getBoundingClientRect().height, svg: node.querySelector('svg').getBoundingClientRect().height }));
    assert.ok(expandedGeometry.row > 26 && Math.abs(expandedGeometry.svg - expandedGeometry.row) < 1.5, 'the dashed lane stretches with the expanded row: ' + JSON.stringify(expandedGeometry));
    // 展开后行很高, 默认点击行中心会落在描述区(描述区的点击不触发折叠, 与普通提交一致): 点标题那一行。
    await cloudRows.first().locator('.commit-message-text').click();
    assert.equal(await cloudRows.first().evaluate(node => node.classList.contains('expanded')), false, 'clicking the title row collapses it again');

    // 4b) 悬浮按钮: 与普通提交同一套(分支/标签、作者、时间), 展开状态全局共用。
    const chipKinds = row => row.locator('[data-floating-kind]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-floating-kind')));
    assert.deepEqual(await chipKinds(cloudRows.first()), ['tag', 'remote', 'author', 'time'], 'the cloud tip shows the same floating buttons, in the same order, as an ordinary commit: tag, upstream branch, author, time');
    assert.deepEqual(await chipKinds(cloudRows.nth(1)), ['author', 'time'], 'a cloud commit without refs only has the author and time buttons');
    assert.deepEqual(await chipKinds(page.locator('#commitVirtualRows .commit-row[data-hash]').first()), ['author', 'time'], 'ordinary rows (without refs) expose the same author/time buttons');
    const authorExpanded = () => page.evaluate(() => document.getElementById('graph').classList.contains('commit-floating-author-expanded'));
    const before = await authorExpanded();
    await cloudRows.first().locator('[data-floating-kind="author"]').click();
    assert.equal(await authorExpanded(), !before, 'clicking a cloud row author button toggles the shared author expansion, exactly like an ordinary row');
    assert.equal(await cloudRows.first().locator('.commit-row-info--author').getAttribute('aria-expanded'), String(!before), 'and the button reflects the new state');
    await cloudRows.first().locator('[data-floating-kind="author"]').click();
    assert.equal(await authorExpanded(), before, 'and toggles back');
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.type === 'selectCommit').length), 1, 'clicking a floating button never re-selects the row');

    // 4c) 右键菜单: 与普通提交同一个菜单, 目标是这条云端提交(hash + 仓库)。
    await cloudRows.nth(1).click({ button: 'right' });
    assert.equal(await page.evaluate(() => document.getElementById('commitContextMenu').matches(':popover-open')), true, 'the commit context menu opens on a cloud row');
    assert.equal(await cloudRows.nth(1).evaluate(node => node.classList.contains('context-target')), true, 'the right-clicked cloud row is the menu target');
    await page.evaluate(() => { window.messages.length = 0; });
    await page.locator('#commitContextMenu [data-commit-action="copyHash"]').click();
    assert.deepEqual(await page.evaluate(() => window.messages.filter(m => m.type === 'commitAction')), [{ type: 'commitAction', action: 'copyHash', hash: 'e'.repeat(40), repositoryPath: 'file:///cloud/a' }], 'menu actions run against the right-clicked cloud commit');

    // 5) 再次点击折叠条收起, 未提交行顶部虚线一起消失。
    await bars().first().click();
    assert.equal(await bars().first().getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#commitCloudRows .commit-row.cloud').count(), 0);
    assert.equal(await page.evaluate(() => [...document.querySelector('.commit-row.working-tree svg').querySelectorAll('path')].some(p => /^M [\d.]+ 0 V /.test(p.getAttribute('d')))), false, 'collapsed: the incoming dashed stub is removed');

    // 6) 外部 fetch / 同步后数量变化: 条文案实时更新; 数量为 0 时折叠条消失, 已展开的云端行也一起消失。
    await bars().first().click();
    cloudA.count = 5; await publish();
    assert.equal(await bars().first().locator('.cloud-commit-bar-text').textContent(), '5 条提交待拉取');
    assert.equal(await cloudRows.count(), 3, 'rows beyond the published window are summarised, not invented');
    assert.match(await page.locator('#commitCloudRows .cloud-commit-group-title').first().textContent(), /仅显示最新 3 条，共 5 条/);
    state.cloudGroups = []; await publish();
    assert.equal(await bars().count(), 0, 'no bar when nothing is behind');
    assert.equal(await page.locator('#commitCloudRows .commit-row.cloud').count(), 0);

    // 7) 多仓库: 每个已选仓库当前分支各一条折叠条, 文案带仓库名, 折叠状态互相独立。
    state.cloudGroups = [cloudA, cloudB]; cloudA.count = 3; state.selectedRepositoryPaths = [repoA.path, repoB.path]; await publish();
    assert.deepEqual(await bars().locator('.cloud-commit-bar-text').allTextContents(), ['repo-a：3 条提交待拉取', 'repo-b：1 条提交待拉取']);
    assert.equal(await bars().nth(0).getAttribute('aria-expanded'), 'true', 'repo-a stays expanded: folding state survives count updates and the bar disappearing');
    assert.equal(await bars().nth(1).getAttribute('aria-expanded'), 'false', 'repo-b starts collapsed');
    await bars().nth(0).click();
    assert.equal(await bars().nth(0).getAttribute('aria-expanded'), 'false');
    await bars().nth(1).click();
    assert.equal(await bars().nth(1).getAttribute('aria-expanded'), 'true');
    assert.equal(await bars().nth(0).getAttribute('aria-expanded'), 'false', 'folding is per repository');
    assert.deepEqual(await page.locator('#commitCloudRows .commit-row.cloud .commit-message-text').allTextContents(), ['b cloud']);
    assert.equal(await page.locator('#commitCloudRows .commit-row.cloud svg path[d$=" 26"]').count(), 0, 'a group that does not meet the Uncommitted Changes row draws no dashed lane into empty space');

    // 8) 搜索结果不展示拓扑: 云端提交不混入(后端不下发 cloudGroups)。
    state.cloudGroups = []; state.showCommitLanes = false; await publish();
    assert.equal(await bars().count(), 0);

    assert.deepEqual(errors, []);
    console.log('Cloud commits passed: default-collapsed full-width bar, count text, expand above Uncommitted Changes, cloud icon, dashed lanes, read-only rows, live count, per-repository folding.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });