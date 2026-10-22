const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage(message) { window.messages.push(message); }, getState() { return {}; }, setState() {} });
    });
    const html = renderGitkWebviewHtml('', '', {}).replace('</head>', '<style>:root{--vscode-font-family:Arial;--vscode-font-size:15px}</style></head>');
    await page.setContent(html);
    const input = page.locator('#searchInput');
    const editMenu = page.locator('#repositoryMessageContextMenu');
    const commitMenu = page.locator('#commitContextMenu');
    await input.fill('search text');
    await input.click({ button: 'right' });
    await editMenu.locator('[data-repository-message-action="selectAll"]').click();
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 11]);
    await page.locator('#commitList').evaluate(node => {
      node.innerHTML = '<div class="commit-row" data-hash="abc" data-repository-path="repo" data-local-tags="[&quot;v1&quot;]">tagged commit</div>'
        + '<div class="commit-row" data-hash="def" data-repository-path="repo" data-local-tags="[]">untagged commit</div>'
        + '<div class="commit-row working-tree">working tree</div><div class="commit-row">invalid</div>';
    });
    const rows = page.locator('#commitList .commit-row');
    assert.equal(await rows.first().evaluate(row => getComputedStyle(row).userSelect), 'none', 'collapsed rows do not allow text selection');
    await rows.first().evaluate(row => row.classList.add('expanded'));
    assert.equal(await rows.first().evaluate(row => getComputedStyle(row).userSelect), 'text', 'expanded rows allow text selection');
    await rows.first().evaluate(row => row.classList.remove('expanded'));

    await rows.first().click({ button: 'right', position: { x: 350, y: 10 } });
    assert.equal(await commitMenu.isVisible(), true);
    assert.deepEqual(await commitMenu.locator('button').first().evaluate(node => [getComputedStyle(node).fontFamily, getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]), ['Arial', '15px', '400']);
    assert.deepEqual(await commitMenu.locator('.tag-action span').allTextContents(), ['create tag', 'delete tag', 'delete remote tag（查询中…）', 'push tag（查询中…）']);
    assert.equal(await commitMenu.locator('[data-commit-action="createTag"]').evaluate(button => button.previousElementSibling.classList.contains('tag-actions-separator')), true, 'tag operations start after their own separator');
    assert.equal(await commitMenu.locator('[data-commit-action="deleteTag"]').isDisabled(), false, 'local-tag delete is enabled from commit refs');
    assert.equal(await commitMenu.locator('[data-commit-action="deleteRemoteTag"]').isDisabled(), true);
    assert.equal(await commitMenu.locator('[data-commit-action="pushTag"]').isDisabled(), true);
    assert.equal(await commitMenu.locator('[data-commit-action="deleteRemoteTag"] span').textContent(), 'delete remote tag（查询中…）');
    assert.equal(await commitMenu.locator('[data-commit-action="pushTag"] span').textContent(), 'push tag（查询中…）');
    const firstRequest = await page.evaluate(() => window.messages.filter(message => message.type === 'requestCommitTagState').at(-1));
    assert.deepEqual({ hash: firstRequest.hash, repositoryPath: firstRequest.repositoryPath }, { hash: 'abc', repositoryPath: 'repo' });
    await page.evaluate(request => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'commitTagState', requestId: request.requestId, hash: request.hash, repositoryPath: request.repositoryPath,
      localTagCount: 1, remoteTagCount: 0, pushableTagCount: 1, remoteError: '',
    } })), firstRequest);
    assert.equal(await commitMenu.locator('[data-commit-action="deleteTag"]').isDisabled(), false);
    assert.equal(await commitMenu.locator('[data-commit-action="deleteRemoteTag"]').isDisabled(), true, 'no remote tag keeps delete remote disabled');
    assert.equal(await commitMenu.locator('[data-commit-action="pushTag"]').isDisabled(), false, 'an unpushed local tag enables push tag');
    assert.equal(await commitMenu.locator('[data-commit-action="deleteRemoteTag"] span').textContent(), 'delete remote tag');
    assert.equal(await commitMenu.locator('[data-commit-action="pushTag"] span').textContent(), 'push tag');
    await commitMenu.locator('[data-commit-action="pushTag"]').click();
    assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'commitAction').at(-1)),
      { type: 'commitAction', action: 'pushTag', hash: 'abc', repositoryPath: 'repo' });

    await rows.nth(1).click({ button: 'right' });
    assert.equal(await commitMenu.locator('[data-commit-action="deleteTag"]').isDisabled(), true, 'no local tag disables delete tag');
    const secondRequest = await page.evaluate(() => window.messages.filter(message => message.type === 'requestCommitTagState').at(-1));
    await page.evaluate(request => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'commitTagState', requestId: request.requestId, hash: request.hash, repositoryPath: request.repositoryPath,
      localTagCount: 0, remoteTagCount: 1, pushableTagCount: 0, remoteError: '',
    } })), secondRequest);
    assert.equal(await commitMenu.locator('[data-commit-action="deleteTag"]').isDisabled(), true);
    assert.equal(await commitMenu.locator('[data-commit-action="deleteRemoteTag"]').isDisabled(), false, 'a remote tag enables delete remote tag');
    assert.equal(await commitMenu.locator('[data-commit-action="pushTag"]').isDisabled(), true, 'no pushable tag disables push tag');

    await input.evaluate(node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    assert.equal(await commitMenu.isVisible(), false);
    assert.equal(await editMenu.isVisible(), true);
    await rows.first().evaluate(node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    assert.equal(await editMenu.isVisible(), false);
    assert.equal(await commitMenu.isVisible(), true);
    for (const target of [rows.nth(2), rows.nth(3), page.locator('#commitHeader'), page.locator('#commitList')]) {
      const suppressed = await target.evaluate(node => !node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      assert.equal(suppressed, true);
      assert.equal(await commitMenu.isVisible(), false);
      await rows.first().click({ button: 'right', position: { x: 350, y: 10 } });
    }
    await page.keyboard.press('Escape');
    assert.equal(await commitMenu.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Commit context menu checks passed');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
