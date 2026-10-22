const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// At fractional DPRs, SVG/parent viewport clipping can erase part of a shared row edge.
// Sum lane-coloured pixel coverage across its width, comparing the seam to nearby straight segments.
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const dpr of [1.25, 1, 1.5, 2]) {
      const page = await browser.newPage({ viewport: { width: 640, height: 800 }, deviceScaleFactor: dpr });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
      await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
        body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
        contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
      }));
      const icons = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
      const theme = ':root{--vscode-editor-background:#191a1b;--vscode-editor-foreground:#ccc;--vscode-foreground:#ccc;--vscode-descriptionForeground:#929292;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-scmGraph-historyItemRefColor:#57a3f8;--vscode-scmGraph-foreground1:#ffb000}#commitVirtualRows{background:#191a1b}';
      await page.setContent(renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + icons + '</style>'));
      const h = char => char.repeat(40);
      const repo = { path: 'file:///lane-seams/a', label: 'repo-a' };
      const branch = { repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: h('4') };
      const blue = 'var(--vscode-scmGraph-historyItemRefColor)', orange = 'var(--vscode-scmGraph-foreground1)';
      const lane = (hash, color) => ({ hash: h(hash), color });
      const commit = (hash, parents, input, output, index = 0) => ({
        hash: h(hash), key: repo.path + ':' + h(hash), shortHash: hash.repeat(8), parents: parents.map(h), refs: [],
        message: 'commit ' + hash, rawMessage: 'commit ' + hash, body: '', author: 'me', authorDateLabel: 'today',
        authorDate: '2026-10-22T00:00:00+08:00', gitBranchOption: branch,
        lane: index, laneColor: index ? orange : blue, inputSwimlanes: input, outputSwimlanes: output,
      });
      const commits = [
        commit('4', ['5', '6'], [], [lane('5', blue), lane('6', orange)]),
        commit('6', ['3'], [lane('5', blue), lane('6', orange)], [lane('5', blue), lane('3', orange)], 1),
        commit('5', ['3'], [lane('5', blue), lane('3', orange)], [lane('3', blue), lane('3', orange)]),
        commit('3', ['2'], [lane('3', blue), lane('3', orange)], [lane('2', blue)]),
        commit('2', ['1'], [lane('2', blue)], [lane('1', blue)]),
        commit('1', [], [lane('1', blue)], []),
      ];
      const state = { repositoryChanges: [], branches: [branch], selectedBranches: [branch.name], selectedRepositoryPaths: [repo.path], commits,
        workingTreeRows: [], cloudGroups: [], showStashes: false, hiddenStashCount: 0, files: [], stagedFiles: [], unstagedFiles: [],
        filesMode: 'flat', filesLoading: false, selectedCommit: null, isLoading: false, hasMoreCommits: false };
      await page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
      await page.evaluate(() => document.fonts.ready);
      const measure = async () => {
        const geometry = await page.locator('#commitVirtualRows .commit-row').evaluateAll(rows => rows.map(row => {
          const r = row.getBoundingClientRect(), svg = row.querySelector('svg').getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height, svgLeft: svg.left };
        }));
        const png = PNG.sync.read(await page.screenshot());
        const background = [25, 26, 27];
        const coverage = (x, y, color) => {
          const delta = color.map((value, i) => value - background[i]);
          const norm = delta.reduce((sum, value) => sum + value * value, 0);
          let sum = 0;
          for (let sampleX = Math.floor(x) - 3; sampleX <= Math.ceil(x) + 3; sampleX++) {
            const i = (y * png.width + sampleX) * 4;
            const alpha = delta.reduce((total, value, channel) => total + (png.data[i + channel] - background[channel]) * value, 0) / norm;
            sum += Math.max(0, Math.min(1, alpha));
          }
          return sum;
        };
        const result = [];
        // Both row-boundary phases: main/side straight lanes and the merge-in boundary.
        for (const [index, column, color] of [[0, 0, [87, 163, 248]], [1, 0, [87, 163, 248]], [1, 1, [255, 176, 0]], [2, 0, [87, 163, 248]], [2, 1, [255, 176, 0]], [3, 0, [87, 163, 248]]]) {
          const boundary = geometry[index].bottom * dpr;
          assert.ok(Math.abs(geometry[index].bottom - geometry[index + 1].top) < .01, 'DOM rows are adjacent');
          const x = (geometry[index].svgLeft + (column + 1) * 11) * dpr;
          const y = Math.floor(boundary);
          const reference = [-6, -5].reduce((sum, offset) => sum + coverage(x, y + offset, color), 0) / 2;
          const minimum = Math.min(...[-1, 0, 1].map(offset => coverage(x, y + offset, color)));
          result.push({ row: index, lane: column, boundary, reference, minimum, ratio: minimum / reference });
        }
        assert.ok(geometry.every(row => row.height === 26), 'fix must not change commit row height');
        return result;
      };
      // Exercise both normal painting and independent SVG compositing, as used in embedded webviews.
      for (const composited of [true, false]) {
        const layer = composited ? await page.addStyleTag({ content: '.graph-svg{transform:translateZ(0)}' }) : null;
        const result = await measure();
        for (const seam of result) assert.ok(seam.ratio >= .94,
          'DPR ' + dpr + (composited ? ' composited' : '') + ': lane must not fade/disconnect across a commit-row seam: ' + JSON.stringify(seam));
        if (layer) await layer.evaluate(element => element.remove());
      }
      const clipping = await page.locator('#commitVirtualRows .commit-row .col-main').first().evaluate(element => {
        const style = getComputedStyle(element);
        return { overflow: style.overflow, margin: style.overflowClipMargin };
      });
      assert.deepEqual(clipping, { overflow: 'clip', margin: '1px' }, 'allow only a 1px join overlap, never unrestricted row overflow');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Commit lane seams passed: straight/side lanes, adjacent 26px rows, fractional DPR 1/1.25/1.5/2, pixel coverage at each seam.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
