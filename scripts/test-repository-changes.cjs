const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
  await verifyProvider();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-icon-foreground:#aeb4bc;--vscode-descriptionForeground:#929292;--vscode-editorWidget-background:#202020;--vscode-tab-activeBackground:#202020;--vscode-tab-activeForeground:#cccccc;--vscode-editorGroup-border:#343434;--vscode-widget-border:#343434;--vscode-panel-border:#303030;--vscode-sideBarSectionHeader-background:#181818;--vscode-input-background:#1f1f1f;--vscode-input-foreground:#cccccc;--vscode-input-border:#383838;--vscode-button-background:#176c8b;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#2284a7;--vscode-focusBorder:#007fd4;--vscode-list-hoverBackground:#282828;--vscode-list-activeSelectionBackground:#37373d;--vscode-list-activeSelectionForeground:#ffffff;--vscode-badge-background:#24758e;--vscode-badge-foreground:#ffffff;--vscode-gitDecoration-modifiedResourceForeground:#d9b87a;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({ body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')), contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const iconCss = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const html = renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + iconCss + '</style>');
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
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
      hasSubmodules: index === 0 || index === 3, isSubmodule: index !== 0 && index !== 4,
      headLabel: index ? 'd3eed0b4' : 'ink_dev', message: '', committing: false,
      staged: index === 0 ? [{ path: 'same.cpp', status: 'M' }] : [],
      unstaged: index === 0 ? [{ path: 'same.cpp', status: 'M' }, { path: 'other.cpp', status: 'M' }] : [],
    }));
    const state = { repositoryChanges: repositories, commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [], workingTreeRows: [],
      files: [{ path: 'historic.cpp', status: 'M' }], stagedFiles: [], unstagedFiles: [], filesLoading: false,
      selectedCommit: { hash: '12345678', repositoryPath: repositories[0].repositoryPath }, filesMode: 'flat' };
    const publish = async () => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state);
    await publish();
    await assertCount(page.locator('.repo-changes'), 6);
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
      };
    });
    const expandedLayout = await gutterLayout();
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes.focused'), 1);
    assert.equal(expandedLayout.gutter, 'auto', 'overlay scrollbar does not reserve a gutter');
    assert.equal(expandedLayout.paddingLeft, '0px');
    assert.equal(expandedLayout.paddingRight, '1px');
    assert.ok(expandedLayout.headerWidths.every(width => Math.abs(width + 3 - expandedLayout.clientWidth) < 1), 'repository cards retain a 1px right focus-border boundary');
    const focusBorder = await page.locator('.repo-changes').filter({ has: page.locator('.repo-changes-header') }).nth(0).evaluate(card => {
      const cardRect = card.getBoundingClientRect();
      const listRect = document.getElementById('repositoryChangesList').getBoundingClientRect();
      const scrollbarRect = document.getElementById('repositoryChangesScrollbar').getBoundingClientRect();
      return { cardRight: cardRect.right, listRight: listRect.right, scrollbarLeft: scrollbarRect.left };
    });
    assert.ok(focusBorder.cardRight <= focusBorder.listRight - 1 + 1);
    assert.ok(focusBorder.scrollbarLeft < focusBorder.listRight, 'vertical overlay remains inside its clipped viewport');
    assert.equal(await page.locator('.repo-changes.focused').count(), 1, 'one focused card owns the right focus border');
    assert.equal(await page.locator('.repo-changes.focused').evaluate(card => getComputedStyle(card).borderRightColor), 'rgb(0, 127, 212)', 'focused card retains its visible right focus border');
    assert.equal(expandedLayout.overflowing, true, 'expanded fixture requires a scrollbar');
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
    for (const header of await page.locator('.repo-changes-header').all()) {
      assert.deepEqual(await header.locator('[data-repo-action]').evaluateAll(buttons => buttons.map(button => button.dataset.repoAction)), ['toggle', 'worktree', 'branch', 'syncRefresh', 'terminal'], 'terminal follows the repository sync control');
    }
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes-body:visible'), 6);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].repositoryPath }, 'selecting an expanded repository refocuses rather than collapses');
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes-body:visible'), 5);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'blur', repositoryPath: repositories[0].repositoryPath }, 'second click on focused title collapses the repository');
    await page.locator('.repo-changes-label').first().click();
    await assertCount(page.locator('.repo-changes-body:visible'), 6);
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].repositoryPath }, 'title expansion selects the owning repository');
    const mainCard = page.locator('.repo-changes').first();
    await mainCard.locator('.repo-changes-header').click({ position: { x: 2, y: 15 } });
    assert.equal(await mainCard.locator('.repo-changes-body').isVisible(), false, 'focused header blank area also collapses');
    await mainCard.locator('.repo-changes-header').click({ position: { x: 2, y: 15 } });
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
    assert.equal(await page.locator('.repo-changes-badge').first().textContent(), '2', 'badge deduplicates staged and unstaged paths');
    await assertCount(page.locator('.repo-changes-badge:visible'), 1);
    const badgeStyle = await page.locator('.repo-changes-badge').first().evaluate(node => ({ radius: getComputedStyle(node).borderRadius, color: getComputedStyle(node).backgroundColor, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
    assert.equal(badgeStyle.radius, '50%'); assert.equal(badgeStyle.width, badgeStyle.height); assert.equal(badgeStyle.color, 'rgb(0, 122, 204)');
    await page.locator('.repo-changes-badge').first().click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'worktree', repositoryPath: repositories[0].repositoryPath });
    await page.locator('.repo-changes').first().locator('[data-repo-action="syncRefresh"]').click();
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
    await page.locator('.repo-changes').nth(3).locator('.repo-file').click();
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
    await page.locator('.repo-changes-toggle').first().click();
    assert.deepEqual(await lastMessage(page), { type: 'repositoryChangesAction', action: 'blur', repositoryPath: repositories[0].repositoryPath });
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
  await dropdown.locator('.dropdown-current').click();
  assert.deepEqual(await dropdown.locator('.branch-group-label').allTextContents(), ['本地分支', '远程分支 · origin', '远程分支 · upstream']);
  assert.deepEqual(await dropdown.locator('.branch-group-count').allTextContents(), ['2', '2', '1']);
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
  assert.equal(await dropdown.locator('.branch-group-count:visible').textContent(), '1');
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
async function verifyHistoricalMessage(page, state, publish, repositories) {
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
  assert.equal(await oldRow.locator('.repo-file-actions').evaluate(node => getComputedStyle(node).visibility), 'hidden', 'old pointer-focused row does not retain action affordances');
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
async function verifyProvider() {
  // Host selection routing and stale MultiDiff feedback are tested below with the actual methods.
  const load = Module._load;
  const branchReads = [], checkouts = [], headRefreshes = [], remoteCheckouts = [];
  let pickedIndex = 1, options, branchItems;
  const terminals = []; let terminalShows = 0;
  const branchFixture = [
    { name: 'refs/heads/main', label: 'main', kind: 'current', hash: 'a'.repeat(40) },
    { name: 'refs/heads/main', label: 'main', kind: 'local', hash: 'a'.repeat(40) },
    { name: 'refs/heads/feature/x', label: 'feature/x', kind: 'local', hash: 'b'.repeat(40) },
    { name: 'refs/remotes/origin/remote', label: 'origin/remote', kind: 'remote', hash: 'c'.repeat(40) },
    { name: 'refs/remotes/origin/HEAD', label: 'origin/HEAD', kind: 'remote', hash: 'c'.repeat(40) },
    { name: 'd'.repeat(40), label: 'detached', kind: 'current', hash: 'd'.repeat(40) },
  ];
  const vscode = {
    QuickPickItemKind: { Separator: -1 },
    Uri: { parse: value => ({ toString: () => value, fsPath: value }) },
    window: {
      showQuickPick: async (items, opts) => { options = opts; branchItems = items; return pickedIndex === null ? undefined : items.filter(item => item.branch)[pickedIndex]; },
      showInputBox: async opts => { assert.equal(opts.value, 'remote'); assert.equal(opts.validateInput('main'), '本地分支已存在，请使用其他名称'); return opts.value; },
      showInformationMessage() {},
      showErrorMessage() {},
      createTerminal: options => { terminals.push(options); return { show: () => terminalShows++ }; },
    },
  };
  let GitkViewProvider, store;
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return vscode;
      if (name === '../git/gitLogProvider') return {
        ...load.call(this, name, ...args),
        getGitBranches: async uri => { branchReads.push(uri.toString()); return branchFixture; },
      };
      if (name === '../git/gitNativeOperations') return {
        ...load.call(this, name, ...args),
        checkoutBranch: async (uri, branch) => { checkouts.push([uri.toString(), branch]); },
        checkoutRemoteBranch: async (uri, ref, localName) => remoteCheckouts.push([uri.toString(), ref, localName]),
      };
      return load.call(this, name, ...args);
    };
    ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
    ({ store } = require('../out/state/store'));
  } finally { Module._load = load; }
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
    commitPanelViewTitleController: { update() {} },
    commitController: { isLoading: false, searchedCommitList: [], displayedSearchKeywords: [] },
    uncommittedFilesWatcher: { listCurrentHeadBranches: () => repositories.map(repoOption => ({ repoOption, label: 'deadbeef', kind: 'current', hash: 'd'.repeat(40) })) },
  });
  store.setState({ commitRepositories: [{ repository: repositories[1], repositoryPath: repositories[1].path, repositoryLabel: 'child', staged: [], unstaged: [{ path: 'same.cpp', status: 'M' }] }] });
  provider.pushStateToWebview();
  assert.equal(published.state.repositoryChanges.length, 3, 'full topology is published even without opening Commit Panel');
  assert.deepEqual(published.state.repositoryChanges.map(repository => repository.isMainRepository), [true, false, false]);
  assert.deepEqual(published.state.repositoryChanges.map(repository => repository.hasSubmodules), [true, true, false]);
  assert.deepEqual(published.state.repositoryChanges.map(repository => repository.isSubmodule), [false, true, true]);
  assert.equal(published.state.repositoryChanges[1].message, 'child draft');
    assert.equal(published.state.repositoryChanges[1].headLabel, 'deadbeef');
  assert.equal(published.state.repositoryChanges[1].unstaged[0].path, 'same.cpp');
  assert.deepEqual(published.state.repositoryChanges[2].unstaged, [], 'clean repositories are not filtered out');
  const selectedMetadata = { hash: 'history', message: 'subject', body: 'body', rawMessage: 'exact raw text', gitBranchOption: { repoOption: repositories[1] } };
  provider.commitController.selectedCommit = selectedMetadata; provider.pushStateToWebview();
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
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: 'file:///outside', action: 'focus' });
  assert.equal(selections.length, 1, 'unknown focus target rejected');
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[0].path, action: 'blur' });
  assert.equal(selections.length, 1, 'collapse of an unfocused repository does not clear selection');
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', repositoryPath: repositories[1].path, action: 'blur' });
  assert.deepEqual(selections[1], [], 'collapse of the focused repository cancels authoritative selection');
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
  assert.deepEqual(branchItems.map(item => item.label), ['本地分支 · 2', '$(target) main', '$(git-branch) feature/x', '远程分支 · origin · 1', '$(cloud) remote'], 'group local/remote refs and omit duplicate local refs, remote HEAD aliases and detached entries');
  assert.deepEqual(branchItems.filter(item => !item.branch).map(item => item.kind), [-1, -1]);
  assert.equal(options.title, 'child：切换分支');
  assert.equal(options.matchOnDescription, true); assert.equal(options.matchOnDetail, true);
  assert.equal(branchItems[1].description, '当前分支');
  assert.equal(branchItems.at(-1).description, 'origin');
  assert.match(branchItems.at(-1).detail, /origin\/remote/);
  assert.deepEqual(branchReads, [repositories[1].path]);
  assert.deepEqual(checkouts, [[repositories[1].path, 'feature/x']], 'checkout belongs to clicked repository, not selected parent');
  assert.deepEqual(headRefreshes, [repositories[1].path, repositories[1].path]);
  assert.equal(selectorsRefreshed, 1); assert.equal(pushed, 1);
  pickedIndex = null;
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  pickedIndex = 0;
  await provider.pickRepositoryChangesBranch(repositories[1].path);
  assert.equal(checkouts.length, 1, 'cancel/current branch selection must not mutate Git');
  pickedIndex = 2;
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
  assert.deepEqual(branchItems.filter(item => !item.branch).map(item => item.label), ['本地分支 · 2', '远程分支 · origin · 1', '远程分支 · upstream · 1']);
  assert.equal(branchItems.find(item => item.branch?.name === 'refs/heads/main').description, '当前分支');
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
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[0].path });
  releaseWorktree({ staged: [], changes: [] });
  await pendingWorktree;
  assert.equal(selectedWorktrees.length, 1, 'a stale badge read cannot reselect a child after focus moves elsewhere');
  const syncSteps = [];
  provider.runCommitPanelPush = async (...args) => syncSteps.push(['sync', ...args]);
  provider.uncommittedFilesWatcher.refreshHeadBranch = async value => syncSteps.push(['head', value]);
  provider.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch = async branch => syncSteps.push(['status', branch.repoOption.path]);
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'syncRefresh', repositoryPath: repositories[1].path });
  assert.deepEqual(syncSteps, [['sync', [repositories[1].path], true, false], ['head', repositories[1].path], ['status', repositories[1].path]], 'sync then refresh uses only the clicked repository');
  await verifyGitlinkNavigation(GitkViewProvider, store);
  await verifyMultiDiffHostSelection(GitkViewProvider, store, repositories);
}
async function verifyMultiDiffHostSelection(Provider, store, repositories) {
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
    },
    uncommittedFilesWatcher: {
      listCurrentHeadBranches: () => branches,
      getUncommittedFilesByHeadBranch: async branch => snapshots.get(branch.repoOption.path),
    },
    findCommit: () => undefined,
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
  await provider.selectGitlinkCommit('render', branches[1].hash);
  assert.equal(store.getState().currentRepositoryPath, repositories[1].path);
  assert.deepEqual(messages.at(-1), { type: 'revealRepositoryChanges', repositoryPath: repositories[1].path });
  assert.equal(provider.gitlinkParentNavigationStack.length, 1);
  await provider.selectGitlinkCommit('gfx', branches[2].hash);
  assert.equal(store.getState().currentRepositoryPath, repositories[2].path);
  assert.equal(provider.gitlinkParentNavigationStack.length, 2);
  await provider.backToParentCommit();
  assert.equal(store.getState().currentRepositoryPath, repositories[1].path);
  assert.equal(reveals.at(-1).path, 'unstaged:gfx');
  assert.deepEqual(messages.at(-1), { type: 'revealRepositoryChanges', repositoryPath: repositories[1].path });
  await provider.backToParentCommit();
  assert.equal(store.getState().currentRepositoryPath, repositories[0].path);
  assert.equal(reveals.at(-1).path, 'unstaged:render');
  assert.equal(provider.gitlinkParentNavigationStack.length, 0);
  assert.deepEqual(selections, [repositories[1].path, repositories[2].path, repositories[1].path, repositories[0].path]);
  assert.equal(listeners.size, 0, 'repository selection subscriptions are cleaned up');
  // A newer manual focus supersedes a slow navigation, without selecting its stale target.
  let release;
  provider.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch = () => new Promise(resolve => { release = resolve; });
  const pending = provider.selectGitlinkCommit('render', branches[1].hash);
  await new Promise(resolve => setImmediate(resolve));
  Object.defineProperty(provider, 'repositories', { value: repositories });
  await provider.handleRepositoryChangesIntent({ type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositories[2].path });
  release(snapshots.get(repositories[1].path));
  const count = messages.length;
  await pending;
  assert.equal(messages.length, count, 'cancelled navigation cannot reveal the stale repository');
  assert.equal(provider.gitlinkParentNavigationStack.length, 0, 'cancelled navigation cannot add a Back entry');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
