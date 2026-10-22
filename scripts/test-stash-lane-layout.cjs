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
        const down = svg.querySelector('.stash-link-down');
        const endpoint = down.getPointAtLength(down.getTotalLength()).matrixTransform(down.getScreenCTM());
        const start = down.getPointAtLength(0).matrixTransform(down.getScreenCTM());
        const rowRect = element.getBoundingClientRect(), svgRect = svg.getBoundingClientRect();
        const next = element.nextElementSibling;
        const nextLink = next.querySelector('.stash-link-up, .stash-link-continuation');
        const nextStart = nextLink.getPointAtLength(0).matrixTransform(nextLink.getScreenCTM());
        return {
          height: rowRect.height, svgHeight: svgRect.height,
          rowTop: rowRect.top, svgTop: svgRect.top, svgLeft: svgRect.left, rowBottom: rowRect.bottom, svgBottom: svgRect.bottom,
          start: { x: start.x, y: start.y }, end: { x: endpoint.x, y: endpoint.y },
          nextStart: { x: nextStart.x, y: nextStart.y }, nextTop: next.getBoundingClientRect().top,
        };
      });
      for (const [actual, expected, reason] of [
        [geometry.svgTop, geometry.rowTop, 'SVG starts at the row top'],
        [geometry.svgBottom, geometry.rowBottom, 'SVG fills the row without depending on a cached height'],
        [geometry.end.y, geometry.nextTop, 'the lower dashed segment reaches the next row in SCREEN coordinates'],
        [geometry.end.x, geometry.nextStart.x, 'next row receives the line at the same x'],
        [geometry.end.y, geometry.nextStart.y, 'next dashed segment starts exactly at the prior endpoint'],
      ]) assert.ok(Math.abs(actual - expected) < .5, label + ': ' + reason + ': ' + JSON.stringify(geometry));
      if (process.env.GITK_TEST_LANE_DIAGNOSTICS) console.log(label + ': ' + JSON.stringify({
        rowHeight: geometry.height, svgHeight: geometry.svgHeight, gapToNext: geometry.nextTop - geometry.end.y,
      }));
      return geometry;
    }
    async function assertRaster(char, label) {
      const geometry = await assertJoined(char, label);
      const png = PNG.sync.read(await row(char).locator('svg.graph-svg').screenshot());
      const scale = png.height / geometry.svgHeight;
      const x = Math.round((geometry.end.x - geometry.svgLeft) * scale);
      const start = Math.ceil((geometry.start.y - geometry.svgTop + 2) * scale);
      let ink = 0, gaps = 0, gap = 0, maxGap = 0, inkRun = 0, maxInk = 0;
      for (let y = start; y < png.height; y++) {
        // A fractional DPR can split a 1.5px stroke across adjacent device columns.
        // Read its whole footprint and count >=25% stroke coverage above the controlled #262626
        // selection background. A high brightness cutoff would misclassify antialiasing as gaps.
        let drawn = false;
        for (let sampleX = Math.max(0, x - 1); sampleX <= Math.min(png.width - 1, x + 1); sampleX++) {
          const i = (y * png.width + sampleX) * 4;
          const [r, g, b] = png.data.subarray(i, i + 3);
          if (r > 38 + (146 - 38) * .25 && Math.abs(r - g) < 6 && Math.abs(g - b) < 6) drawn = true;
        }
        if (drawn) { ink++; gap = 0; maxInk = Math.max(maxInk, ++inkRun); }
        else { gaps++; inkRun = 0; maxGap = Math.max(maxGap, ++gap); }
      }
      assert.ok(ink > 0 && gaps > 0, label + ': has both ink and gaps (not solid): ' + JSON.stringify({ ink, gaps }));
      assert.ok(maxGap / scale <= 3, label + ': no long unpainted tail; longest gap=' + maxGap / scale + 'px');
      assert.ok(maxInk / scale <= 3, label + ': dash length stays 2px, longest ink=' + maxInk / scale + 'px');
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
    })));
    assert.deepEqual([...new Set(styles.map(s => [s.dash, s.width, s.cap].join('|')))], ['2 2|1.5|butt']);
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
      const line = element.querySelector('svg.graph-svg line:not(.stash-link)');
      const end = line.getPointAtLength(line.getTotalLength()).matrixTransform(line.getScreenCTM());
      return { y: end.y, bottom: element.getBoundingClientRect().bottom };
    });
    assert.ok(Math.abs(pass.y - pass.bottom) < .5, 'pass-through real lane also reaches actual row bottom');
    assert.deepEqual(errors, [], 'no webview errors');
    console.log('Stash adaptive lanes passed: long title/date wraps, floating-author transition, viewport/font changes, consecutive stashes, re-expansion, real screen endpoints and 2px ink/gap raster, virtual remount, side-lane pass-through and uniform cloud/stash dashes.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
