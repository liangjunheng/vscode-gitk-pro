const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// Stash UI: 选择器栏最右侧的开关（默认选中）、穿插在提交之间的 stash 行（空心菱形节点、不独立成组）、三处分组头的 stash 按钮。
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
      contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const css = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8')
      .replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-icon-foreground:#aeb4bc;--vscode-descriptionForeground:#929292;--vscode-editorGroup-border:#343434;--vscode-widget-border:#343434;--vscode-panel-border:#303030;--vscode-input-background:#1f1f1f;--vscode-input-foreground:#cccccc;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    const html = renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + css + '</style>');
    const measureStart = html.indexOf('function measureExpandedCommitRows()');
    const measureEnd = html.indexOf('function renderCommitVirtualWindow', measureStart);
    const measureSource = html.slice(measureStart, measureEnd);
    assert.ok(measureStart >= 0 && measureSource.includes('expandedCommitRowHeights.set(key, height);'),
      'measurement still updates the virtual-list height cache');
    assert.equal(measureSource.includes('drawSvg('), false, 'virtual-list height measurement never redraws either real or stash lanes');
    assert.equal(measureSource.includes('new ResizeObserver'), false, 'expanded stash correction does not reintroduce the rejected persistent observer solution');
    for (const match of html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);

    const repoA = { path: 'file:///stash/a', label: 'repo-a' };
    const h = ch => ch.repeat(40);
    const branchOption = (repo, hash) => ({ repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash });
    // 一条线性历史 c3 -> c2 -> c1 -> c0; stash 挂在 c2 上 (宿主已把它穿插成 c2 之上的一行, 单一父提交 = 基线)。
    // stash 不是侧枝: 不开泳道、不占颜色, 落在基线所在列 (lane 0), 输入/输出泳道原样穿过。
    const lane = (hash, color) => ({ hash, color });
    const base = (hash, parent, message, extra) => ({ hash, shortHash: hash.slice(0, 8), key: repoA.path + ':' + hash, parents: parent ? [parent] : [], refs: [], message, rawMessage: message, body: '', author: 'me', authorEmail: 'me@example.com', authorDateLabel: 'today', authorDate: '2026-10-21T10:00:00+08:00', gitBranchOption: branchOption(repoA, hash), ...extra });
    const red = '#e06c75', blue = '#61afef';
    const commits = [
      base(h('3'), h('2'), 'c3 newest', { lane: 0, laneColor: red, inputSwimlanes: [], outputSwimlanes: [lane(h('2'), red)] }),
      // stash 行: 在 c2 之上, 落在 c2 所在列; 泳道状态原样穿过
      base(h('5'), h('2'), 'WIP on main: stash tip', { isStash: true, stashRef: 'stash@{0}', stashIndex: 0, lane: 0, indentDepth: 0,
        inputSwimlanes: [lane(h('2'), red)], outputSwimlanes: [lane(h('2'), red)] }),
      base(h('2'), h('1'), 'c2 base of stash', { lane: 0, laneColor: red,
        inputSwimlanes: [lane(h('2'), red)], outputSwimlanes: [lane(h('1'), red)] }),
      base(h('1'), h('0'), 'c1', { lane: 0, laneColor: red, inputSwimlanes: [lane(h('1'), red)], outputSwimlanes: [lane(h('0'), red)] }),
    ];
    const state = {
      repositoryChanges: [], branches: [branchOption(repoA, h('3'))], selectedBranches: ['refs/heads/main'], selectedRepositoryPaths: [repoA.path],
      commits,
      workingTreeRows: [{ hash: 'uncommitted', label: 'Uncommitted Changes', repositoryPath: repoA.path, headHash: h('3'), enabled: true, stagedCount: 1, changesCount: 1 }],
      cloudGroups: [], showStashes: true, hiddenStashCount: 0, files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat',
      selectedCommit: null, isLoading: false, hasMoreCommits: false,
    };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const lastMessages = type => page.evaluate(wanted => window.messages.filter(m => m.type === wanted), type);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedRepoDisplayChanged', repository: { path: 'file:///stash/a', label: 'repo-a' } } })));
    await publish();

    // 9) Repository Changes 卡片的分组头: stash 按钮在“还原”和“取消暂存”左侧, 并发出 stash 消息
    state.repositoryChanges = [{ repositoryPath: repoA.path, repositoryLabel: repoA.label, isMainRepository: true, headLabel: 'main', message: '', committing: false,
      staged: [{ path: 'a.txt', status: 'M' }], unstaged: [{ path: 'b.txt', status: 'M' }, { path: 'c.txt', status: 'M', isUntracked: true }] }];
    await publish();
    const card = page.locator('.repo-changes').first();
    if (await card.locator('.repo-changes-body').isHidden()) await card.locator('.repo-changes-toggle').click();
    assert.equal(await card.locator('.repo-changes-body').isHidden(), false, 'card is expanded');
    const unstagedHeader = card.locator('.repo-group[data-section="unstaged"] .repo-group-header');
    const stagedHeader = card.locator('.repo-group[data-section="staged"] .repo-group-header');
    assert.deepEqual(await unstagedHeader.locator('.toolbar-icon').evaluateAll(buttons => buttons.map(b => b.dataset.repoAction)), ['stash', 'discard', 'stage'], 'unstaged: stash, then discard, then stage');
    assert.equal(await unstagedHeader.locator('[data-repo-action="stash"]').getAttribute('title'), 'Stash 未暂存的更改');
    assert.deepEqual(await stagedHeader.locator('.toolbar-icon').evaluateAll(buttons => buttons.map(b => b.dataset.repoAction)), ['stash', 'unstage'], 'staged: stash, then unstage');
    await page.evaluate(() => { window.messages.length = 0; });
    await unstagedHeader.locator('[data-repo-action="stash"]').click();
    let sent = (await lastMessages('repositoryChangesAction')).at(-1);
    assert.equal(sent.action, 'stash'); assert.equal(sent.section, 'unstaged'); assert.equal(sent.repositoryPath, repoA.path);
    await stagedHeader.locator('[data-repo-action="stash"]').click();
    sent = (await lastMessages('repositoryChangesAction')).at(-1);
    assert.equal(sent.action, 'stash'); assert.equal(sent.section, 'staged');

    // Staged / Unstaged 文件右键菜单: 工作区动作带图标, 且 Stash 复用当前分组语义。
    const fileMenu = page.locator('#repositoryFileContextMenu');
    const unstagedRow = card.locator('.repo-group[data-section="unstaged"] .repo-file-row').filter({ hasText: 'b.txt' });
    await unstagedRow.click({ button: 'right' });
    assert.deepEqual((await fileMenu.locator('button:visible').allTextContents()).slice(0, 3), ['暂存', '还原', 'Stash 未暂存的更改']);
    assert.equal(await fileMenu.locator('[data-file-change-action="stage"] .codicon').getAttribute('class'), 'codicon codicon-add');
    assert.equal(await fileMenu.locator('[data-file-change-action="discard"] .codicon').getAttribute('class'), 'codicon codicon-discard');
    assert.equal(await fileMenu.locator('[data-file-change-action="stash"] .codicon').getAttribute('class'), 'codicon codicon-inbox');
    await fileMenu.locator('[data-file-change-action="stash"]').click();
    sent = (await lastMessages('repositoryChangesAction')).at(-1);
    assert.deepEqual({ action: sent.action, section: sent.section, paths: sent.paths }, { action: 'stash', section: 'unstaged', paths: ['b.txt'] });

    const stagedRow = card.locator('.repo-group[data-section="staged"] .repo-file-row').filter({ hasText: 'a.txt' });
    await stagedRow.click({ button: 'right' });
    assert.deepEqual((await fileMenu.locator('button:visible').allTextContents()).slice(0, 2), ['取消暂存', 'Stash 已暂存的更改']);
    assert.equal(await fileMenu.locator('[data-file-change-action="unstage"] .codicon').getAttribute('class'), 'codicon codicon-remove');
    assert.equal(await fileMenu.locator('[data-file-change-action="stash"] .codicon').getAttribute('class'), 'codicon codicon-inbox');
    await fileMenu.locator('[data-file-change-action="stash"]').click();
    sent = (await lastMessages('repositoryChangesAction')).at(-1);
    assert.deepEqual({ action: sent.action, section: sent.section, paths: sent.paths }, { action: 'stash', section: 'staged', paths: ['a.txt'] });

    // 有未解决冲突时, 两个分组的 stash 按钮和右键菜单项都必须隐藏。
    state.repositoryChanges[0].unstaged = [
      { path: 'conflict.txt', status: 'U', isConflict: true },
      { path: 'b.txt', status: 'M' },
    ];
    await publish();
    assert.equal(await card.locator('.repo-group[data-section="unstaged"] [data-repo-action="stash"]').count(), 0, 'unstaged stash is hidden while conflicts exist');
    assert.equal(await card.locator('.repo-group[data-section="staged"] [data-repo-action="stash"]').count(), 0, 'staged stash is hidden while conflicts exist');
    await card.locator('.repo-group[data-section="unstaged"] .repo-file-row').filter({ hasText: 'b.txt' }).click({ button: 'right' });
    assert.equal(await fileMenu.locator('[data-file-change-action="stash"]').count(), 0, 'repository file menu hides stash while conflicts exist');

    assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));
    console.log('Repository card stash UI passed: group buttons and staged/unstaged file menus expose the scoped stash action with matching icons.');
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
