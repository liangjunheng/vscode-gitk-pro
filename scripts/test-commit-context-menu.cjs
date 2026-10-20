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
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return {}; }, setState() {} });
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
      node.innerHTML = '<div class="commit-row" data-hash="abc" data-repository-path="repo">commit</div><div class="commit-row working-tree">working tree</div><div class="commit-row">invalid</div>';
    });
    const rows = page.locator('#commitList .commit-row');
    await rows.first().click({ button: 'right', position: { x: 350, y: 10 } });
    assert.equal(await commitMenu.isVisible(), true);
    assert.deepEqual(await commitMenu.locator('button').first().evaluate(node => [getComputedStyle(node).fontFamily, getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]), ['Arial', '15px', '400']);
    await input.evaluate(node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    assert.equal(await commitMenu.isVisible(), false);
    assert.equal(await editMenu.isVisible(), true);
    await rows.first().evaluate(node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    assert.equal(await editMenu.isVisible(), false);
    assert.equal(await commitMenu.isVisible(), true);
    for (const target of [rows.nth(1), rows.nth(2), page.locator('#commitHeader'), page.locator('#commitList')]) {
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
