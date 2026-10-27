const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 1000 }, deviceScaleFactor: Number(process.env.GITK_TEST_DPR || 1) });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')), contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const icons = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#ccc;--vscode-foreground:#ccc;--vscode-descriptionForeground:#929292;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-list-activeSelectionBackground:#262626}';
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
    await page.setContent(renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + icons + '</style>'));
    const h = char => char.repeat(40), blue = '#57a3f8', orange = '#ffb000';
    const repo = { path: 'file:///stash-side-branch/a', label: 'repo-a' };
    const branch = { repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: h('3') };
    const lane = (hash, color = blue) => ({ hash: h(hash), color });
    const commit = (hash, parent, extra = {}) => ({ hash: h(hash), key: repo.path + ':' + h(hash), shortHash: hash.repeat(8),
      parents: parent ? [h(parent)] : [], refs: [], message: 'commit ' + hash, rawMessage: 'commit ' + hash, body: '', author: 'me', authorEmail: 'me@example.com',
      authorDate: '2026-10-22T10:00:00+08:00', authorDateLabel: 'today', gitBranchOption: branch,
      lane: 0, laneColor: blue, inputSwimlanes: [lane(hash)], outputSwimlanes: parent ? [lane(parent)] : [], ...extra });
    const stash = (hash, base = '2', index = 0) => commit(hash, base, { isStash: true, stashRef: 'stash@{' + index + '}', stashIndex: index,
      inputSwimlanes: [lane(base)], outputSwimlanes: [lane(base)], laneColor: undefined });
    const real = [commit('3', '2', { inputSwimlanes: [] }), commit('2', '1'), commit('1', '')];
    const state = { repositoryChanges: [], branches: [branch], selectedBranches: [branch.name], selectedRepositoryPaths: [repo.path], commits: real,
      workingTreeRows: [], cloudGroups: [], showStashes: false, hiddenStashCount: 0, files: [], stagedFiles: [], unstagedFiles: [], filesMode: 'flat', filesLoading: false,
      selectedCommit: null, isLoading: false, hasMoreCommits: false };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const realGeometry = () => page.locator('#commitVirtualRows .commit-row:not(.stash)').evaluateAll(rows => rows.map(row => ({
      hash: row.dataset.hash, titleX: row.querySelector('.col-main-summary').getBoundingClientRect().left,
      nodeX: row.querySelector('circle').getAttribute('cx'), width: row.querySelector('svg').getBoundingClientRect().width,
    })));
    await publish(); const baseline = await realGeometry();
    state.commits = [real[0], stash('5'), stash('6','2',1), real[1], real[2]]; state.showStashes = true;
    await publish();
    assert.deepEqual(await realGeometry(), baseline, 'showing stash branches never indents or widens any real commit');
    const fork = page.locator('#commitVirtualRows .commit-row[data-hash="' + h('2') + '"] .stash-fork');
    assert.equal(await fork.count(), 1, 'stash branch must be rooted in the real base commit row, not the stash-row boundary');
    const root = await fork.evaluate(path => {
      const circle = path.closest('svg').querySelector('circle');
      const point = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      const visibleEdge = Number(circle.getAttribute('r')) + Number(circle.getAttribute('stroke-width')) / 2;
      const join = path.getPointAtLength(visibleEdge + .5).matrixTransform(path.getScreenCTM());
      return { start:{x:point.x,y:point.y}, end:{x:end.x,y:end.y}, circle:{x:Number(circle.getAttribute('cx')),y:Number(circle.getAttribute('cy'))},
        width:Number(path.getAttribute('stroke-width')), dotDiameter:2*Number(circle.getAttribute('r'))-parseFloat(getComputedStyle(circle).strokeWidth),
        dotCenter:{x:point.matrixTransform(path.getScreenCTM()).x,y:point.matrixTransform(path.getScreenCTM()).y}, join:{x:join.x,y:join.y} };
    });
    assert.deepEqual(root.start,root.circle,'fork starts at actual base-circle centre');
    assert.equal(root.width,2,'stash fork matches the 2px real-commit trunk');
    const rows = page.locator('#commitVirtualRows .commit-row.stash');
    for (let i = 0; i < await rows.count(); i++) {
      const g = await rows.nth(i).evaluate(row => {
        const svg = row.querySelector('svg'), trunk = svg.querySelector('.stash-main-lane'), branch = svg.querySelector('.stash-branch'), node = svg.querySelector('.stash-node');
        const nums = node.getAttribute('d').match(/-?[\d.]+/g).map(Number);
        const ends = element => [element.getPointAtLength(0), element.getPointAtLength(element.getTotalLength())].map(p => ({ x: p.x, y: p.y }));
        return { trunk: trunk ? { x: trunk.x1.baseVal.value, stroke: trunk.getAttribute('stroke'), width:Number(trunk.getAttribute('stroke-width')), dash: trunk.getAttribute('stroke-dasharray'), ends: ends(trunk) } : null,
          branch: branch ? { dash: branch.getAttribute('stroke-dasharray'), width:Number(branch.getAttribute('stroke-width')), ends: ends(branch) } : null,
          nodeX: nums[0], nodeWidth:Number(node.getAttribute('stroke-width')), nodeDiameter:nums[5]-nums[1]+Number(node.getAttribute('stroke-width')), titleX: row.querySelector('.col-main-summary').getBoundingClientRect().left, height: row.getBoundingClientRect().height };
      });
      assert.ok(g.trunk && g.branch, 'stash has a continuous real-commit trunk and its own side branch: ' + JSON.stringify(g));
      assert.equal(g.trunk.dash, null, 'the trunk is solid even inside a stash row'); assert.equal(g.trunk.stroke, blue, 'trunk retains the real lane colour');
      assert.equal(g.nodeX - g.trunk.x, 11, 'only stash node moves one lane right');
      assert.equal(g.titleX - baseline[0].titleX, 11, 'only stash title indents by one lane');
      assert.equal(g.branch.dash, '2 2', 'stash branch keeps the uniform dashed style');
      assert.equal(g.branch.width,g.trunk.width,'stash stem matches the real-commit trunk weight');
      assert.equal(g.nodeWidth,1,'stash diamond has a dedicated 1px outline');
      assert.equal(g.nodeDiameter,10,'stash diamond outer size is 10px including its outline');
      assert.equal(g.branch.ends[1].x, g.nodeX, 'stem stays in the stash display column until the base row');
      assert.equal(root.end.x,g.nodeX,'base fork reaches the stash display column');
      assert.equal(root.end.y,0,'base fork connects at the preceding row boundary');
      assert.equal(g.trunk.ends[1].y, g.height, 'solid trunk reaches the actual row bottom');
    }
    assert.equal(await page.locator('#commitVirtualRows .commit-row:not(.stash) [stroke-dasharray]:not(.stash-fork)').count(), 0, 'real commit halves never become dashed because of a stash');
    const tip = await rows.first().evaluate(row => {
      const svg=row.querySelector('svg'),node=svg.querySelector('.stash-node');
      const n=node.getAttribute('d').match(/-?[\d.]+/g).map(Number),p=svg.createSVGPoint();p.x=n[0];p.y=n[5]+1;
      const point=p.matrixTransform(svg.getScreenCTM());return {x:point.x,y:point.y};
    });
    const diamondCenter = await rows.first().evaluate(row => {
      const node=row.querySelector('.stash-node'),box=node.getBoundingClientRect();
      return {x:box.left+box.width/2,y:box.top+box.height/2};
    });
    const png=PNG.sync.read(await page.screenshot());
    const scale = png.width / page.viewportSize().width;
    const greyInk = point => {
      point = {x:point.x*scale,y:point.y*scale};
      for(let y=Math.floor(point.y)-1;y<=Math.floor(point.y)+1;y++)for(let x=Math.floor(point.x)-1;x<=Math.floor(point.x)+1;x++){
        const i=(y*png.width+x)*4;const [r,g,b]=png.data.subarray(i,i+3);
        if(r>100&&Math.abs(r-g)<12&&Math.abs(g-b)<12)return true;
      }
      return false;
    };
    const paintedWidth = (center,grey) => {
      const target=grey ? [146,146,146] : [87,163,248];
      const backgroundIndex=(Math.floor(center.y*scale)*png.width+Math.floor((center.x-7)*scale))*4;
      const background=png.data.subarray(backgroundIndex,backgroundIndex+3);
      const delta=target.map((c,i)=>c-background[i]), norm=delta.reduce((sum,c)=>sum+c*c,0);
      let left=Infinity,right=-Infinity;
      for(let y=Math.max(0,Math.floor((center.y-6)*scale));y<Math.min(png.height,Math.ceil((center.y+6)*scale));y++) {
        for(let x=Math.max(0,Math.floor((center.x-6)*scale));x<Math.min(png.width,Math.ceil((center.x+6)*scale));x++) {
          const i=(y*png.width+x)*4,[r,g,b]=png.data.subarray(i,i+3);
          const coverage=delta.reduce((sum,c,k)=>sum+([r,g,b][k]-background[k])*c,0)/norm;
          const ink=coverage>.25&&(grey ? Math.abs(r-g)<12&&Math.abs(g-b)<12 : b>r+40&&b>g+20);
          if(ink){left=Math.min(left,x);right=Math.max(right,x);}
        }
      }
      assert.ok(Number.isFinite(left),'node has visible ink');
      return right-left+1;
    };
    const circleWidth=paintedWidth(root.dotCenter,false),diamondWidth=paintedWidth(diamondCenter,true);
    assert.ok(Math.abs(circleWidth-root.dotDiameter*scale)<=1,'ordinary dot visible size remains unchanged');
    assert.ok(Math.abs(diamondWidth-10*scale)<=1,'diamond raster matches its 10px outer size within one device pixel: '+JSON.stringify({circleWidth,diamondWidth,scale}));
    if(process.env.GITK_TEST_NODE_SIZE_DIAGNOSTICS)console.log(JSON.stringify({scale,circleWidth,diamondWidth,diamondSize:10,stroke:1}));
    assert.ok(greyInk(root.join),'the first visible fork dash meets the real commit circle');
    assert.ok(greyInk(tip),'stem ink meets the hollow diamond lower tip');
    // A stash above the latest commit has no pre-existing lane: resolve its colour from the real base and keep the prefix dashed.
    const top = stash('8', '3'); top.inputSwimlanes = []; top.outputSwimlanes = [];
    const top2 = { ...top, hash:h('7'), key:repo.path + ':' + h('7'), stashRef:'stash@{1}', stashIndex:1 };
    state.commits = [top, top2, ...real]; await publish();
    assert.deepEqual(await page.locator('.commit-row.stash .stash-main-lane').evaluateAll(lines => lines.map(line => line.getAttribute('stroke'))), [blue, blue]);
    const headUpper = await page.locator('.commit-row[data-hash="' + h('3') + '"] svg path').evaluateAll(paths => paths.map(p => ({ d: p.getAttribute('d'), stroke: p.getAttribute('stroke'), dash: p.getAttribute('stroke-dasharray') })));
    assert.ok(headUpper.some(p => /^M 11 0 V 13$/.test(p.d) && p.dash === '2 2' && p.stroke === blue), 'latest real commit receives the dashed stash-prefix connector');
    // Real side lanes pass through unchanged; the stash display lane stays outside all real lanes.
    const sideBase = commit('2', '1', { lane: 1, inputSwimlanes: [lane('a', orange), lane('2')], outputSwimlanes: [lane('a', orange), lane('1')] });
    const sideStash = stash('9'); sideStash.lane = 1; sideStash.inputSwimlanes = sideStash.outputSwimlanes = [lane('a', orange), lane('2')];
    state.commits = [sideBase, real[2]]; await publish(); const sideBaseline = await realGeometry();
    state.commits = [sideStash, sideBase, real[2]]; await publish();
    assert.deepEqual(await realGeometry(), sideBaseline, 'real side-branch titles also stay unchanged');
    const side = page.locator('.commit-row.stash');
    assert.equal(await side.locator('.stash-main-lane').count(), 2, 'all real lanes remain solid through a stash');
    assert.equal(await side.locator('.stash-node').evaluate(node => Number(node.getAttribute('d').split(' ')[1])), 33, 'stash leaf goes after the two real lanes');
    const orphan = commit('b','',{laneColor:orange,inputSwimlanes:[],outputSwimlanes:[]});
    const orphanStash = stash('c','b'); orphanStash.inputSwimlanes = orphanStash.outputSwimlanes = [];
    state.commits = [orphanStash,orphan]; await publish();
    assert.equal(await page.locator('.commit-row.stash .stash-main-lane').getAttribute('stroke'), orange, 'branch-head fallback uses actual base colour, not a hard-coded main colour');
    if (process.env.GITK_STASH_BRANCH_SCREENSHOT) {
      state.commits = [real[0], stash('5'), stash('6','2',1), real[1], real[2]];
      const titles = ['更新 render 和 common 子库', 'WIP on ink_dev: render 暂存', 'WIP on ink_dev: log 暂存', '优化 log 的版本号显示', '初始化提交'];
      state.commits.forEach((commit,index) => { commit.message = titles[index]; commit.rawMessage = titles[index]; });
      await publish();
      await page.locator('#commitVirtualRows').screenshot({ path: process.env.GITK_STASH_BRANCH_SCREENSHOT });
    }
    assert.deepEqual(errors, []);
    console.log('Stash side branches passed: solid commit trunk, only stash indent, multiple stashes, latest-head colour fallback, real side-lane preservation.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
