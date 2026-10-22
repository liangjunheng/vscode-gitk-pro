const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// Reproduce the screenshot with wrapped titles/dates and expanded floating author labels.
// Check screen coordinates and rasterized ink, not a path endpoint against its own stale viewBox.
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 520, height: 1200 }, locale: 'en-US', timezoneId: 'Asia/Shanghai', deviceScaleFactor: Number(process.env.GITK_TEST_DPR || 2) });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
      contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const icons = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8')
      .replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#ccc;--vscode-foreground:#ccc;--vscode-descriptionForeground:#929292;--vscode-list-activeSelectionBackground:#262626;--vscode-focusBorder:#383838;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    await page.evaluate(() => {
      let saved = {};
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => saved, setState: value => { saved = value; } });
    });
    await page.setContent(renderGitkWebviewHtml('codicon.css')
      .replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + icons + '</style>'));
    const h = char => char.repeat(40);
    const repo = { path: 'file:///stash-height/a', label: 'repo-a' };
    const branch = { repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: h('3') };
    const lane = hash => ({ hash, color: '#57a3f8' });
    const commit = (hash, parent, message, extra = {}) => ({
      hash, key: repo.path + ':' + hash, shortHash: hash.slice(0, 8), parents: parent ? [parent] : [], refs: [],
      message, rawMessage: message, body: '', author: 'junheng.liang', authorEmail: 'junheng.liang@tcl.com',
      authorDate: '2026-10-13T19:37:50+08:00', authorDateLabel: 'today', gitBranchOption: branch,
      lane: 0, laneColor: '#57a3f8', inputSwimlanes: [lane(hash)], outputSwimlanes: parent ? [lane(parent)] : [], ...extra,
    });
    const title = 'WIP on ink_dev: b5daaa7e feat(ink SDK开发1.0):处理首次进入笔记，出现两次redrawall的问题';
    const stash = (hash, index) => commit(hash, h('2'), title, {
      isStash: true, stashRef: 'stash@{' + index + '}', stashIndex: index,
      inputSwimlanes: [lane(h('2'))], outputSwimlanes: [lane(h('2'))],
    });
    const commits = [
      commit(h('3'), h('2'), '更新predict库', { inputSwimlanes: [] }),
      stash(h('5'), 3), stash(h('6'), 4),
      commit(h('2'), h('1'), '处理首次进入笔记'), commit(h('1'), '', '更新算法库'),
    ];
    const state = {
      repositoryChanges: [], branches: [branch], selectedBranches: [branch.name], selectedRepositoryPaths: [repo.path],
      commits, workingTreeRows: [], cloudGroups: [], showStashes: true, hiddenStashCount: 0,
      files: [], stagedFiles: [], unstagedFiles: [], filesMode: 'flat', filesLoading: false,
      selectedCommit: { key: stashKey('5'), hash: h('5'), repositoryPath: repo.path, kind: 'commit', message: title },
      isLoading: false, hasMoreCommits: false,
    };
    function stashKey(char) { return repo.path + ':' + h(char); }
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'stateUpdate', state: next },
    })), JSON.parse(JSON.stringify(state)));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const row = char => page.locator('#commitVirtualRows .commit-row[data-hash="' + h(char) + '"]');
    async function assertJoined(char, label) {
      const geometry = await row(char).evaluate(element => {
        const svg = element.querySelector('svg.graph-svg');
        const branch = svg.querySelector('.stash-branch');
        const trunk = svg.querySelector('.stash-base-lane');
        const fork = {x:trunk.x1.baseVal.value};
        const endpoint = trunk.getPointAtLength(trunk.getTotalLength()).matrixTransform(trunk.getScreenCTM());
        const start = trunk.getPointAtLength(0).matrixTransform(trunk.getScreenCTM());
        const next = element.nextElementSibling;
        const nextLink = next.classList.contains('stash')
          ? [...next.querySelectorAll('.stash-main-lane')].find(line => line.x1.baseVal.value === fork.x)
          : [...next.querySelectorAll('svg.graph-svg path')].find(path => {
            const start = path.getPointAtLength(0); return start.x === fork.x && start.y === 0;
          });
        const nextStart = nextLink.getPointAtLength(0).matrixTransform(nextLink.getScreenCTM());
        const stemEnd = branch.getPointAtLength(branch.getTotalLength()).matrixTransform(branch.getScreenCTM());
        const nextBranch = next.querySelector('.stash-branch, .stash-fork');
        const nextBranchPoint = nextBranch.getPointAtLength(next.classList.contains('stash') ? 0 : nextBranch.getTotalLength())
          .matrixTransform(nextBranch.getScreenCTM());
        const nodeX = Number(svg.querySelector('.stash-node').getAttribute('d').split(' ')[1]);
        const rowRect = element.getBoundingClientRect(), svgRect = svg.getBoundingClientRect();
        return {
          height:rowRect.height, svgHeight:svgRect.height, rowTop:rowRect.top, svgTop:svgRect.top, svgLeft:svgRect.left,
          rowBottom:rowRect.bottom, svgBottom:svgRect.bottom, start:{x:start.x,y:start.y}, end:{x:endpoint.x,y:endpoint.y},
          nextStart:{x:nextStart.x,y:nextStart.y}, nextTop:next.getBoundingClientRect().top,
          stemEnd:{x:stemEnd.x,y:stemEnd.y}, nextBranch:{x:nextBranchPoint.x,y:nextBranchPoint.y},
          color:getComputedStyle(trunk).stroke.match(/[\d.]+/g).map(Number).slice(0,3),
          dash:trunk.getAttribute('stroke-dasharray'), nodeX, trunkX:fork.x,
        };
      });
      for (const [actual, expected, reason] of [
        [geometry.svgTop, geometry.rowTop, 'SVG starts at row top'],
        [geometry.svgBottom, geometry.rowBottom, 'SVG fills actual row without cached height'],
        [geometry.end.y, geometry.nextTop, 'solid trunk reaches next row in screen coordinates'],
        [geometry.end.x, geometry.nextStart.x, 'next row receives the same real lane'],
        [geometry.end.y, geometry.nextStart.y, 'next lane starts exactly at prior endpoint'],
        [geometry.stemEnd.x, geometry.nextBranch.x, 'stash stem meets the next stem or base fork horizontally'],
        [geometry.stemEnd.y, geometry.nextBranch.y, 'stash stem reaches the next stem or base fork at the actual row boundary'],
      ]) assert.ok(Math.abs(actual - expected) < .5, label + ': ' + reason + ': ' + JSON.stringify(geometry));
      assert.equal(geometry.dash, null, label + ': real lane is never dashed');
      assert.ok(geometry.nodeX > geometry.trunkX, label + ': stash diamond is on its own side branch');
      if (process.env.GITK_TEST_LANE_DIAGNOSTICS) console.log(label + ': ' + JSON.stringify({rowHeight:geometry.height,svgHeight:geometry.svgHeight,gapToNext:geometry.nextTop-geometry.end.y}));
      return geometry;
    }
    async function assertRaster(char, label) {
      const g = await assertJoined(char, label);
      const png = PNG.sync.read(await row(char).locator('svg.graph-svg').screenshot());
      const scale = png.height / g.svgHeight, x = Math.round((g.end.x - g.svgLeft) * scale);
      const delta = g.color.map(channel => channel - 38), norm = delta.reduce((sum, channel) => sum + channel * channel, 0);
      let samples = 0, missing = 0;
      // Ignore the 1px selection outline; the entire internal trunk, including long details, must have continuous ink.
      for (let y = Math.ceil(2 * scale); y < Math.floor((g.svgHeight - 2) * scale); y++) {
        let drawn = false;
        for (let sx = Math.max(0,x-1); sx <= Math.min(png.width-1,x+1); sx++) {
          const at = (y * png.width + sx) * 4;
          const alpha = delta.reduce((sum, channel, i) => sum + (png.data[at+i] - 38) * channel, 0) / norm;
          if (alpha > .25) drawn = true;
        }
        samples++; if (!drawn) missing++;
      }
      assert.ok(samples > 20, label + ': meaningful expanded-row raster coverage');
      assert.equal(missing, 0, label + ': main trunk has no blank or dashed segments');
    }
    await publish(); await page.evaluate(() => document.fonts.ready); await settle();
    await assertJoined('5', 'collapsed consecutive stashes');
    await assertJoined('6', 'collapsed stash above base commit');
    await row('5').locator('.stash-badge').click(); await settle();
    assert.ok((await assertJoined('5', 'long title expanded')).height > 100);
    await row('5').locator('[data-floating-kind="author"]').click();
    await page.waitForTimeout(180); await settle();
    await assertJoined('5', 'expanded floating author label');
    for (const width of [380, 700, 508]) {
      await page.setViewportSize({ width, height: 1200 }); await settle();
      await assertJoined('5', 'viewport width ' + width);
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-font-size', '16px'));
    await settle(); await assertJoined('5', 'font size changed after expansion');
    await assertRaster('5', 'expanded lane ink reaches adjacent stash');
    await row('5').locator('.stash-badge').click(); await settle();
    assert.equal((await assertJoined('5', 'collapsed after wrapping')).height, 26);
    await row('5').locator('.stash-badge').click(); await settle();
    await assertJoined('5', 're-expanded with cached virtual height');
    state.selectedCommit = { key: stashKey('6'), hash: h('6'), repositoryPath: repo.path, kind: 'commit', message: title };
    await publish(); await row('6').locator('.stash-badge').click(); await settle();
    await assertJoined('6', 'second stash expanded above real base commit');
    await assertRaster('6', 'expanded lower lane ink reaches real base commit');
    if (process.env.GITK_TEST_LANE_SCREENSHOT) {
      await page.evaluate(() => document.documentElement.style.setProperty('--vscode-font-size', '13px'));
      await settle();
      await page.locator('#commitVirtualRows').screenshot({ path: process.env.GITK_TEST_LANE_SCREENSHOT });
    }
    state.cloudGroups = [{ repositoryPath: repo.path, repositoryLabel: repo.label, branchLabel: 'main', count: 1,
      commits: [commit(h('a'), h('3'), 'cloud commit')] }];
    await publish();
    const cloudBar = page.locator('#cloudCommitBars .cloud-commit-bar');
    assert.equal(await cloudBar.count(), 1, 'real cloud group rendered');
    await cloudBar.click();
    assert.equal(await page.locator('.commit-row.cloud').count(), 1, 'real cloud row participates in style check');
    const styles = await page.locator('.commit-row [stroke-dasharray]').evaluateAll(elements => elements.map(element => ({
      dash: element.getAttribute('stroke-dasharray'), width: element.getAttribute('stroke-width'), cap: element.getAttribute('stroke-linecap'),
      stash: element.matches('.stash-branch, .stash-fork'),
    })));
    assert.deepEqual([...new Set(styles.map(s => [s.dash, s.cap].join('|')))], ['2 2|butt']);
    for (const style of styles) assert.equal(style.width, '2', 'all dashed lane edges use the requested 2px stroke');
    // Changing the mounted virtual range must not reintroduce numeric height/viewBox stash sizing.
    state.cloudGroups = [];
    const tailHash = i => i.toString(16).padStart(40, '0');
    state.commits = commits.concat(Array.from({ length: 300 }, (_, i) =>
      commit(tailHash(i + 10), i < 299 ? tailHash(i + 11) : '', 'older commit ' + i)));
    await publish(); await settle();
    await page.locator('#graph').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => !document.querySelector('#commitVirtualRows .commit-row.stash'));
    await page.locator('#graph').evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('#commitVirtualRows .commit-row.stash.expanded'));
    await settle(); await assertJoined('6', 'remounted expanded row after virtual scrolling');
    await assertRaster('6', 'remounted lane still has uniform dashes');

    // A stash on a side lane must stretch the other, real pass-through lanes as well.
    const otherLane = { hash: h('d'), color: '#ffb000' };
    state.commits = [
      commit(h('3'), h('2'), 'merge', { parents: [h('2'), h('d')], inputSwimlanes: [], outputSwimlanes: [lane(h('2')), otherLane] }),
      stash(h('5'), 3),
      commit(h('2'), '', 'base on side lane', { lane: 1, inputSwimlanes: [otherLane, lane(h('2'))], outputSwimlanes: [otherLane] }),
    ];
    state.commits[1].lane = 1;
    state.commits[1].inputSwimlanes = [otherLane, lane(h('2'))];
    state.commits[1].outputSwimlanes = [otherLane, lane(h('2'))];
    state.selectedCommit = { key: stashKey('5'), hash: h('5'), repositoryPath: repo.path, kind: 'commit', message: title };
    await publish(); await settle();
    await row('5').locator('.stash-badge').click(); await settle();
    await assertJoined('5', 'side-lane stash connects to base column');
    await assertRaster('5', 'side-lane stash raster');
    const pass = await row('5').evaluate(element => {
      const line = element.querySelector('svg.graph-svg .stash-main-lane');
      const end = line.getPointAtLength(line.getTotalLength()).matrixTransform(line.getScreenCTM());
      return { y: end.y, bottom: element.getBoundingClientRect().bottom };
    });
    assert.ok(Math.abs(pass.y - pass.bottom) < .5, 'pass-through real lane also reaches actual row bottom');
    assert.deepEqual(errors, [], 'no webview errors');
    console.log('Stash adaptive lanes passed: long title/date wraps, floating-author transition, viewport/font changes, consecutive stashes, re-expansion, real screen endpoints and solid-trunk raster, virtual remount, side-lane pass-through and uniform cloud/stash branch dashes.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
