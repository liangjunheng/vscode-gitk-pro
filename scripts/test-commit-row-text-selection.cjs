// 提交行: 只有展开时可选中文字; 展开后标题/描述完整换行显示; 拖选或双击选词抬手不会收起。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
      contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const css = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8').replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#929292;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    const html = renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + css + '</style>');
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: m => window.messages.push(m), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);
    const repo = { path: 'file:///r/a', label: 'repo-a' };
    const h = ch => ch.repeat(40);
    const title = 'This is a very long commit title that definitely cannot fit on a single line in a narrow commit list panel';
    const body = 'Body line one is also long enough to wrap around inside the narrow panel without being truncated at all.\nSecond body line.';
    const branch = { repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash: h('a') };
    const commit = { hash: h('a'), shortHash: 'aaaaaaaa', key: repo.path + ':' + h('a'), parents: [], refs: [], message: title, rawMessage: title + '\n\n' + body, body, author: 'me', authorEmail: 'me@example.com', authorDate: '2026-10-21T10:00:00+08:00', authorDateLabel: 'today', gitBranchOption: branch };
    const state = { repositoryChanges: [], branches: [branch], selectedBranches: ['refs/heads/main'], selectedRepositoryPaths: [repo.path], commits: [commit], workingTreeRows: [], cloudGroups: [], files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat', selectedCommit: null, isLoading: false, hasMoreCommits: false };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    await publish();
    const row = page.locator('#commitVirtualRows .commit-row[data-hash]').first();
    const titleEl = row.locator('.commit-message-text');
    const rowState = () => row.evaluate(n => ({ expanded: n.classList.contains('expanded'), selected: n.classList.contains('selected') }));

    // collapsed: not selectable, single-line ellipsis
    const collapsed = await titleEl.evaluate(n => { const s = getComputedStyle(n); return { us: getComputedStyle(n.closest('.commit-row')).userSelect, ws: s.whiteSpace, h: n.getBoundingClientRect().height }; });
    assert.equal(collapsed.us, 'none', 'collapsed row must not allow text selection');
    assert.equal(collapsed.ws, 'nowrap');

    // first click selects, echo selection, second click expands
    await titleEl.click();
    state.selectedCommit = { key: repo.path + ':' + h('a'), hash: h('a'), repositoryPath: repo.path, kind: 'commit' };
    await publish();
    await titleEl.click();
    assert.equal((await rowState()).expanded, true, 'second click expands');

    const expanded = await row.evaluate(n => {
      const t = n.querySelector('.commit-message-text'); const d = n.querySelector('.commit-description-body');
      const line = parseFloat(getComputedStyle(t).lineHeight);
      return { us: getComputedStyle(n).userSelect, ws: getComputedStyle(t).whiteSpace, titleH: t.getBoundingClientRect().height, line,
        titleScroll: t.scrollWidth <= t.clientWidth + 1, bodyWs: getComputedStyle(d).whiteSpace, bodyFits: d.scrollWidth <= d.clientWidth + 1, rowH: n.getBoundingClientRect().height };
    });

    assert.equal(expanded.us, 'text', 'expanded row allows text selection');
    assert.ok(expanded.titleH > expanded.line * 1.5, 'expanded title wraps onto several lines');
    assert.ok(expanded.titleScroll, 'expanded title is not clipped horizontally');
    assert.ok(expanded.bodyFits, 'body wraps without horizontal overflow');
    const fullTitle = (await titleEl.textContent());
    assert.equal(fullTitle, title, 'full title is rendered');

    // drag select inside the title, release: must stay expanded
    const box = await titleEl.boundingBox();
    await page.mouse.move(box.x + 4, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 20, box.y + 8, { steps: 8 });
    await page.mouse.up();
    const selected = await page.evaluate(() => String(getSelection()));
    assert.ok(selected.length > 5, 'drag produced a text selection: ' + JSON.stringify(selected));
    assert.equal((await rowState()).expanded, true, 'releasing a drag selection must not collapse the row');
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.type === 'selectCommit').length), 1, 'only the first plain click posts selectCommit; drag selection posts nothing');

    // drag select in the body
    const bodyBox = await row.locator('.commit-description-body').boundingBox();
    await page.mouse.move(bodyBox.x + 2, bodyBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(bodyBox.x + bodyBox.width - 10, bodyBox.y + 8, { steps: 6 });
    await page.mouse.up();
    assert.equal((await rowState()).expanded, true, 'body drag keeps it expanded');

    // plain click (no selection) on title collapses
    await page.mouse.click(box.x + 4, box.y + 8);
    assert.equal((await rowState()).expanded, false, 'plain click on the title still collapses');
    // 从折叠态双击: 第一下展开, 第二下 mousedown 选词后的 click 带选区, 不应再收起。已展开行上的双击不在此覆盖。
    await page.mouse.dblclick(box.x + 30, box.y + 8);
    assert.ok((await page.evaluate(() => String(getSelection()))).trim().length > 0, 'double-click selects a word');
    assert.equal((await rowState()).expanded, true, 'double-click selection keeps the row expanded');
    assert.deepEqual(errors, []);
    console.log('Commit row text selection passed: collapsed rows are not selectable, expanded rows wrap title and body, drag selection keeps the row expanded, double-click from collapsed selects a word, plain click still collapses.');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
