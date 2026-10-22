const assert = require('node:assert/strict');
const Module = require('node:module');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// Repository-card changed-file multi-selection: click / Ctrl / Shift selection, batch row and group actions,
// and a context menu that acts on the whole selection (worktree and normal-commit cards, webview and host).
async function main() {
  await verifyProvider();
  if (process.argv.includes('--provider-only')) { console.log('Repository card multi-select provider checks passed'); return; }
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const html = renderGitkWebviewHtml('codicon.css', 'https://gitk.test/seti.woff', {}).replace('<link rel="stylesheet" href="codicon.css">', '');
    await verifyWorktreeCard(browser, html);
    await verifyCommitCard(browser, html);
    await verifyTreeMode(browser, html);
    await verifyConflictMenu(browser, html);
  } finally { await browser.close(); }
  console.log('Repository card multi-select checks passed');
}

async function open(browser, html, state) {
  const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // setContent does not run addInitScript, so install the VS Code API shim on the blank page first, as the other repository card tests do.
  await page.evaluate(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
  });
  await page.setContent(html);
  const publish = () => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } })), state);
  await publish();
  return { page, publish, errors };
}
const last = page => page.evaluate(() => window.messages.at(-1));
const count = page => page.evaluate(() => window.messages.length);
const selectedNames = (card, section) => card.locator('.repo-group[data-section="' + section + '"] .repo-file-row.multi-selected .repo-file-name').allTextContents();

async function verifyWorktreeCard(browser, html) {
  const repositoryPath = 'file:///fixture/multi';
  const unstaged = ['a.cpp', 'b.cpp', 'c.cpp', 'd.cpp', 'e.cpp'].map(path => ({ path, status: 'M' }));
  unstaged[1] = { path: 'b.cpp', status: 'D' };
  unstaged[2] = { path: 'c.cpp', status: 'M', isUntracked: true };
  const staged = ['s1.cpp', 's2.cpp'].map(path => ({ path, status: 'M' }));
  const repository = { repositoryPath, repositoryLabel: 'multi', isMainRepository: true, message: '', staged, unstaged };
  const state = { repositoryChanges: [repository], commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [repositoryPath],
    files: [], filesLoading: false, filesMode: 'flat', selectedCommit: { hash: 'uncommitted', repositoryPath }, filesIdentity: { hash: 'uncommitted', repositoryPath } };
  const { page, publish, errors } = await open(browser, html, state);
  try {
    const card = page.locator('.repo-changes').first();
    await card.locator('.repo-changes-label').click(); await publish();
    const row = (section, name) => card.locator('.repo-group[data-section="' + section + '"] .repo-file-row').filter({ hasText: name });
    const file = (section, name) => row(section, name).locator('.repo-file');

    // Plain click selects one file; Ctrl toggles; Shift selects the range from the last clicked file.
    await file('unstaged', 'a.cpp').click();
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp'], 'a plain click selects exactly that file');
    assert.equal((await last(page)).type, 'repositoryChangesFile', 'a plain click still opens the file diff');
    await file('unstaged', 'c.cpp').click({ modifiers: ['Control'] });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'c.cpp'], 'Ctrl+click adds a file without dropping the selection');
    await file('unstaged', 'e.cpp').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['c.cpp', 'd.cpp', 'e.cpp'], 'Shift+click selects the range from the last clicked file');
    await file('unstaged', 'a.cpp').click({ modifiers: ['Control', 'Shift'] });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'b.cpp', 'c.cpp', 'd.cpp', 'e.cpp'], 'Ctrl+Shift extends the selection with the range');
    await file('unstaged', 'b.cpp').click({ modifiers: ['Control'] });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'c.cpp', 'd.cpp', 'e.cpp'], 'Ctrl+click on a selected file removes it');
    await file('unstaged', 'a.cpp').click();
    await file('unstaged', 'c.cpp').click({ modifiers: ['Control'] });

    // File buttons act on the whole selection when the row belongs to it, otherwise on that row alone.
    await row('unstaged', 'c.cpp').locator('[data-repo-action="stage"]').click();
    let message = await last(page);
    assert.equal(message.type, 'repositoryChangesAction'); assert.equal(message.action, 'stage'); assert.equal(message.section, 'unstaged');
    assert.deepEqual(message.paths, ['a.cpp', 'c.cpp'], 'a row button on a selected file stages the whole selection');
    await row('unstaged', 'd.cpp').locator('[data-repo-action="stage"]').click();
    assert.deepEqual((await last(page)).paths, ['d.cpp'], 'a row button on an unselected file acts on that file only');
    await row('unstaged', 'c.cpp').locator('[data-repo-action="discard"]').click();
    assert.deepEqual((await last(page)).paths, ['a.cpp', 'c.cpp'], 'discard also covers the whole selection');
    const group = card.locator('.repo-group[data-section="unstaged"] .repo-group-header');
    await group.locator('[data-repo-action="stage"]').click();
    assert.deepEqual((await last(page)).paths, ['a.cpp', 'b.cpp', 'c.cpp', 'd.cpp', 'e.cpp'], 'a group button always acts on the whole group');

    // The context menu targets the selection when the clicked file is part of it.
    const menu = page.locator('#repositoryFileContextMenu');
    const before = await count(page);
    await row('unstaged', 'c.cpp').click({ button: 'right' });
    assert.equal(await count(page), before, 'right-clicking does not change the real selection');
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'c.cpp'], 'right-clicking a selected file keeps the multi-selection');
    for (const action of ['copy', 'revealInOS', 'revealInExplorer']) {
      assert.equal(await menu.locator('[data-file-action="' + action + '"]').isDisabled(), true, action + ' addresses one resource, so it is disabled for several files');
    }
    for (const action of ['openFile', 'openBefore', 'openAfter', 'copyPath', 'copyRelativePath']) {
      assert.equal(await menu.locator('[data-file-action="' + action + '"]').isDisabled(), false, action + ' supports several files');
    }
    await menu.locator('[data-file-action="copyRelativePath"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesFileAction', action: 'copyRelativePath', repositoryPath, section: 'unstaged', path: 'c.cpp', paths: ['a.cpp', 'c.cpp'] });
    // An unselected file targets itself and leaves the selection alone.
    await row('unstaged', 'd.cpp').click({ button: 'right' });
    assert.equal(await menu.locator('[data-file-action="copy"]').isDisabled(), false, 'a single file keeps the single-file items enabled');
    await menu.locator('[data-file-action="copyPath"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesFileAction', action: 'copyPath', repositoryPath, section: 'unstaged', path: 'd.cpp' });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'c.cpp'], 'acting on an unselected file keeps the selection');

    // Group actions sit above the open items; they follow the clicked file's group and cover the whole selection.
    const openItems = ['打开文件', '打开文件 (修改前)', '打开文件 (修改后)', '通过文件管理器显示', '通过资源管理器视图显示', '复制文件', '复制文件路径', '复制文件相对路径'];
    await row('unstaged', 'c.cpp').click({ button: 'right' });
    assert.deepEqual(await menu.locator('button:visible').allTextContents(), ['暂存', '还原', ...openItems], 'an unstaged file offers stage and discard above the open items');
    assert.equal(await menu.evaluate(node => node.children[2].classList.contains('context-menu-separator')), true, 'a separator divides the group actions from the open items');
    await menu.locator('[data-file-change-action="stage"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesAction', repositoryPath, action: 'stage', section: 'unstaged', paths: ['a.cpp', 'c.cpp'], untrackedPaths: ['c.cpp'] }, 'stage covers the whole selection');
    assert.equal(await menu.isVisible(), false, 'choosing a group action closes the menu');
    await row('unstaged', 'c.cpp').click({ button: 'right' });
    await menu.locator('[data-file-change-action="discard"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesAction', repositoryPath, action: 'discard', section: 'unstaged', paths: ['a.cpp', 'c.cpp'], untrackedPaths: ['c.cpp'] }, 'discard covers the whole selection');
    await row('unstaged', 'd.cpp').click({ button: 'right' });
    await menu.locator('[data-file-change-action="stage"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesAction', repositoryPath, action: 'stage', section: 'unstaged', paths: ['d.cpp'], untrackedPaths: [] }, 'an unselected file is staged alone');
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'c.cpp'], 'a group action on an unselected file keeps the selection');
    // Re-opening the menu on another group never keeps the previous group's items.
    await row('staged', 's1.cpp').click({ button: 'right' });
    assert.deepEqual(await menu.locator('button:visible').allTextContents(), ['取消暂存', ...openItems], 'a staged file offers unstage only');
    assert.equal(await menu.locator('[data-file-change-item]').count(), 2, 'old group actions are replaced, not stacked');
    await menu.locator('[data-file-change-action="unstage"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesAction', repositoryPath, action: 'unstage', section: 'staged', paths: ['s1.cpp'], untrackedPaths: [] });
    // Only deleted files selected: nothing to open from disk.
    await file('unstaged', 'b.cpp').click();
    await row('unstaged', 'b.cpp').click({ button: 'right' });
    assert.equal(await menu.locator('[data-file-action="openFile"]').isDisabled(), true, 'a deleted file has no file on disk to open');
    await page.keyboard.press('Escape');

    // Selection is per group: a plain click in another group replaces it, and Shift never spans groups.
    await file('unstaged', 'a.cpp').click();
    await file('staged', 's1.cpp').click({ modifiers: ['Control'] });
    await file('staged', 's2.cpp').click({ modifiers: ['Control', 'Shift'] });
    assert.deepEqual(await selectedNames(card, 'staged'), ['s1.cpp', 's2.cpp']);
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp'], 'Ctrl keeps the other group selected');
    await row('staged', 's2.cpp').locator('[data-repo-action="unstage"]').click();
    message = await last(page);
    assert.deepEqual([message.section, message.paths], ['staged', ['s1.cpp', 's2.cpp']], 'a staged row button covers the staged selection only');
    await row('staged', 's2.cpp').click({ button: 'right' });
    await menu.locator('[data-file-change-action="unstage"]').click();
    message = await last(page);
    assert.deepEqual([message.type, message.action, message.section, message.paths], ['repositoryChangesAction', 'unstage', 'staged', ['s1.cpp', 's2.cpp']], 'unstage from the menu covers the staged selection');
    await file('staged', 's1.cpp').click();
    assert.deepEqual(await selectedNames(card, 'unstaged'), [], 'a plain click replaces the selection of the other group');

    // Files that leave their group drop out of the selection.
    await file('unstaged', 'a.cpp').click(); await file('unstaged', 'c.cpp').click({ modifiers: ['Control'] });
    repository.unstaged = repository.unstaged.filter(item => item.path !== 'a.cpp'); await publish();
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['c.cpp'], 'a file that left the group is no longer selected');
    await row('unstaged', 'c.cpp').locator('[data-repo-action="stage"]').click();
    assert.deepEqual((await last(page)).paths, ['c.cpp'], 'stale selected files are never sent');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await page.close(); }
}

async function verifyCommitCard(browser, html) {
  const repositoryPath = 'file:///fixture/history';
  const files = [{ path: 'h1.cpp', status: 'M' }, { path: 'h2.cpp', status: 'A' }, { path: 'h3.cpp', status: 'M' }];
  const repository = { repositoryPath, repositoryLabel: 'history', isMainRepository: true, message: '', staged: [], unstaged: [] };
  const state = { repositoryChanges: [repository], commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [repositoryPath],
    files, filesLoading: false, filesMode: 'flat', selectedCommit: { hash: '12345678', repositoryPath, message: 'history' }, filesIdentity: { hash: '12345678', repositoryPath } };
  const { page, publish, errors } = await open(browser, html, state);
  try {
    const card = page.locator('.repo-changes').first();
    await card.locator('.repo-changes-label').click(); await publish();
    const row = name => card.locator('.repo-group[data-section="commit"] .repo-file-row').filter({ hasText: name });
    await row('h1.cpp').locator('.repo-file').click();
    await row('h3.cpp').locator('.repo-file').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selectedNames(card, 'commit'), ['h1.cpp', 'h2.cpp', 'h3.cpp'], 'Shift selects a range of normal-commit files');
    const menu = page.locator('#repositoryFileContextMenu');
    await row('h2.cpp').click({ button: 'right' });
    // h2 was added by the commit, h1 and h3 were modified: "before" is available as soon as one file has it.
    assert.equal(await menu.locator('[data-file-action="openBefore"]').isDisabled(), false, 'before is enabled when any selected file has one');
    assert.equal(await menu.locator('[data-file-action="copy"]').isDisabled(), true, 'single-resource items are disabled for several files');
    await menu.locator('[data-file-action="openAfter"]').click();
    assert.deepEqual(await last(page), { type: 'commitFileAction', action: 'openAfter', hash: '12345678', repositoryPath, path: 'h2.cpp', paths: ['h1.cpp', 'h2.cpp', 'h3.cpp'] });
    assert.equal(await menu.locator('[data-file-change-action]').count(), 0, 'a normal commit file has no stage, unstage or discard');
    await row('h1.cpp').locator('.repo-file').click();
    await row('h1.cpp').click({ button: 'right' });
    await menu.locator('[data-file-action="copyRelativePath"]').click();
    assert.deepEqual(await last(page), { type: 'commitFileAction', action: 'copyRelativePath', hash: '12345678', repositoryPath, path: 'h1.cpp' }, 'one selected file posts the single-file message');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await page.close(); }
}

async function verifyConflictMenu(browser, html) {
  const repositoryPath = 'file:///fixture/conflict';
  const unstaged = [{ path: 'x.cpp', status: 'U', isConflict: true }, { path: 'y.cpp', status: 'U', isConflict: true }, { path: 'z.cpp', status: 'M' }];
  const repository = { repositoryPath, repositoryLabel: 'conflict', isMainRepository: true, message: '', staged: [], unstaged };
  const state = { repositoryChanges: [repository], commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [repositoryPath],
    files: [], filesLoading: false, filesMode: 'flat', selectedCommit: { hash: 'uncommitted', repositoryPath }, filesIdentity: { hash: 'uncommitted', repositoryPath } };
  const { page, publish, errors } = await open(browser, html, state);
  try {
    const card = page.locator('.repo-changes').first();
    await card.locator('.repo-changes-label').click(); await publish();
    const menu = page.locator('#repositoryFileContextMenu');
    const conflictRow = name => card.locator('.repo-group[data-section="conflict"] .repo-file-row').filter({ hasText: name });
    await conflictRow('x.cpp').locator('.repo-file').click();
    await conflictRow('y.cpp').locator('.repo-file').click({ modifiers: ['Shift'] });
    await conflictRow('y.cpp').click({ button: 'right' });
    assert.deepEqual(await menu.locator('[data-file-change-action]').evaluateAll(nodes => nodes.map(node => node.dataset.fileChangeAction)), ['stage'], 'a merge conflict can only be staged, which marks it resolved');
    await menu.locator('[data-file-change-action="stage"]').click();
    const message = await last(page);
    assert.deepEqual([message.type, message.action, message.section, message.paths], ['repositoryChangesAction', 'stage', 'conflict', ['x.cpp', 'y.cpp']], 'staging covers every selected conflict');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await page.close(); }
}

async function verifyTreeMode(browser, html) {
  const repositoryPath = 'file:///fixture/tree';
  const unstaged = ['src/a.cpp', 'src/b.cpp', 'lib/c.cpp', 'lib/d.cpp', 'top.cpp'].map(path => ({ path, status: 'M' }));
  const repository = { repositoryPath, repositoryLabel: 'tree', isMainRepository: true, message: '', staged: [], unstaged };
  const state = { repositoryChanges: [repository], commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [repositoryPath],
    files: [], filesLoading: false, filesMode: 'tree', selectedCommit: { hash: 'uncommitted', repositoryPath }, filesIdentity: { hash: 'uncommitted', repositoryPath } };
  const { page, publish, errors } = await open(browser, html, state);
  try {
    const card = page.locator('.repo-changes').first();
    await card.locator('.repo-changes-label').click(); await publish();
    const row = name => card.locator('.repo-group[data-section="unstaged"] .repo-file-row').filter({ hasText: name });
    const file = name => row(name).locator('.repo-file');
    // A Shift range follows the rows as the tree shows them, across folder boundaries.
    await file('a.cpp').click();
    await file('d.cpp').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'b.cpp', 'c.cpp', 'd.cpp'], 'Shift selects across folders in tree order');
    // Rows inside a collapsed folder are not part of a new range.
    await card.locator('.repo-group[data-section="unstaged"] .repo-folder').filter({ hasText: 'lib' }).locator('.repo-folder-toggle').click();
    await file('a.cpp').click();
    await file('top.cpp').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selectedNames(card, 'unstaged'), ['a.cpp', 'b.cpp', 'top.cpp'], 'a collapsed folder\'s files stay out of the range');
    await row('top.cpp').locator('[data-repo-action="stage"]').click();
    assert.deepEqual((await last(page)).paths, ['src/a.cpp', 'src/b.cpp', 'top.cpp'], 'tree rows send their full repository paths');
    await row('top.cpp').click({ button: 'right' });
    await page.locator('#repositoryFileContextMenu [data-file-action="copyRelativePath"]').click();
    assert.deepEqual(await last(page), { type: 'repositoryChangesFileAction', action: 'copyRelativePath', repositoryPath, section: 'unstaged', path: 'top.cpp', paths: ['src/a.cpp', 'src/b.cpp', 'top.cpp'] });
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await page.close(); }
}

async function verifyProvider() {
  const load = Module._load;
  const clipboard = [], commands = [], opened = [], warnings = [];
  const vscode = {
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } }, ViewColumn: { Active: 1 }, ProgressLocation: { Notification: 1 }, QuickPickItemKind: { Separator: -1 },
    Uri: {
      parse: value => ({ toString: () => value, fsPath: value.replace(/^file:\/\//, ''), with(change) { return { ...this, ...change }; } }),
      joinPath: (root, ...segments) => ({ fsPath: root.fsPath.replace(/\/$/, '') + '/' + segments.join('/'), toString: () => root.toString() + '/' + segments.join('/'), with(change) { return { ...this, ...change }; } }),
    },
    env: { clipboard: { writeText: async value => { clipboard.push(value); } } },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
    workspace: { openTextDocument: async uri => { opened.push(uri.fsPath); return { uri }; } },
    window: { showErrorMessage(message) { warnings.push(message); }, showWarningMessage(message) { warnings.push(message); }, showTextDocument: async () => {}, withProgress: async (_options, task) => task({ report() {} }) },
  };
  let GitkViewProvider, store;
  try {
    Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
    ({ GitkViewProvider } = require('../out/webview/gitkViewProvider'));
    ({ store } = require('../out/state/store'));
  } finally { Module._load = load; }
  const repo = { path: 'file:///fixture/repo', label: 'repo' };
  const provider = Object.create(GitkViewProvider.prototype);
  Object.defineProperty(provider, 'repositories', { value: [repo] });
  provider.uncommittedFilesWatcher = {
    listCurrentHeadBranches: () => [{ repoOption: repo, name: 'refs/heads/main', kind: 'current' }],
    getUncommittedFilesByHeadBranch: async () => ({
      staged: [{ path: 's.cpp', status: 'M' }],
      changes: [{ path: 'a.cpp', status: 'M' }, { path: 'gone.cpp', status: 'D' }, { path: 'new.cpp', status: 'A' }, { path: 'u.cpp', status: '?', isUntracked: true }],
    }),
  };
  const reset = () => { clipboard.length = 0; commands.length = 0; opened.length = 0; warnings.length = 0; };
  const act = (action, path, paths, section = 'unstaged') => provider.handleRepositoryChangesIntent({ type: 'repositoryChangesFileAction', action, repositoryPath: repo.path, section, path, ...(paths ? { paths } : {}) });

  await act('copyRelativePath', 'a.cpp', ['a.cpp', 'gone.cpp']);
  assert.deepEqual(clipboard, ['a.cpp\ngone.cpp'], 'relative paths of the whole selection are copied, one per line');
  reset(); await act('copyPath', 'a.cpp', ['a.cpp', 'u.cpp']);
  assert.deepEqual(clipboard, ['/fixture/repo/a.cpp\n/fixture/repo/u.cpp'], 'absolute paths of the whole selection are copied, one per line');
  reset(); await act('copyRelativePath', 'a.cpp');
  assert.deepEqual(clipboard, ['a.cpp'], 'without a selection the clicked file is used, as before');
  reset(); await act('openFile', 'a.cpp', ['a.cpp', 'gone.cpp', 'u.cpp']);
  assert.deepEqual(opened, ['/fixture/repo/a.cpp', '/fixture/repo/u.cpp'], 'Open File opens every selected file that exists, skipping deleted ones');
  reset(); await act('openBefore', 'a.cpp', ['a.cpp', 'new.cpp', 'u.cpp', 'gone.cpp']);
  assert.deepEqual(commands.map(([command, uri]) => [command, JSON.parse(uri.query).path]), [['vscode.open', '/fixture/repo/a.cpp'], ['vscode.open', '/fixture/repo/gone.cpp']],
    'Open Before skips added and untracked files, which have no earlier version');
  reset(); await act('openAfter', 's.cpp', ['s.cpp'], 'staged');
  assert.equal(JSON.parse(commands[0][1].query).ref, '', 'a staged file still opens its index version');
  reset(); await act('copyRelativePath', 'a.cpp', ['a.cpp', 'missing.cpp']);
  assert.deepEqual(clipboard, ['a.cpp'], 'files that are no longer changed are dropped from the selection');
  reset(); await act('copyRelativePath', 'missing.cpp', ['missing.cpp']);
  assert.deepEqual([clipboard, warnings.length], [[], 1], 'a selection that no longer matches anything only warns');
  reset(); await act('copyRelativePath', 'a.cpp', ['b.cpp']);
  await act('copyRelativePath', 'a.cpp', ['a.cpp', '../outside.cpp']);
  await act('copyRelativePath', 'a.cpp', ['a.cpp', '/abs.cpp']);
  await act('copyRelativePath', 'a.cpp', ['a.cpp', 7]);
  assert.deepEqual([clipboard, commands, opened], [[], [], []], 'selections that omit the clicked file or hold unsafe paths are rejected');
  reset(); await act('copy', 'a.cpp', ['a.cpp', 'gone.cpp']);
  assert.deepEqual(commands.map(([command, uri]) => [command, uri.fsPath]), [['filesExplorer.copy', '/fixture/repo/a.cpp']], 'single-resource actions use the clicked file');
  reset(); await act('revealInOS', 'gone.cpp', ['a.cpp', 'gone.cpp']);
  assert.deepEqual(commands, [], 'a deleted clicked file is not revealed');

  // Normal commit: the same actions on the files of the selected commit, in the commit list order.
  store.setState({ currentHash: 'c0ffee', currentRepositoryPath: repo.path, files: [{ path: 'h1.cpp', status: 'M' }, { path: 'h2.cpp', status: 'D' }, { path: 'h3.cpp', status: 'A' }] });
  const commitAct = (action, path, paths, hash = 'c0ffee') => provider.handleCommitFileAction({ type: 'commitFileAction', action, hash, repositoryPath: repo.path, path, ...(paths ? { paths } : {}) });
  reset(); await commitAct('copyRelativePath', 'h3.cpp', ['h3.cpp', 'h1.cpp']);
  assert.deepEqual(clipboard, ['h1.cpp\nh3.cpp'], 'commit files are copied in list order');
  reset(); await commitAct('openFile', 'h1.cpp', ['h1.cpp', 'h2.cpp', 'h3.cpp']);
  assert.deepEqual(opened, ['/fixture/repo/h1.cpp', '/fixture/repo/h3.cpp'], 'deleted commit files are skipped by Open File');
  reset(); await commitAct('copyPath', 'h1.cpp', ['h1.cpp', 'missing.cpp']);
  assert.deepEqual(clipboard, ['/fixture/repo/h1.cpp'], 'files that are not in the commit are dropped');
  reset(); await commitAct('copyPath', 'h1.cpp', ['h1.cpp'], 'other-commit');
  assert.deepEqual([clipboard, warnings.length], [[], 1], 'a stale commit identity is rejected');
  reset(); await commitAct('copyPath', 'h1.cpp', ['h2.cpp']);
  assert.deepEqual(clipboard, [], 'a selection that omits the clicked file is rejected');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
