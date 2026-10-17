const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
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
    const repository = { repositoryPath: 'file:///sync/fixture', repositoryLabel: 'sync-fixture', isMainRepository: true,
      headLabel: 'main', aheadCount: 3, behindCount: 2,
      staged: [{ path: 'same.cpp', status: 'M' }],
      unstaged: [{ path: 'same.cpp', status: 'M' }, { path: 'new.cpp', status: 'A' }, { path: 'old.cpp', status: 'D' },
        { path: 'renamed.cpp', status: 'R' }, { path: 'conflict.cpp', status: 'M', isConflict: true }] };
    const state = { repositoryChanges: [repository], commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [],
      workingTreeRows: [], files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat',
      selectedCommit: { hash: 'uncommitted', repositoryPath: repository.repositoryPath } };
    const publish = () => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state);
    const sync = page.locator('.repo-changes [data-repo-action="syncRefresh"]');
    const count = sync.locator('.repo-sync-count');
    const cases = [
      [2, 3, true, '↓2↑3∼5'], [0, 3, true, '↓0↑3∼5'], [2, 0, true, '↓2↑0∼5'], [0, 0, true, '∼5'],
      [2, 3, false, '↓2↑3'], [0, 3, false, '↓0↑3'], [2, 0, false, '↓2↑0'], [0, 0, false, ''],
    ];
    const staged = repository.staged, unstaged = repository.unstaged;
    for (const [behind, ahead, dirty, expected] of cases) {
      repository.behindCount = behind; repository.aheadCount = ahead;
      repository.staged = dirty ? staged : []; repository.unstaged = dirty ? unstaged : [];
      await publish();
      assert.equal(await count.textContent(), expected);
      assert.equal(await count.isHidden(), !expected);
      assert.equal(await page.locator('.repo-changes-badge').count(), 0);
      if (expected) {
        assert.match(await sync.getAttribute('title'), new RegExp('拉取 ' + behind + '.*推送 ' + ahead + '.*' + (dirty ? 5 : 0) + ' 个未提交变更文件'));
        assert.match(await sync.getAttribute('aria-label'), /sync-fixture：拉取/);
        await count.click();
      } else {
        assert.equal(await sync.getAttribute('title'), '同步此仓库');
        await sync.click();
      }
      assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'repositoryChangesAction', action: 'syncRefresh', repositoryPath: repository.repositoryPath,
      });
    }
    repository.behindCount = 2; repository.aheadCount = 3; repository.staged = staged; repository.unstaged = unstaged;
    await publish();
    for (const width of [320, 400, 800]) {
      await page.setViewportSize({ width, height: 800 });
      const geometry = await sync.evaluate(node => {
        const header = node.closest('.repo-changes-header').getBoundingClientRect(), button = node.getBoundingClientRect();
        const label = node.querySelector('.repo-sync-count').getBoundingClientRect();
        return { fits: button.left >= header.left && button.right <= header.right && label.right <= button.right,
          noWrap: getComputedStyle(node.querySelector('.repo-sync-count')).whiteSpace === 'nowrap' };
      });
      assert.equal(geometry.fits, true, 'sync count fits header at ' + width);
      assert.equal(geometry.noWrap, true);
    }
    assert.deepEqual(errors, []);
    if (process.env.GITK_SYNC_SCREENSHOT) {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.repo-changes-header').screenshot({ path: process.env.GITK_SYNC_SCREENSHOT });
    }
    console.log('Repository sync counts passed: arrow prefixes, compact tilde, deduplication, zero states, sync clicks and 320/400/800px layout.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
