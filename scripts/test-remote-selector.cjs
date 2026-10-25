const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        const html = renderGitkWebviewHtml('codicon.css').replace(
            '<script>\n',
            '<script>window.messages=[];window.acquireVsCodeApi=()=>({postMessage(message){window.messages.push(message);},getState:()=>({}),setState(){}});\n',
        );
        await page.setContent(html);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'selectedRepoDisplayChanged',
            repository: { path: 'file:///fixture/repo', label: 'repo', hasSubmodules: false, isSubmodule: false },
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), '加载远程仓库...');
        assert.equal(await page.locator('#remoteSelectorButton').isDisabled(), true, 'an uncached repository starts in loading state');
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [
                { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
            ],
            selectedRemote: 'origin', upstreamRemote: ''
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'origin', 'an empty upstream must not erase a valid selected remote');
        await page.locator('#remoteSelectorButton').click();
        assert.equal(await page.locator('#remoteSelectorMenu').isVisible(), true);
        assert.equal(await page.locator('#remoteSelectorProgress').isVisible(), true, 'opening the remote popup shows its loading progress');
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'requestRemoteList')), [{ type: 'requestRemoteList' }]);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [
                { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
            ],
            selectedRemote: 'origin',
        } })));
        assert.deepEqual(await page.locator('#commitSelectors .selector-row').evaluateAll(nodes =>
            [...nodes[0].children].map(node => node.id || node.className)), ['remoteSelector', 'selector-separator codicon codicon-arrow-both', 'repositorySelector', 'commitSyncActions']);
        assert.equal(await page.locator('.selector-separator.codicon-arrow-both').count(), 1);
        assert.equal(await page.locator('.selector-separator').getAttribute('aria-label'), '双向绑定');
        assert.deepEqual(await page.locator('#commitSyncActions .toolbar-icon').evaluateAll(nodes => nodes.map(node => node.id)), ['fetchBtn', 'pullBtn', 'pushBtn']);
        const syncGeometry = await page.evaluate(() => {
            const row = document.querySelector('#commitSelectors .selector-row').getBoundingClientRect();
            const sync = document.getElementById('commitSyncActions').getBoundingClientRect();
            return { rowRight: row.right, syncRight: sync.right, rowPaddingRight: parseFloat(getComputedStyle(document.querySelector('#commitSelectors .selector-row')).paddingRight) };
        });
        assert.ok(Math.abs(syncGeometry.rowRight - syncGeometry.rowPaddingRight - syncGeometry.syncRight) < 1.5, 'sync buttons stay at the far right of the @ repository row: ' + JSON.stringify(syncGeometry));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'origin');
        assert.equal(await page.locator('.remote-option').count(), 2);
        assert.equal(await page.locator('.remote-option[aria-selected="true"]').count(), 1);
        await page.locator('.remote-option-select').nth(1).click();
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'upstream');
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'selectRemote')), [{ type: 'selectRemote', name: 'upstream' }]);
        await page.locator('.remote-delete-button').first().click();
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'deleteRemote')), [{ type: 'deleteRemote', name: 'origin' }]);
        await page.locator('#remoteAddButton').click();
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'addRemote')), [{ type: 'addRemote' }]);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [{ name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' }],
            selectedRemote: '',
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), '未选择远程仓库');

        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo', remotes: [], selectedRemote: '',
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), '添加远程仓库');
        assert.equal(await page.locator('#remoteSelectorMenu').isVisible(), false);
        await page.locator('#remoteSelectorButton').click();
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'addRemote')), [
            { type: 'addRemote' },
            { type: 'addRemote' },
        ]);
        assert.deepEqual(pageErrors, []);
        console.log('Remote selector UI passed: single selection, add/delete actions, empty-state direct add, and repository-row placement.');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});