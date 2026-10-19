const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
  await verifyProvider();
  if (process.argv.includes('--provider-only')) {
    console.log('Repository changes provider checks passed');
    return;
  }
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-icon-foreground:#aeb4bc;--vscode-descriptionForeground:#929292;--vscode-editorWidget-background:#202020;--vscode-tab-activeBackground:#202020;--vscode-tab-activeForeground:#cccccc;--vscode-editorGroup-border:#343434;--vscode-widget-border:#343434;--vscode-panel-border:#303030;--vscode-sideBarSectionHeader-background:#181818;--vscode-input-background:#1f1f1f;--vscode-input-foreground:#cccccc;--vscode-input-border:#383838;--vscode-button-background:#176c8b;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#2284a7;--vscode-focusBorder:#007fd4;--vscode-list-hoverBackground:#282828;--vscode-list-activeSelectionBackground:#37373d;--vscode-list-activeSelectionForeground:#ffffff;--vscode-badge-background:#24758e;--vscode-badge-foreground:#ffffff;--vscode-gitDecoration-modifiedResourceForeground:#d9b87a;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({ body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')), contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route('https://gitk.test/seti.woff', route => route.fulfill({ body: fs.readFileSync(path.resolve(__dirname, '../media/seti/seti.woff')), contentType: 'font/woff', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const iconCss = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const html = renderGitkWebviewHtml('codicon.css', 'https://gitk.test/seti.woff', { cpp: ['E01A', '#123456'] }).replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + iconCss + '</style>');
    await verifyPinnedHeaderPixels(browser, html);
    await verifyRepositoryDisplayModes(browser, html);
    await verifyRepositoryHeaderBorderTransitions(browser, html);
    await verifyRepositorySnapshotTransitions(browser, html);
    for (const width of [320, 400, 800]) await verifyBottomRepositoryExpansion(browser, html, width);
    const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    scripts.forEach(script => new Function(script));
    await page.addInitScript(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    // setContent does not run addInitScript, so install the shim explicitly as well.
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);
    const repositories = ['inkengine', 'ink-predict-sdk', 'ink-algorithm', 'ink-render', 'ink-common', 'ink-gfx'].map((name, index) => ({
      repositoryPath: 'file:///fixture/' + name, repositoryLabel: name, isMainRepository: index === 0,
      repositoryAncestry: index === 1 ? [{ label: 'inkengine' }] : index === 2 ? [{ label: 'inkengine' }, { label: 'ink-predict-sdk' }, { label: 'ink-algorithm-parent' }] : [],
      hasSubmodules: index === 0 || index === 3, isSubmodule: index !== 0 && index !== 4,
      headLabel: index ? 'd3eed0b4' : 'ink_dev', message: '', committing: false,
      staged: index === 0 ? [{ path: 'same.cpp', status: 'M' }] : [],
      unstaged: index === 0 ? [{ path: 'same.cpp', status: 'M' }, { path: 'other.cpp', status: 'M' }] : [],
    }));
    const state = { repositoryChanges: repositories, commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [], workingTreeRows: [],
      files: [{ path: 'historic.cpp', status: 'M' }], stagedFiles: [], unstagedFiles: [], filesLoading: false,
      selectedCommit: { hash: '12345678', repositoryPath: repositories[0].repositoryPath }, filesMode: 'flat' };
    const publish = async () => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state);
    repositories[0].aheadCount = 4;
    repositories[0].behindCount = 0;
    await publish();
    await assertCount(page.locator('.repo-changes'), 6);
    assert.equal(await page.locator('.repo-changes').nth(1).locator('.repo-changes-ancestry').textContent(), 'inkengine', 'direct child shows its parent repository');
    assert.equal(await page.locator('.repo-changes').nth(2).locator('.repo-changes-ancestry').textContent(), 'inkengine/.../ink-algorithm-parent', 'nested child compresses the recursive parent path');
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-changes-ancestry').isHidden(), true, 'root repository has no parent path');
    const rootSync = page.locator('.repo-changes').first().locator('[data-repo-action="syncRefresh"]');
    assert.equal(await rootSync.locator('.repo-sync-count').textContent(), '↓0↑4∼2', 'sync prefixes commit counts with arrows and appends deduplicated changes without spaces');
    assert.match(await rootSync.getAttribute('title'), /拉取 0.*推送 4.*2 个未提交变更文件/);
    repositories[0].aheadCount = 0; await publish();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await rootSync.locator('.repo-sync-count').textContent(), '↓0↑0∼2', 'local changes keep the complete sync status group visible');
    assert.match(await rootSync.getAttribute('title'), /2 个未提交变更文件/);
    const cleanSync = page.locator('.repo-changes').nth(1).locator('[data-repo-action="syncRefresh"]');
    assert.equal(await cleanSync.locator('.repo-sync-count').isHidden(), true, 'fully clean repositories show only the sync icon');
    assert.equal(await cleanSync.locator('.repo-sync-count').textContent(), '');
    assert.equal(await cleanSync.getAttribute('title'), '同步此仓库');
    repositories[0].aheadCount = 4; await publish();
    repositories[1].message = 'unstaged-only draft'; await publish();
    assert.equal(await page.locator('.repo-changes').nth(1).locator('.repo-commit-main').isDisabled(), true, 'a repository with only unstaged changes cannot be committed');
    repositories[1].message = ''; await publish();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('18px seti')), true, 'Seti file icon font must load');
    const originalChildUnstaged = repositories[1].unstaged;
    repositories[1].unstaged = [
      { path: 'native.cpp', status: 'M' }, { path: 'View.kt', status: 'M' }, { path: 'app.ts', status: 'M' },
      { path: 'script.js', status: 'M' }, { path: 'tool.py', status: 'M' }, { path: 'lib.rs', status: 'M' },
      { path: 'config.json', status: 'M' }, { path: 'README.md', status: 'M' }, { path: 'logo.png', status: 'M' },
      { path: 'manual.pdf', status: 'M' }, { path: 'bundle.zip', status: 'M' }, { path: 'cache.sqlite', status: 'M' },
      { path: 'build.ps1', status: 'M' }, { path: 'native.dll', status: 'M' }, { path: '.clangd', status: 'M' },
      { path: 'unknown.asset', status: 'M' },
      { path: 'unknown-submodule', status: 'M', isGitlink: true },
      { path: 'leaf-submodule', status: 'M', isGitlink: true, gitlinkHasSubmodules: false },
      { path: 'parent-submodule', status: 'M', isGitlink: true, gitlinkHasSubmodules: true },
    ];
    await publish();
    assert.deepEqual(await page.locator('.repo-changes').nth(1).locator('.repo-file-icon').evaluateAll(nodes => nodes.map(node => node.dataset.fileIcon)), [
      'cpp', 'kotlin', 'typescript', 'javascript', 'python', 'rust', 'json', 'info', 'image', 'pdf', 'zip', 'database', 'powershell', 'hex', 'config', 'default', 'repo', 'archive', 'repo',
    ]);
    assert.equal(await page.locator('.repo-changes').nth(1).locator('.repo-file-icon').first().evaluate(node => getComputedStyle(node).color), 'rgb(18, 52, 86)', 'runtime Seti definitions override the bundled fallback map');
    repositories[1].unstaged = originalChildUnstaged;
    await publish();
    const cardTransition = await page.locator('.repo-changes').first().evaluate(card => ({
      divider: getComputedStyle(card.querySelector('.repo-changes-header')).borderBottomColor,
      bodyPaddingTop: getComputedStyle(card.querySelector('.repo-changes-body')).paddingTop,
      marginBottom: getComputedStyle(card).marginBottom,
    }));
    assert.notEqual(cardTransition.divider, 'rgb(52, 52, 52)', 'expanded repository header uses a softened divider instead of the theme widget border');
    assert.equal(cardTransition.bodyPaddingTop, '6px', 'repository body sits closer to the softened header transition');
    assert.equal(cardTransition.marginBottom, '12px', 'repository cards use 50 percent more vertical spacing');
    const selectorPosition = await page.evaluate(() => {
      const header = document.getElementById('commitHeader').getBoundingClientRect();
      const selectors = document.getElementById('commitSelectors').getBoundingClientRect();
      const search = document.getElementById('commitSearchRow').getBoundingClientRect();
      return { headerBottom: header.bottom, selectorTop: selectors.top, selectorBottom: selectors.bottom, searchTop: search.top };
    });
    assert.ok(Math.abs(selectorPosition.selectorTop - selectorPosition.headerBottom) < 1, 'branch and repository selector follows the commit header');
    assert.ok(Math.abs(selectorPosition.searchTop - selectorPosition.selectorBottom) < 1, 'selector sits directly above commit search');
    const iconTextGaps = await page.locator('.repo-changes').first().evaluate(card => {
      const repoIcon = card.querySelector('.repo-changes-icon .codicon').getBoundingClientRect();
      const repoLabel = card.querySelector('.repo-changes-label').getBoundingClientRect();
      const branchIcon = card.querySelector('.repo-changes-branch .codicon').getBoundingClientRect();
      const branchLabel = card.querySelector('.repo-changes-head').getBoundingClientRect();
      return { repo: repoLabel.left - repoIcon.right, branch: branchLabel.left - branchIcon.right };
    });
    assert.equal(iconTextGaps.repo, 0, 'repository icon touches its label');
    assert.equal(iconTextGaps.branch, 0, 'branch icon touches its label');
    await assertCount(page.locator('#refreshBtn'), 0);
    await assertCount(page.locator('#filesRefreshBtn'), 1);
    assert.deepEqual(await page.locator('#filesActions button').evaluateAll(buttons => buttons.map(button => button.id)), ['uncommittedRepoBadge', 'filesRefreshBtn', 'filesModeBtn'], 'refresh follows Open Commit Panel in the files header');
    await page.locator('#filesRefreshBtn').click();
    assert.deepEqual(await lastMessage(page), { type: 'refresh' }, 'refresh is local data only, not a Git sync action');
    assert.equal(await page.locator('#filesRefreshProgress').isVisible(), false);
    state.refreshProgress = { completed: 1, total: 4 }; await publish();
    assert.equal(await page.locator('#filesRefreshProgress').isVisible(), true);
    assert.equal(await page.locator('#filesRefreshProgress').getAttribute('aria-valuenow'), null, 'refresh indicator is indeterminate');
    assert.equal(await page.locator('#filesRefreshProgressFill').evaluate(node => getComputedStyle(node).animationName), 'files-refresh-scroll');
    assert.equal(await page.locator('#filesRefreshProgressFill').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 122, 204)');
    delete state.refreshProgress; await publish();
    assert.equal(await page.locator('#filesRefreshProgress').isVisible(), false, 'refresh completion hides the progress bar');
    await assertCount(page.locator('#repositoryTerminalBtn'), 0);
    await assertCount(page.locator('.repo-changes-icon .has-submodules'), 2);
    await assertCount(page.locator('.repo-submodules-marker'), 0);
    for (const icon of await page.locator('.repo-changes-icon').all()) await assertCount(icon.locator('.codicon'), 1);
    await assertCount(page.locator('.repo-changes-icon .codicon-archive'), 3);
    assert.equal(await page.locator('.repo-changes-icon').nth(4).getAttribute('title'), '独立仓库（无子仓库）');
    assert.equal(await page.locator('.repo-changes-icon').nth(3).getAttribute('title'), '包含子仓库');
    repositories[1].hasSubmodules = true; await publish();
    await assertCount(page.locator('.repo-changes-icon').nth(1).locator('.codicon-archive'), 0);
    await assertCount(page.locator('.repo-changes-icon').nth(1).locator('.has-submodules'), 1);
    await assertCount(page.locator('.repo-changes-icon').nth(1).locator('.codicon'), 1);
    repositories[1].hasSubmodules = false; await publish();
    await assertCount(page.locator('.repo-changes-icon').nth(1).locator('.codicon-archive'), 1);
    await assertCount(page.locator('.repo-changes-icon').nth(1).locator('.repo-submodules-marker'), 0);
    await assertCount(page.locator('.repo-message-hint'), 0);
    await assertCount(page.locator('.repo-commit-main .codicon-check'), 0);
    await assertCount(page.locator('.repo-changes-body:visible'), 1);
    await assertCount(page.locator('.repo-message:visible'), 0);
    await verifyHistoricalMessage(page, state, publish, repositories);
    await publish();
    await assertCount(page.locator('.repo-changes-body:visible'), 1);
    state.repositoryChanges = [...repositories].reverse();
    await publish();
    assert.equal(await page.locator('.repo-changes').filter({ has: page.locator('.repo-changes-label', { hasText: 'inkengine' }) }).locator('.repo-changes-body').isVisible(), true, 'topology ordering must not define the main repository');
    const discovered = { ...repositories[1], repositoryPath: 'file:///fixture/new-child', repositoryLabel: 'new-child' };
    state.repositoryChanges = [...repositories, discovered];
    await publish();
    assert.equal(await page.locator('.repo-changes').last().locator('.repo-changes-body').isVisible(), false, 'late-discovered child starts collapsed');
    state.repositoryChanges = repositories;
    await publish();
    for (const toggle of (await page.locator('.repo-changes-toggle').all()).slice(1)) await toggle.click();
    await assertCount(page.locator('.repo-changes-body:visible'), 6);
    await verifyBranchDropdown(page, state, publish);
    await verifyMultiDiffLinkage(page, state, publish, repositories);
    const gutterLayout = () => page.evaluate(() => {
      const list = document.getElementById('repositoryChangesList');
      return {
        clientWidth: list.clientWidth,
        overflowing: list.scrollHeight > list.clientHeight,
        gutter: getComputedStyle(list).scrollbarGutter,
        paddingLeft: getComputedStyle(list).paddingLeft,
        paddingRight: getComputedStyle(list).paddingRight,
        headerWidths: Array.from(list.querySelectorAll('.repo-changes-header'), header => header.getBoundingClientRect().width),
        cardGaps: Array.from(list.querySelectorAll('.repo-changes'), card => {
          const listRect = list.getBoundingClientRect(), cardRect = card.getBoundingClientRect();
          return { left: cardRect.left - listRect.left, right: listRect.right - cardRect.right };
        }),
      };
    });
    const expandedLayout = await gutterLayout();
    assert.equal(await page.locator('#repositoryChangesList').evaluate(node => getComputedStyle(node).paddingTop), '5px', 'first repository card keeps 5px spacing below the panel header');
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes.focused'), 1);
    assert.equal(expandedLayout.gutter, 'auto', 'overlay scrollbar does not reserve a gutter');
    assert.equal(expandedLayout.paddingLeft, '2px');
    assert.equal(expandedLayout.paddingRight, '2px');
    assert.ok(expandedLayout.cardGaps.every(gap => Math.abs(gap.left - 2) < 1 && Math.abs(gap.right - 2) < 1), 'repository cards retain 2px spacing on both sides');
    const focusBorder = await page.locator('.repo-changes').filter({ has: page.locator('.repo-changes-header') }).nth(0).evaluate(card => {
      const cardRect = card.getBoundingClientRect();
      const listRect = document.getElementById('repositoryChangesList').getBoundingClientRect();
      const scrollbarRect = document.getElementById('repositoryChangesScrollbar').getBoundingClientRect();
      return { cardRight: cardRect.right, listRight: listRect.right, scrollbarLeft: scrollbarRect.left };
    });
    assert.ok(focusBorder.cardRight <= focusBorder.listRight - 2 + 1);
    assert.ok(focusBorder.scrollbarLeft < focusBorder.listRight, 'vertical overlay remains inside its clipped viewport');
    assert.equal(await page.locator('.repo-changes.focused').count(), 1, 'one focused card owns the right focus border');
    assert.equal(await page.locator('.repo-changes.focused').evaluate(card => getComputedStyle(card).borderRightColor), 'rgb(0, 127, 212)', 'focused card retains its visible right focus border');
    assert.equal(expandedLayout.overflowing, true, 'expanded fixture requires a scrollbar');
    const stickyHeader = page.locator('.repo-changes').first().locator('.repo-changes-header');
    const listBounds = await page.locator('#repositoryChangesList').boundingBox();
    await page.locator('#repositoryChangesList').evaluate(node => { node.scrollTop = 20; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await stickyHeader.evaluate(node => getComputedStyle(node).position), 'sticky');
    assert.notEqual(await stickyHeader.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'pinned header is opaque');
    assert.equal(await stickyHeader.evaluate(node => getComputedStyle(node).zIndex), '2');
    assert.equal(await stickyHeader.evaluate(node => getComputedStyle(node, '::after').backgroundColor), 'rgb(0, 127, 212)', 'focused pinned header keeps its top focus line inside the scroll viewport');
    await page.locator('#repositoryChangesList').evaluate(node => { node.scrollTop = 0; });
    for (const toggle of await page.locator('.repo-changes-toggle').all()) await toggle.click();
    const collapsedLayout = await gutterLayout();
    assert.equal(collapsedLayout.overflowing, false, 'collapsed fixture has no scroll overflow');
    assert.equal(collapsedLayout.clientWidth, expandedLayout.clientWidth, 'scrollbar appearance must not change usable width');
    assert.deepEqual(collapsedLayout.headerWidths, expandedLayout.headerWidths, 'headers retain their width when scrollbar disappears');
    for (const toggle of await page.locator('.repo-changes-toggle').all()) await toggle.click();
    assert.deepEqual((await gutterLayout()).headerWidths, collapsedLayout.headerWidths, 'reopening repositories must not shift UI widths');
    assert.equal(await page.locator('#filesList').isVisible(), false, 'no separate historical file list remains');
    state.selectedCommit = { hash: '12345678', repositoryPath: repositories[0].repositoryPath, message: '历史提交', body: '提交说明' };
    await publish();
    await assertCount(page.locator('.repo-changes').first().locator('.repo-group[data-section="commit"] .repo-file'), 1);
    await assertCount(page.locator('.repo-changes').nth(1).locator('.repo-group[data-section="commit"]'), 0);
    state.files = [{ path: 'root-history.cpp', diffKey: 'root-history-key', status: 'M' }]; await publish();
    state.selectedCommit = { hash: 'child-history', repositoryPath: repositories[1].repositoryPath, message: 'child title', body: 'child body', rawMessage: 'child title\n\nchild body' };
    state.files = [{ path: 'child-history.cpp', diffKey: 'child-history-key', status: 'M' }]; await publish();
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-details').isVisible(), true, 'root historical editor remains visible after child selection');
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-main').isVisible(), false, 'root does not regain Commit button after child selection');
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-group[data-section="commit"] .repo-file-name').textContent(), 'root-history.cpp');
    state.selectedCommit = null; state.files = []; state.filesLoading = true; await publish();
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-details').isVisible(), true, 'repository reset loading does not clear root history card');
    state.selectedCommit = { hash: 'child-history', repositoryPath: repositories[1].repositoryPath, message: 'child title', body: 'child body', rawMessage: 'child title\n\nchild body' }; state.files = [{ path: 'child-history.cpp', diffKey: 'child-history-key', status: 'M' }]; state.filesLoading = false; await publish();
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-details').isVisible(), true, 'root history remains after repository reset transition');
    state.selectedCommit = { hash: 'child-history', repositoryPath: repositories[1].repositoryPath, message: 'child title', body: 'child body', rawMessage: 'child title\n\nchild body' };
    state.files = []; state.filesLoading = true; await publish();
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-details').isVisible(), true, 'loading transition does not clear root commit editor');
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-group[data-section="commit"] .repo-file-name').textContent(), 'root-history.cpp', 'loading transition preserves root commit files');
    state.files = [{ path: 'child-history.cpp', diffKey: 'child-history-key', status: 'M' }]; state.filesLoading = false; await publish();
    state.files = [{ path: 'root-history.cpp', diffKey: 'root-history-key', status: 'M' }];
    await publish();
    state.selectedCommit = { hash: 'child-history', repositoryPath: repositories[1].repositoryPath, message: 'child title', body: 'child body', rawMessage: 'child title\n\nchild body' };
    state.files = [{ path: 'child-history.cpp', diffKey: 'child-history-key', status: 'M' }];
    await publish();
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-details').inputValue(), '历史提交\n\n提交说明', 'root card retains its own historical message when focus moves to child');
    await assertCount(page.locator('.repo-changes').first().locator('.repo-group[data-section="commit"] .repo-file'), 1);
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-group[data-section="commit"] .repo-file-name').textContent(), 'root-history.cpp');
    assert.equal(await page.locator('.repo-changes').nth(1).locator('.repo-commit-details').inputValue(), 'child title\n\nchild body');
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[1].repositoryPath }; state.files = [];
    await publish();
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-details').inputValue(), '历史提交\n\n提交说明', 'root historical card does not fall back to Uncommitted Changes');
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-commit-main').isVisible(), false);
    for (const header of await page.locator('.repo-changes-header').all()) {
      assert.deepEqual(await header.locator('[data-repo-action]').evaluateAll(buttons => buttons.map(button => button.dataset.repoAction)), ['toggle', 'branch', 'syncRefresh', 'terminal'], 'header removes the worktree badge and keeps terminal after sync');
    }
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes-body:visible'), 6);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].repositoryPath }, 'selecting the current repository keeps it expanded');
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes-body:visible'), 5);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'blur', repositoryPath: repositories[0].repositoryPath }, 'focused title toggles collapse');
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes-body:visible'), 6);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].repositoryPath }, 'collapsed title expands and focuses');
    const mainCard = page.locator('.repo-changes').first();
    await mainCard.locator('.repo-changes-label').click();
    await mainCard.locator('.repo-changes-header').click({ position: { x: 2, y: 15 } });
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'focused header blank area reselects without collapsing');
    await mainCard.locator('.repo-changes-header').click({ position: { x: 2, y: 15 } });
    await mainCard.locator('.repo-changes-label').click();
    await mainCard.locator('.repo-changes-body').click({ position: { x: 2, y: 3 } });
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'body padding keeps the repository expanded');
    await mainCard.locator('.repo-changes-toggle').click();
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), false, 'chevron remains the explicit collapse control');
    await mainCard.locator('.repo-changes-title .codicon-repo').click();
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'repository icon expands the card');
    await mainCard.locator('.repo-changes-toggle').click();
    await mainCard.press('Enter');
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'container Enter expands without activating embedded controls');
    await mainCard.press('Space');
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'container Space reselects without collapsing');
    await page.locator('.repo-changes').nth(1).locator('.repo-changes-label').click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[1].repositoryPath });
    await mainCard.locator('.repo-changes-body').click({ position: { x: 2, y: 3 } });
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].repositoryPath }, 'blank-area selection refocuses the expanded owner');
    assert.equal(await mainCard.evaluate(node => node === document.activeElement && node.classList.contains('focused')), true);
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true);
    state.selectedRepositoryPaths = [repositories[0].repositoryPath]; await publish();
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'host confirmation does not fold a reselected repository');
    await mainCard.locator('.repo-changes-label').click();
    await page.evaluate(repository => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedRepoDisplayChanged', repository: { path: repository.repositoryPath, label: repository.repositoryLabel, hasSubmodules: true, isSubmodule: false } } }));
    }, repositories[0]);
    await assertCount(page.locator('#repositoryDropdown'), 0);
    await assertCount(page.locator('#repositoryDisplay button, #repositoryDisplay input, #repositoryDisplay .dropdown-menu'), 0);
    const beforeDisplayClick = await page.evaluate(() => window.messages.length);
    await page.locator('#repositoryDisplay').click();
    assert.equal(await page.evaluate(() => window.messages.length), beforeDisplayClick, 'history repository name is display-only');
    assert.match(await page.locator('#repositoryDisplay').textContent(), /inkengine/);
    const selectorTypography = await page.evaluate(() => {
      const branch = getComputedStyle(document.querySelector('#branchDropdown .dropdown-value'));
      const repository = getComputedStyle(document.querySelector('#repositoryDisplay .dropdown-value'));
      const card = getComputedStyle(document.querySelector('.repo-changes-label'));
      return {
        branch: { fontFamily: branch.fontFamily, fontSize: branch.fontSize, fontStyle: branch.fontStyle, fontWeight: branch.fontWeight, lineHeight: branch.lineHeight },
        repository: { fontFamily: repository.fontFamily, fontSize: repository.fontSize, fontStyle: repository.fontStyle, fontWeight: repository.fontWeight, lineHeight: repository.lineHeight },
        card: { fontFamily: card.fontFamily, fontSize: card.fontSize, fontStyle: card.fontStyle, fontWeight: card.fontWeight, lineHeight: card.lineHeight }
      };
    });
    assert.deepEqual(selectorTypography.branch, selectorTypography.card, 'branch label matches the repository card title typography');
    assert.deepEqual(selectorTypography.repository, selectorTypography.card, 'repository name after @ matches the repository card title typography');
    const repositoryLabelGap = await page.locator('#repositoryDisplay').evaluate(display => {
      const icon = display.querySelector('.repository-icon').getBoundingClientRect();
      const label = display.querySelector('.dropdown-value').getBoundingClientRect();
      return label.left - icon.right;
    });
    assert.equal(repositoryLabelGap, 0, 'repository icon touches its name in the selector');
    const selectorGaps = await page.evaluate(() => {
      const branch = document.getElementById('branchSelector').getBoundingClientRect();
      const separator = document.querySelector('.selector-separator').getBoundingClientRect();
      const repository = document.getElementById('repositoryDisplay').getBoundingClientRect();
      return { left: separator.left - branch.right, right: repository.left - separator.right };
    });
    assert.equal(selectorGaps.left, 6, '@ keeps the same gap after the branch selector');
    assert.equal(selectorGaps.right, 6, '@ keeps the same gap before the repository name');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'repoLoadingChanged', loading: true } })));
    assert.equal(await page.locator('#repositoryDisplay .dropdown-spinner').isVisible(), true);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'repoLoadingChanged', loading: false } })));
    assert.equal(await page.locator('#repositoryDisplay .dropdown-spinner').isVisible(), false);
    repositories[0].staged = [{ path: 'same.cpp', status: 'M' }];
    repositories[0].unstaged = [{ path: 'same.cpp', status: 'M' }, { path: 'other.cpp', status: 'M' }];
    state.repositoryChanges = repositories; await publish();
    await assertCount(page.locator('.repo-changes-badge'), 0);
    assert.equal(await rootSync.locator('.repo-sync-count').textContent(), '↓0↑4∼2', 'sync count deduplicates staged and unstaged paths');
    await rootSync.locator('.repo-sync-count').click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'syncRefresh', repositoryPath: repositories[0].repositoryPath });
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'sync control does not toggle its card');
    const beforeCollapse = await page.evaluate(() => window.messages.length);
    await page.locator('.repo-changes-toggle').nth(1).click();
    assert.equal(await page.evaluate(() => window.messages.length), beforeCollapse, 'collapse must not change history repository');
    await assertCount(page.locator('.repo-changes-body:visible'), 5);
    const childTerminal = page.locator('.repo-changes').nth(1).locator('[data-repo-action="terminal"]');
    await childTerminal.click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'terminal', repositoryPath: repositories[1].repositoryPath });
    assert.equal(await page.locator('.repo-changes-body').nth(1).isVisible(), false, 'terminal does not expand a folded repository');
    await page.locator('.repo-changes-branch').nth(1).click();
    let branchMessage = await lastMessage(page);
    assert.deepEqual(branchMessage, { type: 'repositoryChangesAction', action: 'branch', repositoryPath: repositories[1].repositoryPath });
    await assertCount(page.locator('.repo-changes-body:visible'), 5);
    await page.locator('.repo-changes-toggle').nth(2).click();
    await assertCount(page.locator('.repo-changes-body:visible'), 4);
    await page.locator('.repo-changes-toggle').nth(1).click();
    await assertCount(page.locator('.repo-changes-body:visible'), 5);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[1].repositoryPath }, 'expansion activates repository history');
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath }; await publish();
    const input = page.locator('.repo-message').first();
    const commitHeight = await page.locator('.repo-commit-main').first().evaluate(button => button.getBoundingClientRect().height);
    assert.equal(commitHeight, 28, 'Commit split button stays compact and aligns both controls');
    assert.equal(await page.locator('.repo-changes').first().evaluate(card => card.querySelector('.repo-file-groups').getBoundingClientRect().top - card.querySelector('.repo-commit-actions').getBoundingClientRect().bottom), 4, 'Commit-to-files gap is compact');
    assert.equal(await page.locator('.repo-commit-more').first().evaluate(button => button.getBoundingClientRect().height), commitHeight);
    const initialInputHeight = await input.evaluate(node => node.getBoundingClientRect().height);
    await input.fill(Array.from({ length: 16 }, (_, index) => '提交正文第 ' + index + ' 行：' + 'wrap '.repeat(14)).join('\n'));
    const multiline = await input.evaluate(node => {
      const css = getComputedStyle(node);
      return { height: node.getBoundingClientRect().height, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, resize: css.resize, overflowX: css.overflowX, overflowY: css.overflowY, maxHeight: css.maxHeight };
    });
    assert.ok(multiline.height > initialInputHeight && multiline.height > 160, 'multiline message grows rather than clipping at the old limit');
    assert.ok(multiline.scrollHeight <= multiline.clientHeight + 1, 'textarea fits all content without internal scrolling');
    assert.equal(multiline.resize, 'none');
    assert.equal(multiline.overflowX, 'hidden'); assert.equal(multiline.overflowY, 'hidden');
    assert.equal(multiline.maxHeight, 'none');
    await input.fill('draft in root');
    await input.click();
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'message editor never toggles its card');
    assert.ok(await input.evaluate(node => node.getBoundingClientRect().height) < multiline.height, 'shortened message shrinks back');
    await input.focus();
    assert.ok(await page.evaluate(repositoryPath => window.messages.some(message => message.action === 'focus' && message.repositoryPath === repositoryPath), repositories[0].repositoryPath), 'input focus activates owning repository');
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[3].repositoryPath };
    repositories[3].unstaged = [{ path: 'same.cpp', status: 'M' }];
    await publish();
    assert.equal(await input.inputValue(), 'draft in root');
    assert.equal(await input.evaluate(node => node === document.activeElement), true, 'snapshot updates must preserve input focus');
    assert.equal(await page.locator('.repo-changes-body').nth(2).isVisible(), false, 'snapshot updates must preserve independent collapse state');
    await page.locator('.repo-file').filter({ hasText: 'other.cpp' }).click();
    let message = await lastMessage(page);
    assert.equal(message.type, 'repositoryChangesFile');
    assert.equal(message.repositoryPath, repositories[0].repositoryPath);
    assert.equal(message.path, 'other.cpp');
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), true, 'file selection does not toggle its card');
    const otherCard = page.locator('.repo-changes').nth(3);
    if (!(await otherCard.locator('.repo-changes-body').isVisible())) await otherCard.locator('.repo-changes-label').click();
    await otherCard.locator('.repo-file').click();
    message = await lastMessage(page);
    assert.equal(message.repositoryPath, repositories[3].repositoryPath, 'same names in different repositories must not share their owner');
    repositories[0].committing = true; await publish();
    assert.equal(await page.locator('.repo-commit-main').first().getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.repo-commit-label').first().textContent(), '提交中…');
    assert.equal(await page.locator('.repo-commit-more').first().isDisabled(), true);
    repositories[0].committing = false; await publish();
    assert.equal(await input.inputValue(), 'draft in root', 'busy feedback must not change draft text');
    await page.locator('.repo-commit-main').first().click();
    message = await lastMessage(page);
    assert.equal(message.type, 'workingTreeCommit');
    assert.equal(message.message, 'draft in root');
    assert.equal(message.repositoryPath, repositories[0].repositoryPath);
    await page.locator('.repo-changes').first().locator('.repo-group[data-section="unstaged"] .repo-group-header [data-repo-action="stage"]').click();
    message = await lastMessage(page);
    assert.deepEqual(message.paths, ['same.cpp', 'other.cpp']);
    assert.equal(message.repositoryPath, repositories[0].repositoryPath);
    await page.locator('.repo-changes').first().locator('.repo-group[data-section="unstaged"] .repo-group-header [data-repo-action="discard"]').click();
    message = await lastMessage(page);
    assert.equal(message.action, 'discard');
    assert.equal(message.section, 'unstaged');
    assert.deepEqual(message.paths, ['same.cpp', 'other.cpp']);
    assert.equal(message.repositoryPath, repositories[0].repositoryPath);
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[3].repositoryPath };
    state.files = []; state.filesLoading = true;
    await publish();
    await assertCount(page.locator('.repo-changes'), 6);
    assert.equal(await page.locator('#filesList').isVisible(), false, 'worktree loading must not replace the repository list');
    repositories[0].unstaged = [{ path: 'changed-without-new-count.cpp', status: 'M' }];
    await publish();
    await assertCount(page.locator('.repo-file').filter({ hasText: 'changed-without-new-count.cpp' }), 1);
    repositories[5].unstaged = [{ path: 'conflict.cpp', status: 'U', isConflict: true }];
    repositories[5].staged = [{ path: 'conflict.cpp', status: 'U', isConflict: true }];
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[5].repositoryPath };
    await publish();
    await assertCount(page.locator('.repo-changes').nth(5).locator('.repo-file'), 1);
    assert.equal(await page.locator('.repo-changes').nth(5).locator('.repo-commit-main').isDisabled(), true, 'conflict blocks commit');
    state.selectedRepositoryPaths = [repositories[0].repositoryPath];
    state.commits = [{ hash: '12345678', shortHash: '12345678', key: repositories[0].repositoryPath + ':12345678', parents: [], refs: [], message: 'root history', author: 'tester', authorDateLabel: 'today', gitBranchOption: { repoOption: { path: repositories[0].repositoryPath, label: 'inkengine' }, name: 'refs/heads/main', label: 'main', kind: 'current', hash: '12345678' } }];
    state.selectedCommit = { hash: '12345678', repositoryPath: repositories[0].repositoryPath };
    state.filesLoading = false;
    await publish();
    const messagesBeforeUnfocusedCollapse = await page.evaluate(() => window.messages.length);
    await page.locator('.repo-changes-toggle').nth(4).click();
    assert.equal(await page.evaluate(() => window.messages.length), messagesBeforeUnfocusedCollapse);
    assert.deepEqual(errors, [], 'history fixture must render before collapse');
    assert.notEqual(await page.locator('#commitList').textContent(), '暂未选中仓库');
    const messagesBeforeFocusedCollapse = await page.evaluate(() => window.messages.length);
    await page.locator('.repo-changes-toggle').first().click();
    assert.equal(await page.evaluate(() => window.messages.length), messagesBeforeFocusedCollapse + 1, 'focused collapse publishes a blur action');
    assert.equal(await page.locator('#commitEmpty').textContent(), '暂未选中仓库', 'focused collapse clears history immediately, without waiting for a host message');
    await assertCount(page.locator('#commitList .commit-row'), 0);
    state.selectedRepositoryPaths = []; state.commits = []; state.selectedCommit = null;
    await publish();
    assert.equal(await page.locator('#commitEmpty').textContent(), '暂未选中仓库', 'host confirmation preserves no-repository state');
    const messagesBeforeReveal = await page.evaluate(() => window.messages.length);
    await page.evaluate(repositoryPath => window.dispatchEvent(new MessageEvent('message', { data: { type: 'revealRepositoryChanges', repositoryPath } })), repositories[0].repositoryPath);
    assert.equal(await page.locator('.repo-changes').first().locator('.repo-changes-body').isVisible(), true, 'Gitlink return expands a previously collapsed parent');
    assert.equal(await page.locator('.repo-changes').first().evaluate(node => node.classList.contains('focused')), true);
    assert.equal(await page.locator('.repo-changes').first().evaluate(node => node === document.activeElement), true, 'Back gives the parent repository actual DOM focus');
    assert.equal(await page.evaluate(() => window.messages.length), messagesBeforeReveal, 'programmatic reveal must not feed another repository selection back to host');
    state.selectedRepositoryPaths = [repositories[0].repositoryPath];
    state.selectedCommit = { hash: '12345678', repositoryPath: repositories[0].repositoryPath };
    state.commits = [{ hash: '12345678', shortHash: '12345678', key: repositories[0].repositoryPath + ':12345678', parents: [], refs: [], message: 'root history', author: 'tester', authorDateLabel: 'today', gitBranchOption: { repoOption: { path: repositories[0].repositoryPath, label: 'inkengine' }, name: 'refs/heads/main', label: 'main', kind: 'current', hash: '12345678' } }];
    await publish();
    assert.equal(await page.locator('#commitList .commit-row.selected').getAttribute('data-hash'), '12345678', 'parent commit is selected after repository reveal');
    // Navigation to a folded child must expand/select/focus it, without feeding a selection loop back.
    const childCard = page.locator('.repo-changes').nth(1);
    if (await childCard.locator('.repo-changes-body').isVisible()) await childCard.locator('.repo-changes-toggle').click();
    state.selectedRepositoryPaths = [repositories[1].repositoryPath];
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[1].repositoryPath };
    state.commits = [];
    await publish();
    const beforeChildReveal = await page.evaluate(() => window.messages.length);
    await page.evaluate(repositoryPath => window.dispatchEvent(new MessageEvent('message', { data: { type: 'revealRepositoryChanges', repositoryPath } })), repositories[1].repositoryPath);
    assert.equal(await childCard.locator('.repo-changes-body').isVisible(), true);
    assert.equal(await childCard.evaluate(node => node === document.activeElement && node.classList.contains('focused')), true);
    assert.equal(await page.evaluate(() => window.messages.length), beforeChildReveal, 'programmatic child reveal does not trigger redundant host focus');
    await publish();
    assert.equal(await childCard.locator('.repo-changes-body').isVisible(), true, 'following snapshot keeps child expanded');
    assert.equal(await childCard.evaluate(node => node.classList.contains('focused')), true, 'following snapshot retains selected child focus');
    await page.locator('.repo-changes-toggle').first().click();
    await page.locator('.repo-changes-toggle').first().click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].repositoryPath }, 'reopening requests history selection again');
    await page.locator('.repo-changes-toggle').nth(4).click();
    for (const width of [320, 400, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => {
        const top = document.getElementById('filesSection').getBoundingClientRect();
        const graph = document.getElementById('commitSection').getBoundingClientRect();
        return { topBottom: top.bottom, graphTop: graph.top, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      });
      assert.ok(layout.topBottom <= layout.graphTop, 'Changes must not overlap or relocate the commit graph');
      assert.equal(layout.overflow, false, 'narrow layouts must not overflow the page horizontally');
    }
    assert.deepEqual(errors, [], 'the complete generated Webview script must execute without exceptions');
    await page.setViewportSize({ width: 400, height: 1000 });
    // Reference view: main repository open; children collapsed until explicitly revealed.
    repositories.forEach(repository => { repository.staged = []; repository.unstaged = []; });
    repositories[0].message = '优化分支分组与提交面板';
    repositories[0].staged = [{ path: 'src/webview/selectorBarSubPanel.ts', status: 'M' }];
    repositories[0].unstaged = [{ path: 'src/webview/repositoryChangesSubPanel.ts', status: 'M' }, { path: 'scripts/test-repository-changes.cjs', status: 'A' }];
    repositories[1].unstaged = [{ path: 'src/main.cpp', status: 'M' }];
    state.selectedRepositoryPaths = [repositories[0].repositoryPath];
    state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath };
    state.commits = []; await publish();
    for (let index = 0; index < repositories.length; index++) {
      const card = page.locator('.repo-changes').nth(index);
      if (await card.locator('.repo-changes-body').isVisible() !== (index === 0)) await card.locator('.repo-changes-toggle').click();
    }
    await page.evaluate(() => document.getElementById('workspace').style.gridTemplateRows = 'minmax(0, 72fr) 5px minmax(0, 28fr)');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('16px codicon')), true, 'Codicon font must render the toolbar icons');
    if (process.env.GITK_SCREENSHOT) await page.screenshot({ path: process.env.GITK_SCREENSHOT });
    if (process.env.GITK_BRANCH_SCREENSHOT) {
      await page.evaluate(() => document.getElementById('workspace').style.gridTemplateRows = 'minmax(0, 48fr) 5px minmax(0, 52fr)');
      await page.locator('#branchDropdown .dropdown-current').click();
      await page.screenshot({ path: process.env.GITK_BRANCH_SCREENSHOT });
    }
    console.log('Repository Changes browser tests passed: main-only default expansion, multi-remote groups, search/draft rollback, focus-safe messages, Gitlink navigation and 320/400/800px layout.');
  } finally { await browser.close(); }
}
async function verifyBranchDropdown(page, state, publish) {
  const refs = [
    { name: 'refs/heads/main', label: 'main', kind: 'local' },
    { name: 'refs/heads/main', label: 'main', kind: 'current' },
    { name: 'refs/heads/feature/ui', label: 'feature/ui', kind: 'local' },
    { name: 'refs/remotes/origin/main', label: 'origin/main', kind: 'remote' },
    { name: 'refs/remotes/origin/team/topic', label: 'origin/team/topic', kind: 'remote' },
    { name: 'refs/remotes/origin/HEAD', label: 'origin/HEAD', kind: 'remote' },
    { name: 'refs/remotes/upstream/main', label: 'upstream/main', kind: 'remote' },
  ];
  const sendBranches = () => page.evaluate(branches => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'totalBranchesListChanged', branches } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedBranchDisplayChanged', display: { label: 'main', kind: 'current', title: 'main' } } }));
  }, refs);
  state.selectedBranches = ['refs/heads/main']; await publish(); await sendBranches();
  const dropdown = page.locator('#branchDropdown');
  const branchSelectorAlignment = await page.evaluate(() => {
    const icon = document.querySelector('#branchDropdown .branch-icon').getBoundingClientRect();
    const value = document.querySelector('#branchDropdown .dropdown-value').getBoundingClientRect();
    const label = document.querySelector('#branchDropdown .dropdown-label');
    return {
      iconCenter: icon.top + icon.height / 2,
      valueCenter: value.top + value.height / 2,
      gap: value.left - icon.right,
      iconTransform: getComputedStyle(document.querySelector('#branchDropdown .branch-icon')).transform,
      labelGap: getComputedStyle(label).gap,
    };
  });
  assert.equal(branchSelectorAlignment.iconCenter, branchSelectorAlignment.valueCenter, 'branch icon and label share a vertical centerline');
  assert.equal(branchSelectorAlignment.gap, 2, 'branch icon keeps a 2px gap before its label');
  assert.equal(branchSelectorAlignment.labelGap, '2px');
  assert.equal(branchSelectorAlignment.iconTransform, 'none');
  await dropdown.locator('.dropdown-current').click();
  // A branch-list message can arrive before the atomic selection/display snapshot while
  // switching repository cards. Merely opening the popup must not pin that stale selection.
  state.selectedBranches = ['refs/heads/feature/ui'];
  state.selectedBranchDisplay = { label: 'feature/ui', kind: 'local', title: 'refs/heads/feature/ui' };
  await publish();
  assert.equal(await dropdown.locator('input[value="refs/heads/feature/ui"]').isChecked(), true, 'a newer state snapshot updates an untouched open popup');
  assert.equal(await dropdown.locator('input[value="refs/heads/main"]').isChecked(), false, 'the stale checked ref is cleared');
  assert.match(await dropdown.locator('.dropdown-current').textContent(), /feature\/ui/, 'button label and checked branch use the same snapshot');
  state.selectedBranches = ['refs/heads/main'];
  state.selectedBranchDisplay = { label: 'main', kind: 'current', title: 'refs/heads/main' };
  await publish();
  const branchScrollbar = page.locator('#branchOptionsScrollbar');
  await assertCount(branchScrollbar, 1);
  const branchScrollbarFixture = await page.evaluate(() => {
    const viewport = document.querySelector('#branchDropdown .branch-options-viewport');
    const options = document.querySelector('#branchOptions');
    viewport.style.height = '84px';
    const viewportStyle = getComputedStyle(viewport);
    const menuStyle = getComputedStyle(document.querySelector('#branchDropdown .dropdown-menu'));
    return { nativeScrollbarWidth: getComputedStyle(options).scrollbarWidth, viewportClass: viewport.className, viewportOverflow: viewportStyle.overflow, menuOverflow: menuStyle.overflow };
  });
  assert.equal(branchScrollbarFixture.nativeScrollbarWidth, 'none', 'branch options hide the native scrollbar');
  assert.match(branchScrollbarFixture.viewportClass, /overlay-scrollbar/, 'branch options use the shared overlay scrollbar component');
  assert.equal(branchScrollbarFixture.viewportOverflow, 'hidden', 'branch options clip overflowing rows inside the popup');
  assert.equal(branchScrollbarFixture.menuOverflow, 'hidden', 'branch menu clips content to its rounded boundary');
  await page.waitForFunction(() => !document.getElementById('branchOptionsScrollbar').hidden);
  const branchScrollbarSync = await page.evaluate(() => {
    const options = document.querySelector('#branchOptions');
    const thumb = document.querySelector('#branchOptionsScrollbar .overlay-scroll-thumb');
    const before = getComputedStyle(thumb).transform;
    options.scrollTop = options.scrollHeight;
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ before, after: getComputedStyle(thumb).transform, scrollTop: options.scrollTop }))));
  });
  assert.ok(branchScrollbarSync.scrollTop > 0, 'branch options can scroll through their overlay viewport');
  assert.notEqual(branchScrollbarSync.after, branchScrollbarSync.before, 'branch overlay thumb follows the option scroll position');
  assert.equal(await branchScrollbar.evaluate(track => getComputedStyle(track).opacity), '1', 'branch overlay scrollbar remains visible while its options overflow');
  await page.evaluate(() => { const viewport = document.querySelector('#branchDropdown .branch-options-viewport'); viewport.style.height = ''; });
  const branchMenuLayout = await page.evaluate(() => {
    const button = document.querySelector('#branchDropdown .dropdown-current').getBoundingClientRect();
    const menu = document.querySelector('#branchDropdown .dropdown-menu').getBoundingClientRect();
    const search = document.getElementById('commitSearchRow').getBoundingClientRect();
    const card = getComputedStyle(document.querySelector('.repo-changes-label'));
    const styles = selector => Array.from(document.querySelectorAll(selector), element => {
      const computed = getComputedStyle(element);
      return { fontFamily: computed.fontFamily, fontSize: computed.fontSize, fontStyle: computed.fontStyle, fontWeight: computed.fontWeight, lineHeight: computed.lineHeight };
    });
    return {
      menuTop: menu.top,
      buttonBottom: button.bottom,
      menuZIndex: getComputedStyle(document.getElementById('commitSelectors')).zIndex,
      searchZIndex: getComputedStyle(document.getElementById('commitSearchRow')).zIndex,
      card: { fontFamily: card.fontFamily, fontSize: card.fontSize, fontStyle: card.fontStyle, fontWeight: card.fontWeight, lineHeight: card.lineHeight },
      filter: styles('#branchDropdown .dropdown-filter'),
      options: styles('#branchDropdown .dropdown-option'),
      groups: styles('#branchDropdown .dropdown-group'),
      actions: styles('#branchDropdown .dropdown-actions button'),
      branchNames: styles('#branchDropdown .branch-option-label'),
      actionTypography: styles('#branchDropdown .toggle-all, #branchDropdown .confirm-selection, #branchDropdown .cancel-selection'),
      menuShadow: getComputedStyle(document.querySelector('#branchDropdown .dropdown-menu')).boxShadow,
      menuWidth: menu.width,
      buttonWidth: button.width,
      viewportWidth: window.innerWidth,
      optionsHeight: document.querySelector('#branchDropdown .branch-options-viewport').getBoundingClientRect().height,
      optionsScrollHeight: document.querySelector('#branchOptions').scrollHeight,
      actionsHeight: document.querySelector('#branchDropdown .dropdown-actions').getBoundingClientRect().height,
      actionsPadding: (() => {
        const computed = getComputedStyle(document.querySelector('#branchDropdown .dropdown-actions'));
        return { top: computed.paddingTop, bottom: computed.paddingBottom };
      })(),
      menuContentLayout: (() => {
        const menuElement = document.querySelector('#branchDropdown .dropdown-menu');
        const filterElement = document.querySelector('#branchDropdown .dropdown-filter');
        const actionsElement = document.querySelector('#branchDropdown .dropdown-actions');
        const menuRect = menuElement.getBoundingClientRect();
        const filterRect = filterElement.getBoundingClientRect();
        const actionsRect = actionsElement.getBoundingClientRect();
        const menuStyle = getComputedStyle(menuElement);
        return {
          menuPadding: { top: menuStyle.paddingTop, right: menuStyle.paddingRight, bottom: menuStyle.paddingBottom, left: menuStyle.paddingLeft },
          filterTopGap: filterRect.top - menuRect.top,
          filterSideGap: filterRect.left - menuRect.left,
          actionBottomGap: menuRect.bottom - actionsRect.bottom,
        };
      })(),
      confirm: (() => {
        const button = document.querySelector('#branchDropdown .confirm-selection');
        const computed = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return { height: rect.height, minWidth: computed.minWidth, borderRadius: computed.borderRadius, fontWeight: computed.fontWeight, background: computed.backgroundColor };
      })(),
      cancel: (() => {
        const button = document.querySelector('#branchDropdown .cancel-selection');
        const computed = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return { height: rect.height, background: computed.backgroundColor };
      })(),
    };
  });
  assert.equal(branchMenuLayout.menuTop, branchMenuLayout.buttonBottom + 3, 'branch menu stays directly below its selector button');
  assert.ok(Number(branchMenuLayout.menuZIndex) > Number(branchMenuLayout.searchZIndex), 'branch menu stacks above the commit search row');
  [branchMenuLayout.filter, branchMenuLayout.options, branchMenuLayout.actions, branchMenuLayout.groups].flat().forEach(style => {
    assert.deepEqual(style, branchMenuLayout.card, 'branch menu text matches the repository card title typography');
  });
  assert.equal(await dropdown.locator('.branch-group-count').count(), 0, 'branch menu does not render count badges');
  branchMenuLayout.actionTypography.forEach(style => {
    assert.deepEqual(style, branchMenuLayout.branchNames[0], 'branch actions use the same typography as branch names');
  });
  assert.equal(branchMenuLayout.actionsHeight, 42, 'branch menu action bar has deliberate vertical space');
  assert.ok(branchMenuLayout.menuWidth >= branchMenuLayout.buttonWidth, 'branch menu never narrows below its selector button');
  assert.ok(branchMenuLayout.menuWidth <= branchMenuLayout.viewportWidth - 20, 'branch menu stays within the webview viewport');
  assert.ok(branchMenuLayout.optionsHeight <= branchMenuLayout.optionsScrollHeight, 'branch options receive an explicit bounded scroll viewport');
  assert.deepEqual(branchMenuLayout.actionsPadding, { top: '8px', bottom: '8px' }, 'branch menu action bar uses symmetric vertical padding');
  assert.deepEqual(branchMenuLayout.menuContentLayout.menuPadding, { top: '0px', right: '0px', bottom: '0px', left: '0px' }, 'branch menu has no extra outer padding');
  assert.equal(branchMenuLayout.menuContentLayout.filterTopGap, 6, 'filter owns the menu top inset');
  assert.equal(branchMenuLayout.menuContentLayout.filterSideGap, 6, 'filter owns the menu side inset');
  assert.equal(branchMenuLayout.menuContentLayout.actionBottomGap, 1, 'action bar reaches the menu bottom without an extra outer gap');
  assert.match(branchMenuLayout.menuShadow, /rgba\(0, 0, 0, 0\.24\).*rgba\(0, 0, 0, 0\.36\)/, 'branch menu uses a layered elevation shadow');
  assert.deepEqual(branchMenuLayout.confirm, { height: 24, minWidth: '46px', borderRadius: '3px', fontWeight: '400', background: 'rgb(23, 108, 139)' }, 'confirm is a compact primary action');
  assert.deepEqual(branchMenuLayout.cancel, { height: 24, background: 'rgba(0, 0, 0, 0)' }, 'cancel remains a lighter secondary action');
  const branchMenuIconAlignment = await page.evaluate(() => {
    const metrics = selector => Array.from(document.querySelectorAll(selector), element => {
      const rect = element.getBoundingClientRect();
      return { center: rect.top + rect.height / 2, transform: getComputedStyle(element).transform };
    });
    const rowCenters = Array.from(document.querySelectorAll('#branchDropdown .dropdown-option'), option => {
      const rect = option.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const groupCenters = Array.from(document.querySelectorAll('#branchDropdown .dropdown-group'), group => {
      const rect = group.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return {
      optionIcons: metrics('#branchDropdown .dropdown-option > .branch-icon'),
      groupIcons: metrics('#branchDropdown .dropdown-group > .codicon'),
      rowCenters,
      groupCenters,
    };
  });
  branchMenuIconAlignment.optionIcons.forEach((icon, index) => {
    assert.equal(icon.center, branchMenuIconAlignment.rowCenters[index], 'branch row icon is vertically centered');
    assert.equal(icon.transform, 'none');
  });
  branchMenuIconAlignment.groupIcons.forEach((icon, index) => {
    assert.equal(icon.center, branchMenuIconAlignment.groupCenters[index], 'branch group icon is vertically centered');
    assert.equal(icon.transform, 'none');
  });
  assert.deepEqual(await dropdown.locator('.branch-group-label').allTextContents(), ['本地分支', '远程分支 · origin', '远程分支 · upstream']);
  await assertCount(dropdown.locator('.dropdown-option'), 5);
  await assertCount(dropdown.locator('.branch-current-marker'), 1);
  const featureCheckbox = dropdown.locator('input[value="refs/heads/feature/ui"]');
  await featureCheckbox.focus(); await featureCheckbox.press('Space');
  assert.equal(await featureCheckbox.isChecked(), true, 'Space toggles the visible checkbox as well as the selection model');
  await featureCheckbox.press('Space');
  assert.equal(await featureCheckbox.isChecked(), false);
  await featureCheckbox.click(); assert.equal(await featureCheckbox.isChecked(), true, 'direct checkbox click stays in sync');
  await featureCheckbox.click(); assert.equal(await featureCheckbox.isChecked(), false);
  const filter = dropdown.locator('.dropdown-filter');
  await filter.fill('origin');
  await assertCount(dropdown.locator('.dropdown-option:visible'), 2);
  await assertCount(dropdown.locator('.dropdown-group:visible'), 1);
  await filter.fill('team/topic');
  await dropdown.locator('.dropdown-option:visible').click();
  await sendBranches();
  await assertCount(dropdown.locator('.dropdown-option:visible'), 1);
  assert.equal(await dropdown.locator('input[value="refs/remotes/origin/team/topic"]').isChecked(), true, 'snapshot keeps the unconfirmed selection and search');
  await filter.fill('no-such-branch');
  await assertCount(dropdown.locator('.dropdown-group:visible'), 0);
  await assertCount(dropdown.locator('.dropdown-empty:visible'), 1);
  await dropdown.locator('.cancel-selection').click();
  await dropdown.locator('.dropdown-current').click();
  assert.equal(await dropdown.locator('input[value="refs/remotes/origin/team/topic"]').isChecked(), false, 'cancel restores confirmed refs');
  await assertCount(dropdown.locator('.dropdown-group:visible'), 3);
  await dropdown.locator('.toggle-all').click();
  await dropdown.locator('.confirm-selection').click();
  assert.deepEqual((await lastMessage(page)).names.sort(), ['refs/heads/main', 'refs/heads/feature/ui', 'refs/remotes/origin/main', 'refs/remotes/origin/team/topic', 'refs/remotes/upstream/main'].sort(), 'confirm emits full unique refs, not display labels');
  state.selectedBranches = (await lastMessage(page)).names; await publish();
  refs[1].kind = 'local'; refs[2].kind = 'current'; await sendBranches();
  assert.equal(await dropdown.locator('.dropdown-option').filter({ has: page.locator('.branch-current-marker') }).locator('input').getAttribute('value'), 'refs/heads/feature/ui', 'metadata refresh updates current marker');
  await dropdown.locator('.dropdown-current').click();
  for (const width of [320, 400, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'branch groups fit narrow panels');
  }
  await dropdown.locator('.cancel-selection').click();
  await page.setViewportSize({ width: 400, height: 1000 });
  state.selectedBranches = []; await publish();
}
async function assertCount(locator, expected) { assert.equal(await locator.count(), expected); }
async function verifyRepositoryDisplayModes(browser, html) {
  const page = await browser.newPage({ viewport: { width: 400, height: 1000 } });
  try {
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);
    const repositories = ['one', 'two'].map((name, index) => ({ repositoryPath: 'file:///mode/' + name,
      repositoryLabel: name, isMainRepository: index === 0, staged: [{ path: 'src/a.cpp', status: 'M' }],
      unstaged: [{ path: 'src/a.cpp', status: 'M' }, { path: 'src/deep/b.cpp', status: 'M' }, { path: 'root.cpp', status: 'M' }] }));
    const state = { repositoryChanges: repositories, filesMode: 'flat', files: [], commits: [], selectedRepositoryPaths: [],
      selectedCommit: { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath }, filesLoading: false };
    const publish = () => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state);
    await publish();
    assert.match(await page.locator('#filesModeBtn').getAttribute('title'), /平铺/);
    const flatIcon = await page.locator('#filesModeIcon').getAttribute('d');
    await page.locator('#filesModeBtn').click();
    assert.deepEqual(await lastMessage(page), { type: 'toggleFilesMode' }, 'button posts its mode intent');
    state.filesMode = 'tree'; await publish();
    assert.match(await page.locator('#filesModeBtn').getAttribute('title'), /树状/);
    assert.notEqual(await page.locator('#filesModeIcon').getAttribute('d'), flatIcon);
    const card = page.locator('.repo-changes').first();
    const group = card.locator('.repo-group[data-section="unstaged"]');
    assert.deepEqual(await group.locator('.repo-folder-name').allTextContents(), ['src', 'src/deep']);
    const folder = group.locator('.repo-folder').first();
    await folder.locator('.repo-folder-toggle').click();
    assert.equal(await folder.locator('.repo-folder-files').isVisible(), false);
    assert.equal(await card.locator('.repo-group[data-section="staged"] .repo-folder-files').isVisible(), true, 'folder folds are scoped to section');
    await publish();
    assert.equal(await folder.locator('.repo-folder-files').isVisible(), false, 'unrelated snapshots preserve folds');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'unstaged:src/a.cpp' } })));
    assert.equal(await folder.locator('.repo-folder-files').isVisible(), true, 'MultiDiff reveals a folded folder');
    await group.locator('.repo-file').first().click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesFile', repositoryPath: repositories[0].repositoryPath, section: 'unstaged', path: 'src/a.cpp' });
    await page.locator('#filesModeBtn').click();
    state.filesMode = 'flat'; await publish();
    await assertCount(page.locator('.repo-folder'), 0);
    assert.equal(await page.locator('#filesModeIcon').getAttribute('d'), flatIcon);
    state.selectedCommit = { hash: 'mode-history', repositoryPath: repositories[0].repositoryPath, message: 'history' };
    state.files = [{ path: 'history/file.cpp', status: 'M' }]; state.filesMode = 'tree'; await publish();
    assert.equal(await card.locator('.repo-group[data-section="commit"] .repo-folder-name').textContent(), 'history');
    for (const width of [320, 400, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await card.evaluate(node => node.scrollWidth > node.clientWidth), false, 'tree rows remain within card at ' + width);
    }
  } finally { await page.close(); }
}
async function verifyPinnedHeaderPixels(browser, html) {
  const { PNG } = require('pngjs');
  const page = await browser.newPage({ viewport: { width: 400, height: 1000 } });
  try {
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
    });
    await page.setContent(html);
    await page.evaluate(() => {
      document.getElementById('workspace').style.gridTemplateRows = '500px 5px minmax(0, 1fr)';
      document.documentElement.style.setProperty('--vscode-list-hoverBackground', 'rgba(255, 255, 255, .12)');
      document.documentElement.style.setProperty('--vscode-editorWidget-background', 'rgba(0, 127, 212, .2)');
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#242424');
      const repositoryPath = 'file:///pinned-fixture';
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: {
        repositoryChanges: [{ repositoryPath, repositoryLabel: 'fixture', isMainRepository: true, headLabel: 'main', staged: [],
          unstaged: Array.from({ length: 50 }, (_, i) => ({ path: 'file-' + i + '.cpp', status: 'M' })) }],
        selectedRepositoryPaths: [repositoryPath], selectedCommit: { hash: 'uncommitted', repositoryPath },
        commits: [], branches: [], selectedBranches: [], files: [], filesLoading: false,
      } } }));
      const list = document.getElementById('repositoryChangesList');
      const row = list.querySelector('.repo-file-row');
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 2;
    });
    await page.mouse.move(10, 900);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const header = page.locator('.repo-changes-header');
    const geometry = await header.evaluate(node => {
      const header = node.getBoundingClientRect(), list = document.getElementById('repositoryChangesList').getBoundingClientRect();
      return { top: header.top, left: header.left, right: header.right, listTop: list.top, lineTop: getComputedStyle(node, '::after').top };
    });
    assert.ok(Math.abs(geometry.top - geometry.listTop) < .5, 'real pinned header has no gap above it');
    assert.equal(geometry.lineTop, '0px', 'focus line is inside the viewport rather than clipped at -1px');
    const pixel = (png, x, y) => Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3));
    async function screenshotWithUnderlay(color) {
      await page.locator('.repo-file-row').evaluateAll((rows, color) => rows.forEach(row => { row.style.backgroundColor = color; }), color);
      return PNG.sync.read(await page.screenshot());
    }
    async function assertSingleFocusLine(label) {
      await page.locator('.repo-changes').evaluate(card => card.classList.add('focused'));
      await page.mouse.move(10, 900);
      const cardRect = await page.locator('.repo-changes').boundingBox();
      const rect = await header.boundingBox();
      assert.ok(rect.x >= cardRect.x && rect.x + rect.width <= cardRect.x + cardRect.width, label + ' stays within the card edges');
      assert.equal(await header.evaluate(node => getComputedStyle(node).boxShadow), 'none', label + ' has no shadow extending outside the card');
      const png = PNG.sync.read(await page.screenshot());
      const x = Math.round(rect.x + 100);
      const top = Math.round(Math.max(cardRect.y, geometry.listTop));
      const blueRows = [];
      for (let y = top; y < top + 4; y++) {
        if (pixel(png, x, y).join(',') === '0,127,212') blueRows.push(y);
      }
      assert.deepEqual(blueRows, [top], label + ' paints exactly one focus line at the visible top');
      assert.deepEqual(pixel(png, x, Math.round(rect.y + 15)), [36, 36, 36], label + ' uses the card background');
    }
    await page.locator('#repositoryChangesList').evaluate(list => { list.scrollTop = 0; });
    await assertSingleFocusLine('unpinned header');
    await page.locator('.repo-changes-toggle').click();
    await assertSingleFocusLine('collapsed header');
    await page.locator('.repo-changes-toggle').click();
    await page.locator('#repositoryChangesList').evaluate(list => {
      const row = list.querySelector('.repo-file-row');
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 2;
    });
    await assertSingleFocusLine('pinned header');
    for (const mode of ['focused', 'unfocused', 'hover']) {
      await page.locator('.repo-changes').evaluate((card, mode) => card.classList.toggle('focused', mode === 'focused'), mode);
      if (mode === 'hover') await page.mouse.move(geometry.left + 150, geometry.top + 15);
      else await page.mouse.move(10, 900);
      const style = await header.evaluate(node => ({ header: getComputedStyle(node).backgroundColor,
        card: getComputedStyle(node.parentElement).backgroundColor, image: getComputedStyle(node).backgroundImage,
        left: getComputedStyle(node, '::after').left, right: getComputedStyle(node, '::after').right,
        before: getComputedStyle(node, '::before').content, overflow: getComputedStyle(node).overflow }));
      assert.equal(style.header, style.card, mode + ' header matches the card color');
      assert.equal(style.image, 'none', mode + ' does not tint the entire header');
      assert.equal(style.left, '0px'); assert.equal(style.right, '0px');
      assert.equal(style.before, 'none', 'no background extends across the card borders');
      assert.equal(style.overflow, 'hidden', 'header painting is clipped to its rounded bounds');
      const magenta = await screenshotWithUnderlay('#ff00ff');
      const green = await screenshotWithUnderlay('#00ff00');
      const x = Math.round(geometry.left + 100), y = Math.round(geometry.top);
      assert.deepEqual(pixel(green, x, y), mode === 'focused' ? [0, 127, 212] : [52, 52, 52], mode + ' top line is actually painted');
      assert.deepEqual(pixel(green, x, y + 15), [36, 36, 36], mode + ' paints the card background even when pinned');
      for (const [px, py] of [[x, y + 2], [Math.floor(geometry.left), y + 2], [Math.ceil(geometry.right) - 1, y + 2]]) {
        assert.deepEqual(pixel(magenta, px, py), pixel(green, px, py), mode + ' header and corner pixels never reveal underlying files');
      }
    }
    if (process.env.GITK_PINNED_SCREENSHOT) await page.screenshot({ path: process.env.GITK_PINNED_SCREENSHOT });
  } finally { await page.close(); }
}
async function verifyRepositoryHeaderBorderTransitions(browser, html) {
  const { PNG } = require('pngjs');
  for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
    const page = await browser.newPage({ viewport: { width: 400, height: 1000 }, deviceScaleFactor });
    try {
      await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
      await page.setContent(html);
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--vscode-sideBar-background', '#242424');
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: {
          repositoryChanges: [{ repositoryPath: 'file:///border', repositoryLabel: 'border', isMainRepository: true,
            staged: [], unstaged: Array.from({ length: 50 }, (_, i) => ({ path: 'file-' + i, status: 'M' })) }],
          selectedRepositoryPaths: ['file:///border'], commits: [], files: [], filesLoading: false,
        } } }));
      });
      for (const rowHeight of [500, 500.5]) {
        await page.locator('#workspace').evaluate((node, height) => { node.style.gridTemplateRows = height + 'px 5px minmax(0, 1fr)'; }, rowHeight);
        for (const scrollTop of [0, .5, 1, 1.5, 2, 10]) {
          await page.locator('#repositoryChangesList').evaluate((node, top) => { node.scrollTop = top; }, scrollTop);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const geometry = await page.locator('.repo-changes-header').evaluate(header => {
            const card = header.parentElement.getBoundingClientRect(), rect = header.getBoundingClientRect();
            const list = document.getElementById('repositoryChangesList').getBoundingClientRect();
            return { cardTop: card.top, headerTop: rect.top, listTop: list.top, x: rect.left + 100,
              pinned: header.classList.contains('pinned'), content: getComputedStyle(header, '::after').content };
          });
          const label = JSON.stringify({ deviceScaleFactor, rowHeight, scrollTop, geometry });
          assert.equal(geometry.pinned, geometry.cardTop + 1 <= geometry.listTop, 'pin only after the outer top border leaves the viewport: ' + label);
          if (!geometry.pinned) {
            assert.equal(geometry.content, 'none', 'unpinned header has no duplicate top line: ' + label);
            assert.ok(geometry.headerTop >= geometry.cardTop + 1 - .01, 'header never covers the outer corner arcs: ' + label);
          }
          const png = PNG.sync.read(await page.screenshot());
          const x = Math.round(geometry.x * deviceScaleFactor);
          const top = Math.floor(Math.max(geometry.cardTop, geometry.listTop) * deviceScaleFactor);
          let coverage = 0;
          for (let y = top; y < top + Math.ceil(5 * deviceScaleFactor); y++) {
            const offset = (y * png.width + x) * 4;
            coverage += Math.max(0, (png.data[offset + 2] - 36) / (212 - 36));
          }
          assert.ok(coverage / deviceScaleFactor <= 1.1, 'top highlight never exceeds one CSS pixel: ' + label + ' coverage=' + coverage);
        }
      }
    } finally { await page.close(); }
  }
}
async function verifyHistoricalMessage(page, state, publish, repositories) {
  // Worktree drafts are independent of each repository's historical display snapshot.
  const root = page.locator('.repo-changes').first();
  const details = root.locator('.repo-commit-details');
  const raw = ['  原始标题 <script>  ', '', ...Array.from({ length: 12 }, (_, i) => '描述 ' + i + ' ' + 'long-description '.repeat(8)), '  ', ''].join(String.fromCharCode(10));
  state.selectedCommit = { hash: '12345678', repositoryPath: repositories[0].repositoryPath, message: '不能覆盖原始标题', body: '不能覆盖原始描述', rawMessage: raw };
  state.commits = []; await publish();
  assert.equal(await root.locator('.repo-message-box').isVisible(), false);
  assert.equal(await root.locator('.repo-commit-actions').isVisible(), false);
  assert.equal(await details.isVisible(), true);
  assert.equal(await root.evaluate(card => card.querySelector('.repo-file-groups').getBoundingClientRect().top - card.querySelector('.repo-commit-details').getBoundingClientRect().bottom), 4, 'Historical editor uses the same files gap as Commit actions');
  assert.equal(await details.inputValue(), raw.slice(0, -1), 'read-only display removes trailing newline but preserves internal blank lines and spaces');
  assert.equal(await details.evaluate(node => node.tagName), 'TEXTAREA');
  assert.equal(await details.getAttribute('readonly'), '');
  await details.focus(); await details.press('Home'); await details.press('X');
  assert.equal(await details.inputValue(), raw.slice(0, -1), 'typing cannot modify a historical commit');
  await assertCount(root.locator('.repo-group[data-section="staged"], .repo-group[data-section="unstaged"], .repo-group[data-section="conflict"]'), 0, 'historical card never mixes in uncommitted sections');
  await assertCount(root.locator('.repo-group[data-section="commit"] .repo-file'), 1);
  await assertCount(details.locator('script'), 0);
  for (const width of [320, 400, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await details.evaluate(node => {
      const css = getComputedStyle(node);
      return { height: node.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), line: parseFloat(css.lineHeight), scroll: node.scrollHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), overflow: css.overflowY, xOverflow: node.scrollWidth > node.clientWidth };
    });
    assert.ok(layout.height <= layout.line * 5 + 1, 'title and description share a five-line maximum');
    assert.ok(layout.scroll > layout.height, 'all additional message lines remain scrollable');
    assert.equal(layout.overflow, 'auto'); assert.equal(layout.xOverflow, false);
  }
  await page.setViewportSize({ width: 400, height: 1000 });
  await details.click();
  assert.equal(await root.locator('.repo-changes-body').isVisible(), true, 'selecting description text must not fold the card');
  await details.focus(); await details.press('Control+End');
  await page.waitForFunction(() => document.querySelector('.repo-changes .repo-commit-details').scrollTop > 0);
  assert.ok(await details.evaluate(node => node.scrollTop) > 0, 'keyboard can scroll to remaining description');
  if (process.env.GITK_HISTORY_SCREENSHOT) {
    await details.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: process.env.GITK_HISTORY_SCREENSHOT });
  }
  const before = await page.evaluate(() => window.messages.filter(message => message.type === 'workingTreeCommit').length);
  await root.locator('.repo-message').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' })));
  assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'workingTreeCommit').length), before, 'hidden editor cannot submit in history mode');
  state.selectedCommit = { hash: '12345678', repositoryPath: repositories[0].repositoryPath, message: '短标题', body: '短说明' }; await publish();
  assert.equal(await details.inputValue(), ['短标题', '', '短说明'].join(String.fromCharCode(10)));
  assert.ok(await details.evaluate(node => node.clientHeight) < 5 * 19.5, 'short messages do not reserve five empty lines');
  state.selectedCommit = { hash: 'trailing-lines', repositoryPath: repositories[0].repositoryPath, rawMessage: '标题' + String.fromCharCode(10, 10) + '正文  ' + String.fromCharCode(13, 10, 13, 10) }; await publish();
  assert.equal(await details.inputValue(), '标题' + String.fromCharCode(10, 10) + '正文  ', 'terminal CRLF lines are removed without trimming content spaces');
  assert.ok(state.selectedCommit.rawMessage.endsWith(String.fromCharCode(13, 10)), 'display cleanup does not mutate source metadata');
  state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath }; await publish();
  const editor = root.locator('.repo-message');
  await editor.fill('  keep draft intact  ');
  state.selectedCommit = { hash: 'abcdef12', repositoryPath: repositories[0].repositoryPath, rawMessage: '第二个提交' }; await publish();
  assert.equal(await details.inputValue(), '第二个提交');
  await page.locator('.repo-changes-toggle').nth(1).click();
  assert.equal(await page.locator('.repo-message').nth(1).isVisible(), true, 'historical selection does not hide another repository editor');
  await page.locator('.repo-changes-toggle').nth(1).click();
  state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath }; await publish();
  assert.equal(await editor.isVisible(), true);
  assert.equal(await editor.inputValue(), '  keep draft intact  ');
  assert.equal(await details.isVisible(), false);
  await assertCount(root.locator('.repo-group[data-section="staged"]'), 1);
  await assertCount(root.locator('.repo-group[data-section="unstaged"]'), 1);
  await assertCount(root.locator('.repo-group[data-section="commit"]'), 0, 'switching back restores only worktree sections');
}
async function verifyRepositorySnapshotTransitions(browser, html) {
  const page = await browser.newPage({ viewport: { width: 400, height: 1000 } });
  try {
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
    await page.setContent(html);
    const aPath = 'file:///fixture/a', bPath = 'file:///fixture/b';
    const aCommit = { hash: 'older-a', repositoryPath: aPath, message: 'A historical commit' };
    const bCommit = { hash: 'older-b', repositoryPath: bPath, message: 'B historical commit' };
    const aFiles = [{ path: 'a.cpp', status: 'M' }], bFiles = [{ path: 'b.cpp', status: 'M' }];
    const state = { repositoryChanges: [
      { repositoryPath: aPath, repositoryLabel: 'a', isMainRepository: true, staged: [], unstaged: [{ path: 'a-worktree.cpp', status: 'M' }] },
      { repositoryPath: bPath, repositoryLabel: 'b', staged: [], unstaged: [] },
    ], commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [aPath], selectedCommit: aCommit,
      files: aFiles, filesLoading: false, filesIdentity: { hash: aCommit.hash, repositoryPath: aPath } };
    const publish = async patch => { Object.assign(state, patch); await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state); };
    await publish({});
    const a = page.locator('.repo-changes').nth(0), b = page.locator('.repo-changes').nth(1);
    await b.locator('.repo-changes-label').click();
    const assertA = async label => {
      assert.equal(await a.locator('.repo-changes-body').isVisible(), true, label + ': A stays expanded');
      assert.equal(await a.locator('.repo-commit-details').inputValue(), 'A historical commit', label + ': original A commit retained');
      assert.equal(await a.locator('.repo-commit-actions').isVisible(), false, label + ': no worktree submit controls');
      assert.deepEqual(await a.locator('.repo-group[data-section="commit"] .repo-file-name').allTextContents(), ['a.cpp'], label + ': A files retained');
    };
    await publish({ selectedRepositoryPaths: [bPath], selectedCommit: aCommit, files: [], filesLoading: true });
    await assertA('outgoing A loading transition');
    await publish({ selectedCommit: null, files: [], filesLoading: false });
    await assertA('no selected commit transition');
    await publish({ selectedCommit: bCommit, files: [], filesLoading: true, filesIdentity: { hash: bCommit.hash, repositoryPath: bPath } });
    await assertA('incoming B loading');
    await publish({ files: bFiles, filesLoading: false });
    await assertA('B ready and focused');
    assert.equal(await a.evaluate(card => card.classList.contains('focused')), false, 'A really has lost repository focus');
    assert.equal(await b.evaluate(card => card.classList.contains('focused')), true, 'B owns repository focus');
    assert.deepEqual(await b.locator('.repo-group[data-section="commit"] .repo-file-name').allTextContents(), ['b.cpp']);
    await a.locator('.repo-changes-label').click();
    await publish({ selectedRepositoryPaths: [aPath], selectedCommit: aCommit, files: bFiles, filesIdentity: { hash: bCommit.hash, repositoryPath: bPath } });
    await assertA('restored A with stale B files');
    assert.deepEqual(await b.locator('.repo-group[data-section="commit"] .repo-file-name').allTextContents(), ['b.cpp']);
    await publish({ files: [], filesLoading: true, filesIdentity: { hash: aCommit.hash, repositoryPath: aPath } });
    await assertA('restored A loading');
    await publish({ files: aFiles, filesLoading: false });
    await assertA('restored A ready');
    await publish({ files: [], filesLoading: false, diffError: 'failed file read' });
    await assertA('failed file read retains last complete A snapshot');
    await publish({ files: aFiles, diffError: undefined });
    await publish({ selectedCommit: { hash: 'empty-a', repositoryPath: aPath, message: 'empty commit' }, files: [], filesIdentity: { hash: 'empty-a', repositoryPath: aPath } });
    await assertCount(a.locator('.repo-file'), 0);
    assert.equal(await a.locator('.repo-commit-details').inputValue(), 'empty commit');
    await publish({ selectedCommit: { hash: 'uncommitted', repositoryPath: aPath }, filesIdentity: { hash: 'uncommitted', repositoryPath: aPath } });
    assert.equal(await a.locator('.repo-message-box').isVisible(), true);
    assert.deepEqual(await a.locator('.repo-file-name').allTextContents(), ['a-worktree.cpp']);
  } finally { await page.close(); }
}
async function verifyBottomRepositoryExpansion(browser, html, width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  try {
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} }); });
    await page.setContent(html);
    const repositories = Array.from({ length: 24 }, (_, i) => ({ repositoryPath: 'file:///bottom-' + i, repositoryLabel: 'repo-' + i,
      isMainRepository: i === 0, staged: [], unstaged: [{ path: 'file.cpp', status: 'M' }], message: 'body '.repeat(200) }));
    const state = { repositoryChanges: repositories, commits: [], selectedRepositoryPaths: [], selectedCommit: null, files: [], filesLoading: false };
    const publish = () => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state);
    await publish();
    const list = page.locator('#repositoryChangesList'), card = page.locator('.repo-changes').last();
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const before = await card.evaluate(card => ({ y: card.getBoundingClientRect().top, scroll: document.getElementById('repositoryChangesList').scrollTop }));
    await card.locator('.repo-changes-label').click();
    const opened = await card.evaluate(card => ({ y: card.getBoundingClientRect().top, scroll: document.getElementById('repositoryChangesList').scrollTop }));
    assert.ok(Math.abs(opened.y - before.y) < 1, 'opening bottom repository keeps its header in place: ' + JSON.stringify({ before, opened }));
    // A host focus confirmation and repeated input measurements must not move the visible card.
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    state.selectedRepositoryPaths = [repositories.at(-1).repositoryPath];
    const bottom = await list.evaluate(node => node.scrollTop);
    await page.evaluate(value => { window.bottomScrollBaseline = value; }, bottom);
    await page.evaluate(() => {
      window.messageMeasurements = [];
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      window.originalHeightDescriptor = descriptor;
      Object.defineProperty(Element.prototype, 'scrollHeight', { ...descriptor, get() {
        const list = document.getElementById('repositoryChangesList');
        const value = descriptor.get.call(this);
        if (this.matches('.repo-message, .repo-commit-details')) window.messageMeasurements.push({ value, before: window.bottomScrollBaseline, after: list.scrollTop });
        return value;
      } });
    });
    await publish(); await publish();
    const after = await list.evaluate(node => node.scrollTop);
    assert.ok(Math.abs(after - bottom) < 1, 'focus snapshots preserve bottom scroll position: ' + JSON.stringify({ bottom, after }));
    const measurements = await page.evaluate(() => window.messageMeasurements);
    assert.equal(measurements.filter(item => Math.abs(item.before - item.after) >= 1).length, 0, 'editor resize must not transiently clamp bottom scroll: ' + JSON.stringify(measurements.filter(item => Math.abs(item.before - item.after) >= 1)));
    const message = card.locator('.repo-message');
    const tallMessage = await message.evaluate(node => node.offsetHeight);
    await message.fill('short draft');
    assert.ok(await message.evaluate(node => node.offsetHeight) < tallMessage, 'draft editor still shrinks when content is removed');
    assert.equal(await message.evaluate(node => node.parentElement.style.minHeight), '', 'measurement height is released');
    state.selectedCommit = { hash: 'bottom-history', repositoryPath: repositories.at(-1).repositoryPath,
      message: 'history', rawMessage: Array.from({ length: 40 }, (_, i) => 'history line ' + i).join('\n') };
    state.files = [{ path: 'history.cpp', status: 'M' }];
    await publish();
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.evaluate(() => {
      window.bottomScrollBaseline = document.getElementById('repositoryChangesList').scrollTop;
      window.messageMeasurements = [];
    });
    await publish(); await publish();
    const historyMeasurements = await page.evaluate(() => window.messageMeasurements);
    assert.ok(historyMeasurements.length > 0, 'historical editor measurements were observed');
    assert.equal(historyMeasurements.filter(item => Math.abs(item.before - item.after) >= 1).length, 0, 'historical editor resize preserves bottom scroll throughout measurement');
    await page.evaluate(() => Object.defineProperty(Element.prototype, 'scrollHeight', window.originalHeightDescriptor));
    const details = card.locator('.repo-commit-details');
    const tallDetails = await details.evaluate(node => node.offsetHeight);
    state.selectedCommit = { ...state.selectedCommit, rawMessage: 'short history' };
    await publish();
    assert.ok(await details.evaluate(node => node.offsetHeight) < tallDetails, 'historical editor still shrinks when content is removed');
    assert.equal(await details.evaluate(node => node.parentElement.style.minHeight), '', 'historical measurement height is released');
    await card.locator('.repo-changes-toggle').click();
    await card.locator('.repo-changes-toggle').click();
    assert.equal(await card.locator('.repo-changes-body').isVisible(), true);
  } finally { await page.close(); }
}
async function verifyMultiDiffLinkage(page, state, publish, repositories) {
  const saved = { files: state.files, selectedCommit: state.selectedCommit, selectedPath: state.selectedPath, selectedRepositoryPaths: state.selectedRepositoryPaths };
  const oldRoot = repositories[0].unstaged, oldChild = repositories[1].unstaged, oldStaged = repositories[0].staged;
  repositories[0].unstaged = Array.from({ length: 36 }, (_, i) => ({ path: 'folder/file-' + i + '.cpp', status: 'M' }));
  repositories[1].unstaged = [{ path: 'folder/file-35.cpp', status: 'M' }];
  state.files = []; state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath };
  state.selectedRepositoryPaths = [repositories[0].repositoryPath]; state.selectedPath = '';
  await publish();
  const root = page.locator('.repo-changes').first();
  const rootRows = root.locator('.repo-group[data-section="unstaged"] .repo-file-row');
  await root.locator('.repo-message').fill('selection must preserve input focus');
  const beforeFeedback = await page.evaluate(() => window.messages.length);
  await page.evaluate(() => {
    const list = document.getElementById('repositoryChangesList'); list.scrollTop = 0;
    window.linkedRow = list.querySelector('.repo-group[data-section="unstaged"] .repo-file-row');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'unstaged:folder/file-35.cpp' } }));
  });
  assert.equal(await rootRows.last().evaluate(row => row.classList.contains('selected')), true);
  await assertCount(page.locator('.repo-file-row.selected'), 1);
  assert.equal(await root.locator('.repo-message').evaluate(node => node === document.activeElement), true, 'MultiDiff scroll does not steal editor focus');
  assert.equal(await page.evaluate(() => window.messages.length), beforeFeedback, 'scroll feedback does not send a selection loop');
  assert.equal(await page.evaluate(() => window.linkedRow === document.querySelector('.repo-group[data-section="unstaged"] .repo-file-row')), true, 'lightweight selection does not rebuild rows');
  assert.equal(await rootRows.last().evaluate(row => { const target = row.getBoundingClientRect(); const list = document.getElementById('repositoryChangesList'); const bounds = list.getBoundingClientRect(); return target.top >= bounds.top && target.bottom <= bounds.top + list.clientHeight + 1; }), true, 'offscreen MultiDiff file is revealed in repository list');
  await root.locator('.repo-group[data-section="unstaged"] .repo-group-toggle').click();
  await root.locator('.repo-changes-toggle').click();
  // Re-establish host-owned diff context while leaving the locally folded card unchanged.
  await publish();
  const beforeCollapsedFeedback = await page.evaluate(() => window.messages.length);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'unstaged:folder/file-34.cpp' } })));
  assert.equal(await root.locator('.repo-changes-body').isVisible(), true);
  assert.equal(await root.locator('.repo-group[data-section="unstaged"] .repo-group-files').isVisible(), true, 'MultiDiff target reveals folded repository and file group');
  assert.equal(await page.evaluate(() => window.messages.length), beforeCollapsedFeedback);
  await rootRows.nth(33).locator('.repo-file').click();
  assert.equal(await rootRows.nth(33).evaluate(row => row.classList.contains('selected')), true, 'click highlights immediately, before host confirmation');
  const scrollBeforeEcho = await page.locator('#repositoryChangesList').evaluate(node => node.scrollTop);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'unstaged:folder/file-33.cpp' } })));
  assert.equal(await page.locator('#repositoryChangesList').evaluate(node => node.scrollTop), scrollBeforeEcho, 'click echo leaves list scroll unchanged');
  await page.mouse.move(390, 990);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'unstaged:folder/file-34.cpp' } })));
  const oldRow = rootRows.nth(33);
  assert.equal(await oldRow.locator('.repo-file').evaluate(node => node === document.activeElement), true, 'scroll feedback must not forcibly blur the clicked control');
  assert.equal(await oldRow.evaluate(row => row.classList.contains('selected')), false);
  assert.equal(await oldRow.evaluate(row => getComputedStyle(row).backgroundColor), 'rgba(0, 0, 0, 0)', 'pointer focus must not leave a faint selection background on the old file');
  assert.equal(await oldRow.locator('.repo-file-actions').evaluate(node => getComputedStyle(node).visibility), 'visible', 'file action affordances remain visible after pointer focus moves');
  await assertCount(root.locator('.repo-file-row.selected'), 1);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'unstaged:folder/file-33.cpp' } })));
  state.selectedPath = 'unstaged:folder/file-33.cpp';
  await publish();
  assert.equal(await page.locator('#repositoryChangesList').evaluate(node => node.scrollTop), scrollBeforeEcho, 'full state click confirmation also leaves scroll unchanged');
  repositories[0].staged = [{ path: 'folder/file-33.cpp', status: 'M' }];
  repositories[0].unstaged.push({ path: 'conflict.cpp', status: 'U', isConflict: true });
  await publish();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'staged:folder/file-33.cpp' } })));
  await assertCount(root.locator('.repo-group[data-section="staged"] .repo-file-row.selected'), 1);
  await assertCount(root.locator('.repo-group[data-section="unstaged"] .repo-file-row.selected'), 0, 'staged and unstaged copies of a path are distinct');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedPathChanged', selectedPath: 'conflict:conflict.cpp' } })));
  await assertCount(root.locator('.repo-group[data-section="conflict"] .repo-file-row.selected'), 1);
  state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[1].repositoryPath };
  state.selectedPath = 'unstaged:folder/file-35.cpp'; state.selectedRepositoryPaths = [repositories[1].repositoryPath]; await publish();
  await assertCount(root.locator('.repo-file-row.selected'), 0);
  await assertCount(page.locator('.repo-changes').nth(1).locator('.repo-file-row.selected'), 1, 'same filename in child highlights only its owner');
  state.selectedCommit = { hash: 'uncommitted', repositoryPath: repositories[0].repositoryPath };
  await publish();
  await assertCount(root.locator('.repo-group[data-section="unstaged"] .repo-file-row.selected'), 1, 'same selectedPath with a different repository updates highlight');
  await assertCount(page.locator('.repo-changes').nth(1).locator('.repo-file-row.selected'), 0);
  state.selectedCommit = { hash: 'abcdef12', repositoryPath: repositories[0].repositoryPath, message: 'history' };
  state.files = [{ path: 'historic.cpp', diffKey: 'exact-history-key', status: 'M' }];
  state.selectedPath = 'exact-history-key'; await publish();
  const historic = root.locator('.repo-group[data-section="commit"] .repo-file-row');
  assert.equal(await historic.evaluate(row => row.classList.contains('selected')), true);
  await historic.locator('.repo-file').click();
  assert.deepEqual(await lastMessage(page), { type: 'selectFile', path: 'exact-history-key' }, 'history preserves the diff key rather than falling back to display path');
  repositories[0].unstaged = oldRoot; repositories[1].unstaged = oldChild; repositories[0].staged = oldStaged;
  Object.assign(state, saved); await publish();
  await root.locator('.repo-message').fill('');
}
async function lastMessage(page) { return page.evaluate(() => window.messages.at(-1)); }
// 旧版原生模块的 pushBranches 不返回 isUpstream/tipTimestamp; 缺失时排序会整体失效,
// 因此 getPushPlan 必须在 TS 侧补齐这两个字段, 并把推送源与远程目标分成两组数据。
async function verifyPushPlanEnrichment() {
  const load = Module._load;
  const rootUri = { fsPath: 'C:/fixture', toString: () => 'file:///fixture' };
  const nativeCalls = [];
  const rangeRequests = [];
  let getPushPlan;
  try {
    const bindingPath = require.resolve('../out/git/nativeGitBinding');
    delete require.cache[require.resolve('../out/git/gitLogProvider')];
    delete require.cache[bindingPath];
    Module._load = function(name, ...args) {
      if (name === 'vscode') return { Uri: { parse: value => ({ toString: () => value, fsPath: value }) } };
      if (name === './nativeGitBinding' || name === bindingPath) return {
        invokeNativeGit: async (operation, payload) => {
          nativeCalls.push(operation);
          if (operation === 'pushBranches') {
            // 原生样本被 limit 截断成同样长度, 真实未推送数必须单独统计。
            const sample = Array.from({ length: 8 }, (_value, index) => ({ subject: 'c' + index, timestamp: index }));
            return [
              { name: 'master', upstreamName: 'origin/ink_dev', upstreamRemote: 'origin', upstreamBranch: 'ink_dev', isCurrent: true, recentUnpushedCommits: sample },
              { name: 'master', upstreamName: 'origin/master', upstreamRemote: 'origin', upstreamBranch: 'master', isCurrent: true, recentUnpushedCommits: sample },
            ];
          }
          if (operation === 'head') return { hash: 'a'.repeat(40), branch: 'master', detached: false };
          if (operation === 'branches') return {
            currentBranch: 'refs/heads/master',
            local: [{ hash: 'a'.repeat(40), name: 'refs/heads/master', label: 'master', upstreamName: 'origin/master' }],
            remote: [
              { hash: 'b'.repeat(40), name: 'refs/remotes/origin/ink_dev', label: 'origin/ink_dev', upstreamName: null },
              { hash: 'c'.repeat(40), name: 'refs/remotes/origin/master', label: 'origin/master', upstreamName: null },
            ],
          };
          if (operation === 'commitDetails') return [
            { hash: 'b'.repeat(40), authorDate: '2026-09-02T14:16:25+08:00' },
            { hash: 'c'.repeat(40), authorDate: '2026-10-12T10:57:46+08:00' },
          ];
          if (operation === 'rangeCommits') {
            rangeRequests.push(payload.from);
            // 每个远程分支的未推送数量不同; limit 截断的样本长度不能当作总数。
            const total = payload.from === 'origin/ink_dev' ? 146 : 64;
            return Array.from({ length: total }, (_value, index) => ({ hash: String(index).padStart(40, '0') }));
          }
          throw new Error('unexpected native operation: ' + operation);
        },
      };
      return load.call(this, name, ...args);
    };
    ({ getPushPlan } = require('../out/git/gitLogProvider'));
  } finally {
    Module._load = load;
    delete require.cache[require.resolve('../out/git/gitLogProvider')];
    delete require.cache[require.resolve('../out/git/nativeGitBinding')];
  }
  const plan = await getPushPlan(rootUri);
  // 推送源: 分支名取自 HEAD 的分支, hash 取自 HEAD 指向的提交; 两者分开存放。
  assert.deepEqual(plan.source, { branchName: 'master', hash: 'a'.repeat(40) }, 'the push source keeps the branch name and the commit hash in separate fields');
  const targets = plan.targets;
  assert.deepEqual(targets.map(target => target.remoteName), ['origin/master', 'origin/ink_dev'], 'the configured upstream is ordered first');
  assert.deepEqual(targets.map(target => target.remote), ['origin', 'origin']);
  assert.deepEqual(targets.map(target => target.branch), ['master', 'ink_dev'], 'the remote branch name never carries the remote prefix');
  assert.deepEqual(targets.map(target => target.isUpstream), [true, false], 'the configured upstream is derived from branch refs when the native module omits isUpstream');
  assert.deepEqual(targets.map(target => target.tipTimestamp), [1791773866, 1788329785], 'remote tip timestamps are derived from commit dates when the native module omits tipTimestamp');
  assert.ok(nativeCalls.includes('branches') && nativeCalls.includes('commitDetails'), 'enrichment reads branch refs and commit dates');
  assert.deepEqual(targets.map(target => target.unpushedCommitCount), [64, 146], 'each remote target reports its own unpushed total instead of the limit-truncated sample length');
  assert.deepEqual(rangeRequests, ['origin/ink_dev', 'origin/master'], 'unpushed totals are counted per remote branch');
}
async function verifyProvider() {
  // Host selection routing and stale MultiDiff feedback are tested below with the actual methods.
  const load = Module._load;
  const branchReads = [], commitDetailReads = [], checkouts = [], pulls = [], pushes = [], headRefreshes = [], remoteCheckouts = [];
  let pickedIndex = 2, options, branchItems, pushTargetDefaults, pushQuickPick, selectedPushTargetsResult, confirmRows;
  const terminals = [], informationMessages = [], errorMessages = [], confirmationDialogs = [];
  let terminalShows = 0, confirmationChoice = '推送';
  // 推送目标只描述远程分支; 本地分支名与 HEAD hash 属于 plan.source。
  const pushTargetFixture = [
    { remote: 'fork', branch: 'main', remoteName: 'fork/main', isUpstream: false, tipTimestamp: 200, unpushedCommitCount: 1 },
    { remote: 'origin', branch: 'main', remoteName: 'origin/main', isUpstream: true, tipTimestamp: 100, unpushedCommitCount: 2 },
  ];
  const pushPlanFixture = { source: { branchName: 'main', hash: 'a'.repeat(40) }, targets: pushTargetFixture };
  const pushDialogPlan = {
    source: { branchName: 'ink_dev', hash: 'f'.repeat(40) },
    targets: [
      { remote: 'origin', branch: 'ink_master', remoteName: 'origin/ink_master', isUpstream: true, tipTimestamp: 100, unpushedCommitCount: 0 },
      { remote: 'upstream', branch: 'develop', remoteName: 'upstream/develop', isUpstream: false, tipTimestamp: 200, unpushedCommitCount: 1 },
    ],
  };
  const detachedPlan = { source: { hash: 'd'.repeat(40) }, targets: pushDialogPlan.targets };
  const branchFixture = [
    { name: 'refs/heads/main', label: 'main', kind: 'current', hash: 'a'.repeat(40), authorDate: '2026-10-01T00:00:00Z' },
    { name: 'refs/heads/main', label: 'main', kind: 'local', hash: 'a'.repeat(40), authorDate: '2026-10-01T00:00:00Z' },
    { name: 'refs/heads/feature/x', label: 'feature/x', kind: 'local', hash: 'b'.repeat(40), authorDate: '2026-10-10T00:00:00Z' },
    { name: 'refs/heads/feature/y', label: 'feature/y', kind: 'local', hash: 'f'.repeat(40), authorDate: '2026-10-17T00:00:00Z' },
    { name: 'refs/remotes/origin/remote', label: 'origin/remote', kind: 'remote', hash: 'c'.repeat(40), authorDate: '2026-10-18T00:00:00Z' },
    { name: 'refs/remotes/origin/older', label: 'origin/older', kind: 'remote', hash: 'g'.repeat(40), authorDate: '2026-09-01T00:00:00Z' },
    { name: 'refs/remotes/origin/HEAD', label: 'origin/HEAD', kind: 'remote', hash: 'c'.repeat(40), authorDate: '2026-10-18T00:00:00Z' },
    { name: 'd'.repeat(40), label: 'detached', kind: 'current', hash: 'd'.repeat(40) },
  ];
  const vscode = {
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    ProgressLocation: { Notification: 1 },
    QuickPickItemKind: { Separator: -1 },
    Uri: { parse: value => ({ toString: () => value, fsPath: value }) },
    window: {
      showQuickPick: async (items, opts) => { options = opts; branchItems = items; return pickedIndex === null ? undefined : items.filter(item => item.branch)[pickedIndex]; },
      showInputBox: async opts => { assert.equal(opts.value, 'remote'); assert.equal(opts.validateInput('main'), '本地分支已存在，请使用其他名称'); return opts.value; },
      showInformationMessage(message, options, ...items) {
        if (options?.modal) {
          confirmationDialogs.push({ message, options, items });
          return Promise.resolve(items.find(item => item.title === confirmationChoice));
        }
        informationMessages.push(message);
      },
      showErrorMessage(message) { errorMessages.push(message); },
      createTerminal: options => { terminals.push(options); return { show: () => terminalShows++ }; },
      withProgress: async (_options, task) => task({ report() {} }),
      createQuickPick: () => {
        const quickPick = {
          items: [], selectedItems: [], activeItems: [], buttons: [],
          onDidAccept(listener) { this.accept = listener; return { dispose() {} }; },
          onDidTriggerButton() { return { dispose() {} }; },
          onDidHide() { return { dispose() {} }; },
          show() {}, hide() {}, dispose() {},
        };
        pushQuickPick = quickPick;
        return quickPick;
      },
    },
  };
  let pickPushTargets, confirmPush, describePushRow, showPushResult;
  let GitkViewProvider, store;
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return vscode;
      if (name === '../git/gitLogProvider') return {
        ...load.call(this, name, ...args),
        getGitBranches: async uri => { branchReads.push(uri.toString()); return branchFixture; },
        getGitAheadBehind: async () => ({ ahead: 4, behind: 2 }),
        getPushPlan: async () => pushPlanFixture,
      };
      if (name === '../services/pushDialogs') return {
        ...load.call(this, name, ...args),
        pickPushTargets: async (_plan, defaultTargets) => { pushTargetDefaults = defaultTargets; return selectedPushTargetsResult; },
        confirmPush: async rows => { confirmRows = rows; return true; },
        showPushResult: async () => {},
      };
      if (name === '../git/gitNativeOperations') return {
        ...load.call(this, name, ...args),
        checkoutBranch: async (uri, branch) => { checkouts.push([uri.toString(), branch]); },
        checkoutRemoteBranch: async (uri, ref, localName) => remoteCheckouts.push([uri.toString(), ref, localName]),
        commitDetails: async (uri, hashes) => {
          commitDetailReads.push([uri.toString(), [...hashes]]);
          return hashes.map(hash => ({ hash, authorDate: branchFixture.find(branch => branch.hash === hash)?.authorDate }));
        },
        pull: async (uri, remote, remoteBranch, localBranch) => { pulls.push([uri.toString(), remote, remoteBranch, localBranch]); },
        push: async (uri, request) => { pushes.push([uri.toString(), request.remote, request.remoteBranch, request.sourceBranchName, request.sourceHash]); throw new Error('stop after push'); },
      };
      return load.call(this, name, ...args);
    };
    ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
    ({ pickPushTargets, confirmPush, describePushRow, showPushResult } = require('../out/services/pushDialogs'));
    ({ store } = require('../out/state/store'));
  } finally { Module._load = load; }
  // 目标选择弹窗: 标题显示本地分支名, detail 只显示未推送提交数。
  void pickPushTargets(pushDialogPlan, [pushDialogPlan.targets[0]]);
  assert.equal(pushQuickPick.title, 'ink_dev 要推送的远程分支', 'the dialog title shows the repository card branch name, not a hash');
  assert.deepEqual(pushQuickPick.items.map(item => item.label), ['$(cloud) origin/ink_master', '$(cloud) upstream/develop'], 'bound upstream stays first even when another remote has a newer tip');
  assert.deepEqual(pushQuickPick.items.map(item => item.description), [undefined, undefined], 'unpush counts are no longer rendered as descriptions');
  assert.deepEqual(pushQuickPick.items.map(item => item.detail), ['未推送提交：0', '未推送提交：1'], 'target detail contains only the unpushed count');
  assert.deepEqual(pushQuickPick.selectedItems.map(item => item.target.remoteName), ['origin/ink_master']);
  void pickPushTargets(pushDialogPlan, [pushDialogPlan.targets[1]]);
  assert.deepEqual(pushQuickPick.items.map(item => item.label), ['$(cloud) origin/ink_master', '$(cloud) upstream/develop'], 'a cached default target is checked but never reordered above the bound upstream');
  assert.deepEqual(pushQuickPick.selectedItems.map(item => item.target.remoteName), ['upstream/develop']);
  // detached HEAD 没有分支名: 标题与行文本退回短 hash, 且明确标注游离状态。
  void pickPushTargets(detachedPlan, []);
  assert.equal(pushQuickPick.title, '游离 HEAD dddddddd 要推送的远程分支');
  // 原生确认弹窗: 只有推送和取消, 分支列表在模态正文中逐行显示。
  assert.equal(await confirmPush([
    { source: pushDialogPlan.source, target: pushDialogPlan.targets[0] },
    { source: pushDialogPlan.source, target: pushDialogPlan.targets[1], repositoryLabel: 'child' },
  ]), true);
  const confirmation = confirmationDialogs.at(-1);
  assert.equal(confirmation.message, '确认推送');
  assert.deepEqual(confirmation.items, [{ title: '推送' }, { title: '取消', isCloseAffordance: true }], 'exactly two plain-text actions, with cancel handling dialog close');
  assert.deepEqual(confirmation.options, {
    modal: true,
    detail: '需要推送的分支：\nink_dev → origin/ink_master\nchild：ink_dev → upstream/develop',
  }, 'modal detail lists each branch on its own line');
  confirmationChoice = '取消';
  assert.equal(await confirmPush([{ source: pushDialogPlan.source, target: pushDialogPlan.targets[0] }]), false);
  confirmationChoice = undefined;
  assert.equal(await confirmPush([{ source: detachedPlan.source, target: detachedPlan.targets[0] }]), false, 'closing the dialog never pushes');
  assert.equal(describePushRow({ source: pushDialogPlan.source, target: pushDialogPlan.targets[0], repositoryLabel: 'child' }), 'child：ink_dev → origin/ink_master（提交 ffffffff）');
  assert.equal(describePushRow({ source: detachedPlan.source, target: detachedPlan.targets[0] }), '游离 HEAD dddddddd → origin/ink_master（提交 dddddddd）');
  await verifyPushPlanEnrichment();
  await showPushResult('Git Push 已完成', 'child：main → origin/main，提交 aaaaaaaa');
  assert.equal(informationMessages.at(-1), 'Git Push 已完成：child：main → origin/main，提交 aaaaaaaa', 'successful push uses a concise information notification');
  await showPushResult('Git Push 失败', 'network unavailable');
  assert.equal(errorMessages.at(-1), 'Git Push 失败：network unavailable', 'failed push uses an error notification');
  const repositories = ['parent', 'child', 'clean'].map((repositoryLabel, index) => ({ path: 'file:///fixture/' + repositoryLabel, label: repositoryLabel, hasSubmodules: index < 2, ancestry: index ? ['file:///fixture/parent'] : [] }));
  let published;
  const provider = Object.create(GitkViewProvider.prototype);
  Object.defineProperties(provider, {
    repositories: { value: repositories }, selectedRepositoryPaths: { value: [repositories[0].path] },
    selectedBranches: { value: [] }, branches: { value: [] },
    commitLoadingMode: { value: 'bar' },
  });
  Object.assign(provider, {
    view: { webview: { postMessage: value => { published = value; } } },
    changedFileSummaryCache: new WeakMap(), selectedBranchesMap: new Map(),
    commitMessageByRepo: new Map([[repositories[1].path, 'child draft']]), commitCommittingByRepo: new Set(),
    pushTargetByRepository: new Map(), lastPushedTargetByRepository: new Map(),
    unpushedCommitCountByRepository: new Map([[repositories[1].path, 4]]),
    behindCommitCountByRepository: new Map([[repositories[1].path, 0]]),
    repositorySyncKeyByRepository: new Map(), repositorySyncStateLoadingByHead: new Set(),
    loadRepositorySyncState: async () => {},
    schedulePushState: () => {}, commitPanel: { isVisible: () => false },
    repoSubmoduleWatcher: {
      findSubmoduleRepository: (_parent, file) => file === 'leaf-link' ? repositories[2] : file === 'parent-link' ? repositories[0] : undefined,
      getRepositoryAncestry: () => [],
    },
    commitPanelViewTitleController: { update() {} },
    branchesController: { clearRepositorySelection: () => {} },
    commitController: { isLoading: false, searchedCommitList: [], displayedSearchKeywords: [], totalCommitList: [],
      selectCommit: commit => { provider.commitController.selectedCommit = commit; return true; } },
    uncommittedFilesWatcher: {
      listCurrentHeadBranches: () => repositories.map(repoOption => ({ repoOption, name: 'refs/heads/main', label: 'deadbeef', kind: 'current', hash: 'd'.repeat(40) })),
      getUncommittedFilesByHeadBranch: async branch => branch.repoOption.path === repositories[1].path
        ? { staged: [], changes: [{ path: 'same.cpp', status: 'M' }] } : { staged: [], changes: [] },
    },
    selectCommitPanelRepository: async branch => {
      if (repoSelection.length !== 1 || repoSelection[0].path !== branch.repoOption.path) provider.repoController.selectRepositories([branch.repoOption]);
      return branch;
    },
    selectWorkingTreeChanges: async () => {},
  });
  store.setState({ commitRepositories: [{ repository: repositories[1], repositoryPath: repositories[1].path, repositoryLabel: 'child', staged: [], unstaged: [
    { path: 'same.cpp', status: 'M' },
    { path: 'leaf-link', status: 'M', isGitlink: true },
    { path: 'parent-link', status: 'M', isGitlink: true },
  ] }] });
  provider.pushStateToWebview();
  assert.equal(published.state.repositoryChanges.length, 3, 'full topology is published even without opening Commit Panel');
  assert.deepEqual(published.state.repositoryChanges.map(repository => repository.isMainRepository), [true, false, false]);
  assert.deepEqual(published.state.repositoryChanges.map(repository => repository.hasSubmodules), [true, true, false]);
  assert.deepEqual(published.state.repositoryChanges.map(repository => repository.isSubmodule), [false, true, true]);
  assert.equal(published.state.repositoryChanges[1].message, 'child draft');
  assert.equal(published.state.repositoryChanges[1].behindCount, 0);
  assert.equal(published.state.repositoryChanges[1].aheadCount, 4);
  delete provider.loadRepositorySyncState;
  provider.unpushedCommitCountByRepository.clear(); provider.behindCommitCountByRepository.clear();
  await provider.loadRepositorySyncState(repositories[1].path);
  assert.equal(provider.behindCommitCountByRepository.get(repositories[1].path), 2, 'sync state loads commits behind the configured upstream');
  assert.equal(provider.unpushedCommitCountByRepository.get(repositories[1].path), 4, 'sync state loads commits ahead of the configured upstream');
  provider.loadRepositorySyncState = async () => {};
    assert.equal(published.state.repositoryChanges[1].headLabel, 'deadbeef');
  assert.equal(published.state.repositoryChanges[1].unstaged[0].path, 'same.cpp');
  assert.equal(published.state.repositoryChanges[1].unstaged[1].gitlinkHasSubmodules, false, 'leaf Gitlink inherits the target repository topology');
  assert.equal(published.state.repositoryChanges[1].unstaged[2].gitlinkHasSubmodules, true, 'parent Gitlink inherits the target repository topology');
  assert.deepEqual(published.state.repositoryChanges[2].unstaged, [], 'clean repositories are not filtered out');
  const selectedMetadata = { hash: 'history', message: 'subject', body: 'body', rawMessage: 'exact raw text', gitBranchOption: { repoOption: repositories[1] } };
  provider.commitController.selectedCommit = selectedMetadata; provider.pushStateToWebview();
  store.setState({ currentHash: selectedMetadata.hash, currentRepositoryPath: repositories[1].path });
  provider.pushStateToWebview();
  assert.deepEqual(published.state.filesIdentity, { hash: selectedMetadata.hash, repositoryPath: repositories[1].path }, 'file ownership is published separately from controller selection');
  assert.equal(published.state.selectedCommit.rawMessage, selectedMetadata.rawMessage, 'selected metadata is published even outside the visible history page');
  assert.equal(published.state.selectedCommit.message, 'subject'); assert.equal(published.state.selectedCommit.body, 'body');
  assert.equal(published.state.selectedCommit.repositoryPath, repositories[1].path);
  provider.commitController.selectedCommit = undefined;
  let operation;
  let repoSelection = [repositories[0]];
  const selections = [];
  provider.repoController = {
    get selectedRepoList() { return repoSelection; },
    selectRepositories: value => { repoSelection = value; selections.push(value); },
  };
  provider.commitController.totalCommitList = [{ hash: 'clean-latest', message: 'latest clean commit', gitBranchOption: { repoOption: repositories[2] } }];
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'terminal', repositoryPath: repositories[1].path });
  assert.equal(terminals[0].cwd.toString(), repositories[1].path, 'child terminal cwd is independent of selected parent');
  assert.equal(terminals[0].name, 'Gitk: child'); assert.equal(terminalShows, 1);
  assert.equal(selections.length, 0, 'opening a terminal does not change selected repository');
  const savedHeads = provider.uncommittedFilesWatcher.listCurrentHeadBranches;
  provider.uncommittedFilesWatcher.listCurrentHeadBranches = () => [];
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'terminal', repositoryPath: repositories[2].path });
  assert.equal(terminals[1].cwd.toString(), repositories[2].path, 'terminal is available without HEAD or unstaged files');
  provider.uncommittedFilesWatcher.listCurrentHeadBranches = savedHeads;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'terminal', repositoryPath: 'file:///outside' });
  assert.equal(terminals.length, 2, 'unknown repository cannot open a terminal');
  assert.equal(terminalShows, 2);
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[1].path, action: 'focus' });
  assert.deepEqual(selections, [[repositories[1]]], 'focus uses authoritative selection pipeline that drives commit history');
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[1].path, action: 'focus' });
  assert.equal(selections.length, 1, 'repeated focus must not restart commit reads');
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[2].path, action: 'focus' });
  assert.equal(provider.commitController.selectedCommit.hash, 'clean-latest', 'clean repository opens on its latest commit');
  const selectionsBeforeUnknownFocus = selections.length;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: 'file:///outside', action: 'focus' });
  assert.equal(selections.length, selectionsBeforeUnknownFocus, 'unknown focus target rejected');
  const selectionsBeforeUnfocusedCollapse = selections.length;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[0].path, action: 'blur' });
  assert.equal(selections.length, selectionsBeforeUnfocusedCollapse, 'collapse of an unfocused repository does not clear selection');
  const selectionsBeforeFocusedBlur = selections.length;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[2].path, action: 'blur' });
  assert.equal(selections.length, selectionsBeforeFocusedBlur + 1, 'blur of the focused repository clears its authoritative selection');
  assert.deepEqual(selections.at(-1), [], 'focused repository blur clears selection');
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[1].path, action: 'focus' });
  provider.openCommitPanelWorkingTreeDiff = async (...args) => { operation = args; };
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesFile', repositoryPath: repositories[1].path, section: 'unstaged', path: 'same.cpp' });
  assert.deepEqual(operation, [repositories[1].path, 'unstaged', 'same.cpp']);
  operation = undefined;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesFile', repositoryPath: 'file:///other', section: 'unstaged', path: 'same.cpp' });
  assert.equal(operation, undefined, 'unknown repository is rejected');
  provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = async () => ({ staged: [], changes: [{ path: 'same.cpp', status: 'M' }] });
  provider.runCommitPanelWorkingTreeAction = async (...args) => { operation = args; };
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[1].path, section: 'unstaged', action: 'stage', paths: ['same.cpp', 'unrelated.cpp'] });
  assert.deepEqual(operation, [repositories[1].path, 'stage', 'unstaged', ['same.cpp'], []]);
  provider.uncommittedFilesWatcher.refreshHeadBranch = async repo => headRefreshes.push(repo);
  provider.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch = async branch => headRefreshes.push(branch.repoOption.path);
  let selectorsRefreshed = 0, pushed = 0;
  provider.selectedRepoTotalBranchWatcher = { refreshSelectedRepositories: () => selectorsRefreshed++ };
  provider.schedulePushState = () => pushed++;
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[1].path, action: 'branch' });
  assert.deepEqual(branchItems.map(item => item.label), ['【本地分支】3 个', '$(target) main', '$(git-branch) feature/y', '$(git-branch) feature/x', '【远程分支 / origin】2 个', '$(cloud) remote', '$(cloud) older'], 'group local/remote refs and sort each group by latest tip while omitting duplicate local refs, remote HEAD aliases and detached entries');
  assert.deepEqual(branchItems.filter(item => !item.branch).map(item => item.kind), [-1, -1]);
  assert.equal(options.title, 'child：切换分支');
  assert.equal(options.matchOnDescription, true); assert.equal(options.matchOnDetail, true);
  assert.equal(branchItems[1].description, '本地 · 当前分支');
  assert.equal(branchItems[2].description, '本地');
  assert.equal(branchItems.at(-1).description, '远程 · origin');
  assert.match(branchItems.at(-1).detail, /origin\s+\u00b7\s+最新提交/);
  assert.deepEqual(commitDetailReads[0][1], ['a'.repeat(40), 'b'.repeat(40), 'f'.repeat(40), 'c'.repeat(40), 'g'.repeat(40)], 'tip dates are read once per unique branch tip');
  assert.deepEqual(branchReads, [repositories[1].path]);
  assert.deepEqual(checkouts, [[repositories[1].path, 'feature/x']], 'checkout belongs to clicked repository, not selected parent');
  assert.deepEqual(headRefreshes, [repositories[1].path, repositories[1].path]);
  assert.equal(selectorsRefreshed, 1); assert.equal(pushed, 1);
  pickedIndex = null;
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  pickedIndex = 0;
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  assert.equal(checkouts.length, 1, 'cancel/current branch selection must not mutate Git');
  pickedIndex = 3;
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  assert.deepEqual(remoteCheckouts, [[repositories[1].path, 'refs/remotes/origin/remote', 'remote']]);
  branchFixture[2].upstreamName = 'origin/remote';
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  assert.deepEqual(checkouts.at(-1), [repositories[1].path, 'feature/x'], 'existing tracking branch is reused rather than recreated');
  assert.equal(remoteCheckouts.length, 1);
  pickedIndex = null;
  branchFixture.push({ name: 'refs/remotes/upstream/team/topic', label: 'upstream/team/topic', kind: 'remote', hash: 'e'.repeat(40) });
  // A later current entry must replace a duplicate local entry, independent of enumeration order.
  [branchFixture[0], branchFixture[1]] = [branchFixture[1], branchFixture[0]];
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  assert.deepEqual(branchItems.filter(item => !item.branch).map(item => item.label), ['【本地分支】3 个', '【远程分支 / origin】2 个', '【远程分支 / upstream】1 个']);
  assert.equal(branchItems.find(item => item.branch?.name === 'refs/heads/main').description, '本地 · 当前分支');
  assert.equal(branchItems.at(-1).label, '$(cloud) team/topic', 'remote grouping preserves nested branch names');
  const selectedWorktrees = [];
  provider.selectCommitPanelRepository = async branch => branch;
  provider.commitController.selectCommit = commit => { selectedWorktrees.push(commit); return true; };
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'worktree', repositoryPath: repositories[1].path });
  assert.equal(selectedWorktrees[0].hash, 'uncommitted');
  assert.equal(selectedWorktrees[0].gitBranchOption.repoOption.path, repositories[1].path);
  assert.equal(provider.pendingGitlinkWorktreeSnapshot.repositoryPath, repositories[1].path);
  assert.equal(provider.pendingGitlinkWorktreeSnapshot.changes.changes[0].path, 'same.cpp');
  let releaseWorktree;
  provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = () => new Promise(resolve => { releaseWorktree = resolve; });
  const pendingWorktree = provider.selectRepositoryChangesWorktree(repositories[1].path);
  await new Promise(resolve => setImmediate(resolve));
  provider.selectRepositoryChangesDefault = async repositoryPath => {
    provider.repoController.selectRepositories([repositories.find(repository => repository.path === repositoryPath)]);
  };
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].path });
  releaseWorktree({ staged: [], changes: [] });
  await pendingWorktree;
  assert.equal(selectedWorktrees.length, 1, 'a stale badge read cannot reselect a child after focus moves elsewhere');
  provider.pushTargetByRepository.set(repositories[1].path, pushTargetFixture[0]);
  provider.lastPushedTargetByRepository.set(repositories[1].path, pushTargetFixture[0]);
  await provider.runCommitPanelPush([repositories[1].path], true, false);
  assert.equal(pushTargetDefaults[0].remoteName, 'origin/main', 'sync defaults to the current branch configured upstream, not cached or first remote');
  await provider.runCommitPanelPush([repositories[1].path], false, false);
  assert.equal(pushTargetDefaults[0].remoteName, 'fork/main', 'plain push keeps the cached target');
  const checkoutCountBeforePush = checkouts.length;
  selectedPushTargetsResult = [pushTargetFixture[1]];
  await provider.runCommitPanelPush([repositories[1].path], true, false);
  // 确认行用的是 HEAD 现场读到的分支名与 hash, 而不是目标里的任何字段。
  assert.deepEqual(confirmRows.map(row => [row.source.branchName, row.source.hash, row.target.remoteName]), [['main', 'a'.repeat(40), 'origin/main']]);
  selectedPushTargetsResult = undefined;
  assert.equal(checkouts.length, checkoutCountBeforePush, 'push does not switch branches');
  assert.deepEqual(pulls, [], 'push does not pull before sending the current branch commit');
  assert.deepEqual(pushes.at(-1), [repositories[1].path, 'origin', 'main', 'main', 'a'.repeat(40)], 'push sends the current HEAD to the selected remote branch, carrying branch name and hash in separate fields');
  const syncSteps = [];
  provider.runCommitPanelPush = async (...args) => syncSteps.push(['sync', ...args]);
  provider.uncommittedFilesWatcher.refreshHeadBranch = async value => syncSteps.push(['head', value]);
  provider.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch = async branch => syncSteps.push(['status', branch.repoOption.path]);
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'syncRefresh', repositoryPath: repositories[1].path });
  assert.deepEqual(syncSteps, [['sync', [repositories[1].path], true, false, true]], 'card sync uses the current branch configured upstream and no longer runs the manual workspace/history refresh');
  await verifyFocusedRefresh(GitkViewProvider, repositories);
  await verifyGitlinkNavigation(GitkViewProvider, store);
  await verifyMultiDiffHostSelection(GitkViewProvider, store, repositories);
}
async function verifyFocusedRefresh(Provider, repositories) {
  const provider = Object.create(Provider.prototype);
  const steps = [];

  const historyRefreshModes = [];
  const progressSnapshots = [];
  let releaseHead, releaseHistory;
  const child = repositories[1].path;
  Object.defineProperties(provider, {
    repositories: { value: repositories }, selectedRepositoryPaths: { value: [child], configurable: true },
  });
  Object.assign(provider, {
    uncommittedFilesWatcher: {
      refreshHeadBranch: async repositoryPath => {
        steps.push(['head', repositoryPath]);
        if (repositoryPath === child) await new Promise(resolve => { releaseHead = resolve; });
      },
      listCurrentHeadBranches: () => repositories.map(repoOption => ({ repoOption })),
      refreshUncommittedFilesByHeadBranch: async branch => steps.push(['status', branch.repoOption.path]),
    },
    selectedRepoTotalBranchWatcher: { refreshSelectedRepositories: () => steps.push(['branches']) },
    commitController: { forceRefreshCurrentSelection: async worktreeAlreadyRefreshed => {
      historyRefreshModes.push(worktreeAlreadyRefreshed);
      steps.push(['history']);
      await new Promise(resolve => { releaseHistory = resolve; });
    } },
    schedulePushState: () => {
      steps.push(['publish']);
      progressSnapshots.push(provider.viewDataRefreshProgress ? { ...provider.viewDataRefreshProgress } : undefined);
    },
    requestRepositoryScan: () => steps.push(['scan']),
    runCommitPanelPush: () => { throw new Error('manual refresh must not push'); },
  });
  const pending = provider.refreshCurrentViewData();
  assert.equal(provider.refreshCurrentViewData(), pending, 'repeated refresh clicks share the in-flight operation');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps.filter(step => step[0] !== 'publish').slice(0, 3), [['head', child], ['head', repositories[0].path], ['head', repositories[2].path]], 'focused and non-focused HEAD reads start together');
  assert.deepEqual(steps.filter(step => step[0] === 'history'), [['history']], 'history refresh starts in the local critical batch');
  assert.deepEqual(steps.filter(step => step[0] === 'status'), [['status', repositories[0].path], ['status', repositories[2].path]], 'other repositories publish while focused HEAD and history are still pending');
  assert.equal(steps.some(step => step[0] === 'scan'), false, 'repository scan waits until local refresh is complete');
  assert.deepEqual(progressSnapshots, [{ completed: 0, total: 4 }, { completed: 1, total: 4 }, { completed: 2, total: 4 }], 'progress starts immediately and advances per completed repository');
  releaseHead(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps.at(-1), ['publish'], 'local refresh completes without waiting for remote fetch');
  assert.equal(provider.refreshCurrentViewData(), pending, 'refresh lock remains held while history is pending');
  releaseHistory(); await pending;
  assert.equal(steps.some(step => step[0] === 'scan'), true, 'repository scan starts after local refresh is complete');
  assert.equal(steps.at(-1)[0], 'publish', 'history completion publishes the final state');
  assert.equal(provider.viewDataRefresh, undefined, 'refresh lock is released');
  assert.deepEqual(progressSnapshots.slice(-3), [{ completed: 3, total: 4 }, { completed: 4, total: 4 }, undefined], 'progress completes and is cleared after all tasks settle');
  assert.deepEqual(provider.selectedRepositoryPaths, [child], 'refresh preserves focus');
  assert.deepEqual(historyRefreshModes, [true], 'manual refresh performs one history refresh and reuses worktree reads');
  const failure = new Error('history failed');
  provider.commitController.forceRefreshCurrentSelection = async () => { throw failure; };
  provider.uncommittedFilesWatcher.refreshHeadBranch = async () => {};
  await assert.rejects(provider.refreshCurrentViewData(), error => error === failure);
  assert.equal(provider.viewDataRefresh, undefined, 'failed refresh also releases the lock');
  assert.equal(provider.viewDataRefreshProgress, undefined, 'failed refresh also clears progress');
  Object.defineProperty(provider, 'selectedRepositoryPaths', { value: [] });
  provider.commitController.forceRefreshCurrentSelection = async () => steps.push(['history']);
  provider.uncommittedFilesWatcher.refreshHeadBranch = async repositoryPath => steps.push(['head', repositoryPath]);
  steps.length = 0;
  await provider.refreshCurrentViewData();
  assert.deepEqual(steps.filter(step => step[0] === 'head').map(step => step[1]), repositories.map(repository => repository.path), 'without focus all known repositories still refresh');
}
async function verifyMultiDiffHostSelection(Provider, store, repositories) {
  const defaults = Object.create(Provider.prototype);
  const branch = { repoOption: repositories[1] };
  Object.assign(defaults, {
    commitController: { selectedCommit: { hash: 'uncommitted', gitBranchOption: branch } },
    commitFilesGeneration: 0, pendingDiffPaths: new Set(), workingTreeDiffCache: new Map(),
    diffReader: { stop() {} }, cancelPriorityDiffLoad() {},
  });
  const changes = { staged: [{ path: 'same.cpp', status: 'M' }], changes: [{ path: 'same.cpp', status: 'M' }] };
  store.setState({ currentHash: 'uncommitted', currentRepositoryPath: repositories[1].path,
    currentChangeSet: 'uncommitted', files: [], selectedPath: undefined });
  const select = changes => defaults.selectWorkingTreeChanges(changes, false, false, undefined, false);
  await select(changes);
  assert.deepEqual(store.getState().files.map(file => file.diffKey), ['unstaged:same.cpp', 'staged:same.cpp']);
  assert.equal(store.getState().selectedPath, 'unstaged:same.cpp', 'initial selection follows first visible group');
  store.setState({ selectedPath: 'staged:same.cpp' });
  await select(changes);
  assert.equal(store.getState().selectedPath, 'staged:same.cpp', 'refresh preserves explicit staged selection');
  store.setState({ files: [], selectedPath: undefined });
  await select({ staged: changes.staged, changes: [] });
  assert.equal(store.getState().selectedPath, 'staged:same.cpp', 'staged-only repository falls back correctly');
  store.setState({ files: [], selectedPath: undefined });
  await select({ staged: changes.staged, changes: [{ path: 'conflict.cpp', status: 'U', isConflict: true }, ...changes.changes] });
  assert.deepEqual(store.getState().files.map(file => file.diffKey), ['conflict:conflict.cpp', 'unstaged:same.cpp', 'staged:same.cpp']);
  assert.equal(store.getState().selectedPath, 'conflict:conflict.cpp', 'conflict takes first-group priority');
  const provider = Object.create(Provider.prototype);
  const child = repositories[1].path; const fileKey = 'unstaged:same.cpp';
  const reveals = [], opened = [];
  Object.assign(provider, {
    view: { visible: true }, multiDiffSelectionEpoch: 4,
    multiDiffPanel: { revealFile: (...args) => { reveals.push(args); return true; } },
    uncommittedFilesWatcher: { listCurrentHeadBranches: () => [{ repoOption: repositories[1] }] },
    canShowMultiDiff: () => true, openDiff: (...args) => opened.push(args),
  });
  store.setState({ currentHash: 'uncommitted', currentRepositoryPath: child, diffGeneration: 100, diffLoading: true,
    files: [{ path: 'same.cpp', diffKey: fileKey }, { path: 'same.cpp', diffKey: 'staged:same.cpp' }], selectedPath: 'staged:same.cpp' });
  await provider.openCommitPanelWorkingTreeDiff(child, 'unstaged', 'same.cpp');
  assert.equal(store.getState().selectedPath, fileKey);
  assert.deepEqual(reveals, [[fileKey, 5]], 'existing MultiDiff is revealed with a new selection epoch even while other diffs load');
  assert.equal(opened.length, 0, 'selection does not reopen the already active MultiDiff');
  provider.syncFileHighlightFromDiffPanel('staged:same.cpp', 100, 4);
  assert.equal(store.getState().selectedPath, fileKey, 'old scroll feedback cannot override the latest click');
  provider.syncFileHighlightFromDiffPanel('staged:same.cpp', 99, 5);
  assert.equal(store.getState().selectedPath, fileKey, 'old diff generation cannot override selection');
  provider.syncFileHighlightFromDiffPanel('staged:same.cpp', 100, 5);
  assert.equal(store.getState().selectedPath, 'staged:same.cpp', 'current scroll feedback selects the exact diff key');
  provider.multiDiffPanel.revealFile = () => false;
  await provider.openCommitPanelWorkingTreeDiff(child, 'unstaged', 'same.cpp');
  assert.deepEqual(opened, [[fileKey, 6]], 'inactive MultiDiff opens using the same selected file and epoch');
}
async function verifyGitlinkNavigation(GitkViewProvider, store) {
  const repositories = ['root', 'render', 'gfx'].map((label, index) => ({
    label, path: 'file:///fixture/' + ['root', 'root/render', 'root/render/gfx'][index],
  }));
  const branches = repositories.map(repoOption => ({ repoOption, kind: 'current', name: 'HEAD', label: 'deadbeef', hash: 'd'.repeat(40) }));
  const snapshots = new Map([
    [repositories[0].path, { staged: [], changes: [{ path: 'render', diffKey: 'unstaged:render', isGitlink: true, gitlinkWorktreeDirty: true }] }],
    [repositories[1].path, { staged: [], changes: [{ path: 'gfx', diffKey: 'unstaged:gfx', isGitlink: true, gitlinkWorktreeDirty: true }] }],
    [repositories[2].path, { staged: [], changes: [{ path: 'changed.cpp', diffKey: 'unstaged:changed.cpp', status: 'M' }] }],
  ]);
  const provider = Object.create(GitkViewProvider.prototype);
  let selectedRepositories = [repositories[0]], selectedBranch = branches[0];
  let selectedCommit = { hash: 'uncommitted', gitBranchOption: selectedBranch };
  const listeners = new Set(), messages = [], selections = [], reveals = [];
  Object.assign(provider, {
    gitlinkParentNavigationStack: [],
    view: { webview: { postMessage: message => messages.push(message) } },
    repoSubmoduleWatcher: { findSubmoduleRepository: (parent, file) => repositories.find(repo => repo.path === parent + '/' + file) },
    repoController: {
      get selectedRepoList() { return selectedRepositories; },
      selectRepositories: value => {
        selectedRepositories = value; selections.push(value[0].path);
        // Real repository switches may emit a blank/default selection before the exact target.
        provider.reconcileGitlinkParentNavigation(undefined, undefined);
        selectedBranch = branches.find(branch => branch.repoOption.path === value[0].path);
        for (const listener of listeners) listener(new Map([[value[0], [selectedBranch]]]));
      },
    },
    branchesController: {
      getSelectedCurrentBranch: () => selectedBranch,
      getCurrentBranch: repo => branches.find(branch => branch.repoOption.path === repo.path),
      onSelectedBranchesChanged: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
      onTotalBranchesListChanged: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    },
    uncommittedFilesWatcher: {
      listCurrentHeadBranches: () => branches,
      getUncommittedFilesByHeadBranch: async branch => snapshots.get(branch.repoOption.path),
    },
    findCommit: () => undefined,
    selectRepositoryChangesDefault: async repositoryPath => {
      provider.gitlinkNavigationAbortController?.abort();
      const repository = repositories.find(candidate => candidate.path === repositoryPath);
      if (repository && (selectedRepositories.length !== 1 || selectedRepositories[0].path !== repositoryPath)) {
        provider.repoController.selectRepositories([repository]);
      }
    },
    multiDiffPanel: { setParentCommitNavigation() {} },
    schedulePushState() {},
    commitController: {
      get selectedCommit() { return selectedCommit; },
      selectCommit: commit => {
        selectedCommit = commit;
        provider.reconcileGitlinkParentNavigation(commit.hash, commit.gitBranchOption.repoOption.path);
        const snapshot = provider.pendingGitlinkWorktreeSnapshot;
        assert.equal(snapshot.repositoryPath, commit.gitBranchOption.repoOption.path);
        store.setState({ currentHash: commit.hash, currentRepositoryPath: snapshot.repositoryPath,
          files: snapshot.changes.changes, selectedPath: snapshot.changes.changes[0]?.diffKey });
        provider.pendingGitlinkWorktreeSnapshot = undefined;
        reveals.push(provider.requestedDiffReveal);
        return true;
      },
    },
  });
  store.setState({ currentHash: 'uncommitted', currentRepositoryPath: repositories[0].path,
    files: snapshots.get(repositories[0].path).changes, selectedPath: 'unstaged:render' });
  await provider.selectGitlinkCommit('render', 'uncommitted');
  assert.equal(store.getState().currentRepositoryPath, repositories[1].path);
  assert.ok(messages.some(message => message.type === 'revealRepositoryChanges' && message.repositoryPath === repositories[1].path));
  assert.equal(provider.gitlinkParentNavigationStack.length, 1);
  await provider.selectGitlinkCommit('gfx', 'uncommitted');
  assert.equal(store.getState().currentRepositoryPath, repositories[2].path);
  assert.equal(provider.gitlinkParentNavigationStack.length, 2);
  await provider.backToParentCommit();
  assert.equal(store.getState().currentRepositoryPath, repositories[1].path);
  assert.equal(reveals.at(-1).path, 'unstaged:gfx');
  assert.ok(messages.some(message => message.type === 'revealRepositoryChanges' && message.repositoryPath === repositories[1].path));
  await provider.backToParentCommit();
  assert.equal(store.getState().currentRepositoryPath, repositories[0].path);
  assert.equal(reveals.at(-1).path, 'unstaged:render');
  assert.equal(provider.gitlinkParentNavigationStack.length, 0);
  assert.deepEqual(selections, [repositories[1].path, repositories[2].path, repositories[1].path, repositories[0].path]);
  assert.equal(listeners.size, 0, 'repository selection subscriptions are cleaned up');
  // A newer manual focus supersedes a slow navigation, without selecting its stale target.
  let release;
  let slowReads = 0;
  provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = () => {
    if (slowReads++ === 0) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ staged: [], changes: [] });
  };
  const pending = provider.selectGitlinkCommit('render', 'uncommitted');
  await new Promise(resolve => setImmediate(resolve));
  Object.defineProperty(provider, 'repositories', { value: repositories });
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[2].path });
  release(snapshots.get(repositories[1].path));
  const count = messages.length;
  await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('Gitlink navigation test timed out')), 5000))]);
  assert.equal(messages.length, count, 'cancelled navigation cannot reveal the stale repository');
  assert.equal(provider.gitlinkParentNavigationStack.length, 0, 'cancelled navigation cannot add a Back entry');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
