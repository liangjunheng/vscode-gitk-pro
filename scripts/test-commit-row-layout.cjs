const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// Scoped regression: only extra space below parent-commit metadata. Preserve message/body
// content, existing 10px padding, cloud rendering, and the previous stash implementation.
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 520, height: 1200 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')), contentType: 'font/ttf',
      headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const icons = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8')
      .replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    await page.evaluate(() => {
      let saved = {};
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => saved, setState: state => { saved = state; } });
    });
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#ccc;--vscode-foreground:#ccc;--vscode-descriptionForeground:#929292;--vscode-list-activeSelectionBackground:#262626;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial}';
    await page.setContent(renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + icons + '</style>'));
    const hash = '714e22f8c3f10554f078505035e28e4f27df805f';
    const parent = 'c9ea893b03db9754b569cf92b74add6535358072';
    const title = 'feat(ink SDK开发1.0):sdk添加内存泄漏兜底机制，避免业务方忘记调用close导致native泄漏';
    const repo = { path: 'file:///commit-row-layout/a', label: 'repo-a' };
    const branch = { repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: 'a'.repeat(40) };
    const lane = hash => ({ hash, color: '#57a3f8' });
    const commit = (hash, parentHash, message, body = '') => ({
      hash, key: repo.path + ':' + hash, shortHash: hash.slice(0, 8), parents: parentHash ? [parentHash] : [], refs: [],
      message, rawMessage: message + (body ? '\n\n' + body : ''), body,
      author: 'junheng.liang', authorEmail: 'junheng.liang@tcl.com', authorDate: '2026-10-21T13:54:53+08:00', authorDateLabel: 'today',
      gitBranchOption: branch, lane: 0, laneColor: '#57a3f8', inputSwimlanes: [lane(hash)], outputSwimlanes: parentHash ? [lane(parentHash)] : [],
    });
    const subject = commit(hash, parent, title, 'Closes INKSDK-15');
    const state = {
      repositoryChanges: [], branches: [branch], selectedBranches: [branch.name], selectedRepositoryPaths: [repo.path],
      commits: [commit(branch.hash, hash, 'sdk添加nativefuture'), subject, commit(parent, '', 'sdk添加对象弱引用机制')],
      workingTreeRows: [], cloudGroups: [], files: [], stagedFiles: [], unstagedFiles: [], filesMode: 'flat', filesLoading: false,
      showStashes: false, hiddenStashCount: 0, selectedCommit: { hash, key: subject.key, repositoryPath: repo.path, kind: 'commit' },
      isLoading: false, hasMoreCommits: false,
    };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const local = page.locator('#commitVirtualRows .commit-row[data-hash="' + hash + '"]');
    async function assertCompact(row, label) {
      const geometry = await row.evaluate(element => {
        const rect = el => el.getBoundingClientRect();
        const descriptionElement = element.querySelector('.commit-description');
        const last = rect(descriptionElement.querySelector('.commit-detail-item:last-child'));
        return {
          rowHeight: rect(element).height,
          belowParent: rect(element).bottom - last.bottom,
          paddingBottom: parseFloat(getComputedStyle(descriptionElement).paddingBottom),
        };
      });
      if (process.env.GITK_PARENT_LAYOUT_DIAGNOSTICS) console.log(label, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.belowParent - geometry.paddingBottom) < .5,
        label + ': only intended padding below parent commit: ' + JSON.stringify(geometry));
    }
    await publish(); await page.evaluate(() => document.fonts.ready);
    await local.locator('.commit-message-text').click(); await settle();
    await assertCompact(local, 'normal expanded 520px');
    await local.locator('[data-floating-kind="author"]').click(); await page.waitForTimeout(180); await settle();
    await assertCompact(local, 'normal author label expanded');
    for (const width of [380, 320, 700, 420, 546]) {
      await page.setViewportSize({ width, height: 1200 }); await settle();
      if (width === 380 && process.env.GITK_PARENT_LAYOUT_SCREENSHOT) await page.locator('#commitVirtualRows').screenshot({ path: process.env.GITK_PARENT_LAYOUT_SCREENSHOT });
      await assertCompact(local, 'normal width ' + width);
    }
    for (let i = 0; i < 3; i++) {
      await local.locator('.commit-message-text').click(); await settle();
      assert.equal(await local.evaluate(el => el.getBoundingClientRect().height), 26, 'collapsed commit is exactly 26px');
      await local.locator('.commit-message-text').click(); await settle();
      await assertCompact(local, 'normal re-expanded ' + i);
    }
    assert.deepEqual(errors, []);
    console.log('Parent commit bottom spacing passed: real 714e22f8 message, author labels, 320-700px widths, repeated collapse/expansion, only intended padding under parent metadata.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
