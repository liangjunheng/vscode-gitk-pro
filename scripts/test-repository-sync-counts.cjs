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
    const buttons = ['repoPull', 'repoPush', 'worktree'].map(action => page.locator('.repo-changes [data-repo-action="' + action + '"]'));
    const cases = [
      [2, 3, true], [0, 3, true], [2, 0, true], [0, 0, true],
      [2, 3, false], [0, 3, false], [2, 0, false], [0, 0, false],
    ];
    const staged = repository.staged, unstaged = repository.unstaged;
    for (const [behind, ahead, dirty] of cases) {
      repository.behindCount = behind; repository.aheadCount = ahead;
      repository.staged = dirty ? staged : []; repository.unstaged = dirty ? unstaged : [];
      await publish();
      for (const [index, value] of [behind, ahead, dirty ? 5 : 0].entries()) {
        assert.equal(await buttons[index].locator('.repo-sync-count').textContent(), String(value));
        assert.equal(await buttons[index].locator('.repo-sync-count').isVisible(), true);
        assert.equal(await buttons[index].locator('.codicon-' + ['repo-pull', 'repo-push', 'diff-single'][index]).count(), 1);
      }
      assert.equal(await page.locator('.repo-changes-badge').count(), 0);
      // 具名分支:有修改 -> git-branch-changes + 星号;无修改 -> git-branch,无星号。
      assert.equal(await page.locator('.repo-changes-branch .codicon').getAttribute('class'), dirty ? 'codicon codicon-git-branch-changes' : 'codicon codicon-git-branch');
      assert.equal(await page.locator('.repo-changes-head-dirty').isVisible(), dirty, 'asterisk follows uncommitted changes');
      assert.equal(await page.locator('.repo-changes-head').textContent(), 'main', 'asterisk is a separate node, the branch name text is unchanged');
      for (const [index, action] of ['repoPull', 'repoPush', 'worktree'].entries()) {
        assert.match(await buttons[index].getAttribute('aria-label'), /sync-fixture：/);
        await buttons[index].locator('.repo-sync-count').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
          type: 'repositoryChangesAction', action, repositoryPath: repository.repositoryPath,
        });
      }
    }
    // 游离 HEAD:图标固定为 git-commit;星号只取决于是否有修改。
    for (const dirty of [true, false]) {
      repository.headDetached = true; repository.headLabel = 'deadbeef';
      repository.staged = dirty ? staged : []; repository.unstaged = dirty ? unstaged : [];
      await publish();
      assert.equal(await page.locator('.repo-changes-branch .codicon').getAttribute('class'), 'codicon codicon-git-commit', 'detached HEAD uses git-commit regardless of changes');
      assert.equal(await page.locator('.repo-changes-head-dirty').isVisible(), dirty, 'detached HEAD shows the asterisk only with changes');
      assert.equal(await page.locator('.repo-changes-head').textContent(), 'deadbeef');
    }
    // 回到具名分支时图标必须切回(同一张卡片被复用)。
    repository.headDetached = false; repository.headLabel = 'main'; repository.staged = []; repository.unstaged = [];
    await publish();
    assert.equal(await page.locator('.repo-changes-branch .codicon').getAttribute('class'), 'codicon codicon-git-branch', 'card returns to git-branch after leaving detached HEAD');
    // 三种图标的可见笔画到分支名的距离必须一致(以 git-commit 为准):字符盒间距 + 字形右侧留白。
    // 留白在 256px 下按 em 量取,避免小字号光栅化把 0 和 1px 混在一起。
    const inkGap = () => page.evaluate(async () => {
      await document.fonts.load('256px codicon');
      const icon = document.querySelector('.repo-changes-branch .codicon');
      const head = document.querySelector('.repo-changes-head');
      const context = document.createElement('canvas').getContext('2d');
      context.font = '256px codicon';
      const metrics = context.measureText(getComputedStyle(icon, '::before').content.slice(1, -1));
      const trailingEm = (metrics.width - metrics.actualBoundingBoxRight) / 256;
      return { cls: icon.className, gap: head.getBoundingClientRect().left - icon.getBoundingClientRect().right + trailingEm * parseFloat(getComputedStyle(icon).fontSize), boxGap: head.getBoundingClientRect().left - icon.getBoundingClientRect().right };
    });
    const gaps = {};
    for (const [key, detached, dirty] of [['commit', true, false], ['branch', false, false], ['changes', false, true]]) {
      repository.headDetached = detached; repository.headLabel = 'main';
      repository.staged = dirty ? staged : []; repository.unstaged = dirty ? unstaged : [];
      await publish();
      gaps[key] = await inkGap();
    }
    assert.match(gaps.commit.cls, /git-commit/); assert.match(gaps.branch.cls, /codicon-git-branch\b/); assert.match(gaps.changes.cls, /git-branch-changes/);
    assert.ok(gaps.commit.gap > 4, 'git-commit keeps its natural distance to the label');
    assert.ok(Math.abs(gaps.branch.gap - gaps.commit.gap) < .1, 'git-branch is as far from the branch name as git-commit: ' + JSON.stringify(gaps));
    assert.ok(Math.abs(gaps.changes.gap - gaps.commit.gap) < .1, 'git-branch-changes is as far from the branch name as git-commit: ' + JSON.stringify(gaps));
    repository.headDetached = false; repository.staged = staged; repository.unstaged = unstaged;
    await publish();
    // 星号紧跟分支名;分支名过长被省略时,星号仍完整留在按钮内。
    repository.headLabel = 'feature/' + 'very-long-branch-name-'.repeat(8); repository.staged = staged; repository.unstaged = unstaged;
    await publish();
    await page.setViewportSize({ width: 320, height: 800 });
    const longHead = await page.evaluate(() => {
      const button = document.querySelector('.repo-changes-branch').getBoundingClientRect();
      const head = document.querySelector('.repo-changes-head'), headBox = head.getBoundingClientRect();
      const mark = document.querySelector('.repo-changes-head-dirty').getBoundingClientRect();
      return { truncated: head.scrollWidth > head.clientWidth, markVisible: mark.width > 0, markInside: mark.left >= button.left && mark.right <= button.right + .5, gap: mark.left - headBox.right };
    });
    assert.equal(longHead.truncated, true, 'the long branch name is ellipsized');
    assert.equal(longHead.markVisible && longHead.markInside, true, 'asterisk stays inside the branch button when the name is truncated');
    assert.equal(longHead.gap, 0, 'asterisk directly follows the branch name');
    repository.headLabel = 'main';
    repository.behindCount = 2; repository.aheadCount = 3; repository.staged = staged; repository.unstaged = unstaged;
    await publish();
    for (const width of [320, 400, 800]) {
      await page.setViewportSize({ width, height: 800 });
      for (const button of buttons) {
        const geometry = await button.evaluate(node => {
          const header = node.closest('.repo-changes-header').getBoundingClientRect(), button = node.getBoundingClientRect();
          const label = node.querySelector('.repo-sync-count').getBoundingClientRect();
          return { fits: button.left >= header.left && button.right <= header.right && label.right <= button.right,
            noWrap: getComputedStyle(node.querySelector('.repo-sync-count')).whiteSpace === 'nowrap' };
        });
        assert.equal(geometry.fits, true, 'count fits header at ' + width);
        assert.equal(geometry.noWrap, true);
      }
    }
    assert.deepEqual(errors, []);
    if (process.env.GITK_SYNC_SCREENSHOT) {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.repo-changes-header').screenshot({ path: process.env.GITK_SYNC_SCREENSHOT });
    }
    console.log('Repository sync counts passed: separate pull/push/changed icons, deduplication, visible zero counts, repository-scoped clicks and 320/400/800px layout.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
