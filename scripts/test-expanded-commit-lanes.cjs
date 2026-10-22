const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// Real commit lanes must follow layout, not the height measured before labels/fonts reflow.
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 354, height: 1200 }, locale: 'en-US', timezoneId: 'Asia/Shanghai', deviceScaleFactor: Number(process.env.GITK_TEST_DPR || 1) });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
      contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const icons = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#ccc;--vscode-foreground:#ccc;--vscode-descriptionForeground:#929292;--vscode-list-activeSelectionBackground:#262626;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial}';
    await page.evaluate(() => { let saved = {}; window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => saved, setState: value => { saved = value; } }); });
    await page.setContent(renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + icons + '</style>'));
    const h = char => char.repeat(40);
    const blue = '#57a3f8', orange = '#ffb000';
    const repo = { path: 'file:///expanded-commit-lanes/a', label: 'ink' };
    const branch = { repoOption: repo, name: 'refs/heads/ink_dev', label: 'ink_dev', kind: 'current', hash: h('2'), upstreamName: 'refs/remotes/origin/ink_dev' };
    const remote = { ...branch, name: branch.upstreamName, label: 'origin/ink_dev', kind: 'remote' };
    const lane = (char, color = blue) => ({ hash: h(char), color });
    const commit = (char, parents, extra = {}) => ({
      hash: h(char), key: repo.path + ':' + h(char), shortHash: char.repeat(8), parents: parents.map(h),
      refs: [], message: 'feat(ink SDK开发1.0):更新algorithm和 common 版本', body: 'Closes INKSDK-8',
      rawMessage: 'feat(ink SDK开发1.0):更新algorithm和 common 版本\n\nCloses INKSDK-8',
      author: 'ZhaoXiaowei', authorEmail: 'xiaowei2.zhao@example.com', authorDate: '2026-10-22T10:41:33+08:00', authorDateLabel: 'today',
      gitBranchOption: branch, lane: 0, laneColor: blue, inputSwimlanes: [lane(char)], outputSwimlanes: parents.map(parent => lane(parent)), ...extra,
    });
    const state = { repositoryChanges: [], branches: [branch, remote], selectedBranches: [branch.name], selectedRepositoryPaths: [repo.path],
      commits: [], workingTreeRows: [], cloudGroups: [], showStashes: false, hiddenStashCount: 0,
      files: [], stagedFiles: [], unstagedFiles: [], filesMode: 'flat', filesLoading: false,
      selectedCommit: { hash: h('2'), key: repo.path + ':' + h('2'), repositoryPath: repo.path, kind: 'commit' }, isLoading: false, hasMoreCommits: false };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const row = page.locator('#commitVirtualRows .commit-row[data-hash="' + h('2') + '"]');
    async function assertJoined(label) {
      const geometry = await row.evaluate(element => {
        const svg = element.querySelector('svg.graph-svg'), box = element.getBoundingClientRect(), next = element.nextElementSibling.getBoundingClientRect();
        const index = Number(element.dataset.row);
        const paths = [...svg.querySelectorAll('path:not([stroke-dasharray]),line:not([stroke-dasharray])')];
        const ends = paths.flatMap(path => {
          // Merge paths have several M subpaths; inspect each endpoint, not only the last H segment.
          const pieces = path.localName === 'path' ? path.getAttribute('d').match(/M[^M]+/g).map(d => {
            const piece = path.cloneNode(); piece.setAttribute('d',d); return piece;
          }) : [path];
          return pieces.map(piece => {
            const point = piece.getPointAtLength(piece.getTotalLength());
            const screen = point.matrixTransform(path.getScreenCTM());
            return { x:point.x, y:screen.y };
          });
        });
        const circle = svg.querySelector('circle');
        const last = element.querySelector('.commit-detail-item:last-child').getBoundingClientRect();
        return { rowHeight:box.height, svgHeight:svg.getBoundingClientRect().height, rowTop:box.top, rowBottom:box.bottom, nextTop:next.top,
          svgLeft:svg.getBoundingClientRect().left, ends, circleY:Number(circle.getAttribute('cy')), circleRadius:Number(circle.getAttribute('r')),
          belowParent:box.bottom-last.bottom, paddingBottom:parseFloat(getComputedStyle(element.querySelector('.commit-description')).paddingBottom), index };
      });
      const lanes = state.commits[geometry.index].outputSwimlanes;
      const gaps = lanes.map((lane, column) => {
        const ends = geometry.ends.filter(point => Math.abs(point.x-(column+1)*11)<.01);
        assert.ok(ends.length, label + ': output lane exists: ' + column);
        return geometry.nextTop - Math.max(...ends.map(point => point.y));
      });
      if (process.env.GITK_EXPANDED_LANE_DIAGNOSTICS) console.log(label + ': ' + JSON.stringify({rowHeight:geometry.rowHeight,svgHeight:geometry.svgHeight,gaps}));
      assert.ok(gaps.every(gap => Math.abs(gap)<.5), label + ': every outgoing lane reaches next row: ' + JSON.stringify({rowHeight:geometry.rowHeight,svgHeight:geometry.svgHeight,gaps}));
      assert.ok(Math.abs(geometry.rowHeight-geometry.svgHeight)<.5, label + ': SVG follows actual row height');
      assert.equal(geometry.circleY,13,label + ': reflow never moves or scales the real node');
      assert.equal(geometry.circleRadius,state.commits[geometry.index].parents.length > 1 ? 4.75 : 5,label + ': expanded rows keep their node icon size');
      assert.ok(Math.abs(geometry.belowParent-geometry.paddingBottom)<.5,label + ': no extra space below parent metadata');
      return geometry;
    }
    async function assertRaster(label) {
      const g = await assertJoined(label), png = PNG.sync.read(await page.screenshot());
      const dpr = png.width/page.viewportSize().width;
      for(let column=0;column<state.commits[g.index].outputSwimlanes.length;column++) {
        const color = state.commits[g.index].outputSwimlanes[column].color.match(/[0-9a-f]{2}/gi).map(hex=>parseInt(hex,16));
        const delta=color.map(c=>c-38), norm=delta.reduce((sum,c)=>sum+c*c,0), x=(g.svgLeft+(column+1)*11)*dpr;
        const coverage = y => {
          let value=0;
          for(let sx=Math.floor(x)-2;sx<=Math.ceil(x)+2;sx++) {
            const i=(y*png.width+sx)*4;
            value+=Math.max(0,Math.min(1,delta.reduce((sum,c,k)=>sum+(png.data[i+k]-38)*c,0)/norm));
          }
          return value;
        };
        // Expanded rows draw the title-to-detail boundary once; no overlapping 1.5x seam may appear.
        const seamY=Math.floor((g.rowTop+26)*dpr), reference=(coverage(seamY+8)+coverage(seamY+9))/2;
        const seam=[-2,-1,0,1,2].map(offset=>coverage(seamY+offset)/reference);
        assert.ok(Math.max(...seam)<=1.10,label + ': expanded lane has no internal overlap: ' + JSON.stringify(seam));
        assert.ok(Math.min(...seam)>=.94,label + ': expanded curve and tail have no dim join: ' + JSON.stringify(seam));
        let missing=0;
        for(let y=Math.ceil((g.rowTop+28)*dpr);y<Math.floor((g.rowBottom-2)*dpr);y++) {
          let ink=false;
          for(let sx=Math.floor(x)-1;sx<=Math.ceil(x)+1;sx++) {
            const i=(y*png.width+sx)*4;
            if(delta.reduce((sum,c,k)=>sum+(png.data[i+k]-38)*c,0)/norm>.2)ink=true;
          }
          if(!ink)missing++;
        }
        assert.equal(missing,0,label + ': no missing raster ink along lane ' + column);
      }
    }
    const scenarios = [
      {name:'straight', subject:commit('2',['1'],{inputSwimlanes:[],refs:['HEAD -> ink_dev','origin/ink_dev']}), next:commit('1',[])},
      {name:'merge', subject:commit('2',['1','3'],{inputSwimlanes:[],outputSwimlanes:[lane('1'),lane('3',orange)]}), next:commit('1',[],{inputSwimlanes:[lane('1'),lane('3',orange)],outputSwimlanes:[lane('3',orange)]})},
      {name:'side pass-through', subject:commit('2',['1'],{lane:1,inputSwimlanes:[lane('a',orange),lane('2')],outputSwimlanes:[lane('a',orange),lane('1')]}), next:commit('1',[],{lane:1,inputSwimlanes:[lane('a',orange),lane('1')],outputSwimlanes:[lane('a',orange)]})},
      {name:'lane shift', subject:commit('2',[],{inputSwimlanes:[lane('2'),lane('a',orange)],outputSwimlanes:[lane('a',orange)]}), next:commit('a',[],{laneColor:orange,inputSwimlanes:[lane('a',orange)]})},
    ];
    for (const scenario of scenarios) {
      // Different synthetic histories reuse the selected key; clear mounted rows between fixtures.
      state.commits = []; await publish();
      state.commits = [scenario.subject,scenario.next];
      await publish(); await page.evaluate(() => document.fonts.ready); await settle();
      if(!await row.evaluate(element=>element.classList.contains('expanded'))) { await row.locator('.commit-message-text').click(); await settle(); }
      await assertJoined(scenario.name+' initially expanded');
      await row.locator('[data-floating-kind="author"]').click(); await page.waitForTimeout(180); await settle();
      await assertJoined(scenario.name+' author transition completed');
      for(const width of [320,700,354]) { await page.setViewportSize({width,height:1200}); await settle(); await assertJoined(scenario.name+' resized '+width); }
      await page.evaluate(()=>document.documentElement.style.setProperty('--vscode-font-size','16px')); await settle();
      await assertRaster(scenario.name+' font reflow');
      await page.evaluate(()=>document.documentElement.style.setProperty('--vscode-font-size','13px')); await settle();
      await assertJoined(scenario.name+' font reset');
      for(let i=0;i<2;i++) {
        await row.locator('.commit-message-text').click(); await settle();
        assert.equal(await row.evaluate(element=>element.getBoundingClientRect().height),26,'collapsed row remains 26px');
        await row.locator('.commit-message-text').click(); await settle(); await assertJoined(scenario.name+' re-expanded '+i);
      }
      if(scenario.name==='straight'&&process.env.GITK_EXPANDED_LANE_SCREENSHOT) await page.locator('#commitVirtualRows').screenshot({path:process.env.GITK_EXPANDED_LANE_SCREENSHOT});
    }
    assert.deepEqual(errors,[]);
    console.log('Expanded commit lanes passed: screenshot message, author transition, viewport/font reflow, straight/merge/pass-through/shift lanes, raster continuity, fixed nodes and compact parent metadata.');
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
