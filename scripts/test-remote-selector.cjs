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
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), '未选择远程仓库', 'a missing cache uses a stable placeholder instead of a loading label');
        assert.equal(await page.locator('#remoteSelectorButton').isDisabled(), true, 'an uncached repository starts in loading state');
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [
                { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
            ],
            upstreamRemote: 'origin'
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'origin', 'an empty upstream must not erase a valid selected remote');
        await page.locator('#remoteSelectorButton').click();
        assert.equal(await page.locator('#remoteSelectorMenu').isVisible(), true);
        assert.equal(await page.locator('#remoteSelectorProgress').isVisible(), true, 'opening the remote popup shows its loading progress');
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'origin', 'background refresh keeps the cached remote label visible');
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'requestRemoteList')), [{ type: 'requestRemoteList' }]);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [
                { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
            ],
            upstreamRemote: 'origin',
        } })));
        assert.equal(await page.locator('.remote-option-name').first().textContent(), 'origin', 'the upstream remote is listed first');
        assert.equal(await page.locator('.remote-default-badge').count(), 1, 'only the current upstream remote has the default badge');
        assert.equal(await page.locator('.remote-option').first().locator('.remote-default-badge').textContent(), '默认');
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
        const remoteOptionBackground = await page.locator('.remote-option').first().evaluate(element => getComputedStyle(element).backgroundColor);
        await page.locator('.remote-option').first().hover();
        assert.equal(await page.locator('.remote-option').first().evaluate(element => getComputedStyle(element).backgroundColor), remoteOptionBackground, 'remote rows have no hover highlight');
        await page.locator('.remote-option-content').first().click();
        assert.equal(await page.locator('.remote-option').first().evaluate(element => getComputedStyle(element).backgroundColor), remoteOptionBackground, 'remote rows have no click highlight');
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'selectRemote')), [], 'clicking a remote row has no selection behavior');
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'selectedRepoDisplayChanged',
            repository: { path: 'file:///fixture/cached', label: 'cached', hasSubmodules: false, isSubmodule: false },
            remoteState: {
                remotes: [{ name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' }],
                upstreamRemote: 'upstream'
            }
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'upstream', 'repository switch replays the host cache immediately');
        assert.equal(await page.locator('#remoteSelectorButton').isDisabled(), false, 'cached remote remains interactive during background refresh');
        assert.equal(await page.locator('#remoteSelectorProgress').isVisible(), false, 'cached repository does not flash the loading state');
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'selectedRepoDisplayChanged',
            repository: { path: 'file:///fixture/repo', label: 'repo', hasSubmodules: false, isSubmodule: false },
            remoteState: {
                remotes: [
                    { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                    { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
                ],
                upstreamRemote: 'origin'
            }
        } })));
        assert.equal(await page.locator('.remote-operation-checkbox[data-remote-name="origin"]:checked').count(), 3, 'bound upstream remote is enabled for Fetch, Pull, and Push by default');
        assert.equal(await page.locator('.remote-operation-checkbox[data-remote-name="origin"]:disabled').count(), 0, 'bound upstream operation checkboxes remain configurable');
        assert.equal(await page.locator('.remote-operation-checkbox[data-remote-name="upstream"]:checked').count(), 0, 'other remotes start unchecked without local config');
        await page.locator('.remote-operation-checkbox[data-operation="pull"][data-remote-name="upstream"]').check();
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), 'origin', 'checkboxes configure operations without changing the displayed upstream');
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'setRemoteOperation')), [{ type: 'setRemoteOperation', operation: 'pull', name: 'upstream', enabled: true }]);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [
                { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
            ],
            upstreamRemote: 'origin', operations: { fetch: ['origin'], pull: ['origin'], push: ['origin'] }
        } })));
        assert.equal(await page.locator('.remote-operation-checkbox[data-operation="pull"][data-remote-name="upstream"]').isChecked(), true, 'an older background snapshot cannot clear an optimistic check');
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [
                { name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' },
                { name: 'upstream', fetchUrl: 'https://example.com/upstream.git', pushUrl: 'https://example.com/upstream.git' },
            ],
            upstreamRemote: 'origin', operations: { fetch: ['origin'], pull: ['origin', 'upstream'], push: ['origin'] }
        } })));
        assert.equal(await page.locator('.remote-operation-checkbox[data-operation="pull"][data-remote-name="upstream"]').isChecked(), true, 'persisted config confirms the checked state without flicker');
        await page.locator('.remote-delete-button').first().click();
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'deleteRemote')), [{ type: 'deleteRemote', name: 'origin' }]);
        await page.locator('#remoteAddButton').click();
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'addRemote')), [{ type: 'addRemote' }]);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo',
            remotes: [{ name: 'origin', fetchUrl: 'https://example.com/origin.git', pushUrl: 'https://example.com/origin.git' }],
            upstreamRemote: '',
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), '未选择远程仓库');

        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'remoteListChanged', repositoryPath: 'file:///fixture/repo', remotes: [],
        } })));
        assert.equal(await page.locator('#remoteSelectorButton .remote-selector-label').textContent(), '添加远程仓库');
        assert.equal(await page.locator('#remoteSelectorMenu').isVisible(), false);
        await page.locator('#remoteSelectorButton').click();
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'addRemote')), [
            { type: 'addRemote' },
            { type: 'addRemote' },
        ]);
        assert.deepEqual(pageErrors, []);
        console.log('Remote selector UI passed: upstream display, operation checkboxes, add/delete actions, empty-state direct add, and repository-row placement.');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});