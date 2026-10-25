const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const html = renderGitkWebviewHtml('codicon.css').replace(
            '<script>\n',
            '<script>window.messages=[];window.acquireVsCodeApi=()=>({postMessage(message){window.messages.push(message);},getState:()=>({}),setState(){}});\n',
        );
        await page.setContent(html);
        const repositories = [
            { path: 'file:///fixture/repo-a', label: 'repo-a', ancestry: [], hasSubmodules: false, isSubmodule: false },
            { path: 'file:///fixture/repo-b', label: 'repo-b', ancestry: [{ label: 'parent' }], hasSubmodules: true, isSubmodule: false },
        ];
        await page.evaluate(repositories => {
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'totalRepoListChanged', repositories, selectedRepositoryPaths: [repositories[0].path] } }));
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedRepoDisplayChanged', repository: repositories[0] } }));
        }, repositories);
        assert.equal(await page.locator('#repositoryDisplay .dropdown-value').textContent(), 'repo-a');
        assert.equal(await page.locator('#repositoryDisplay').isDisabled(), false);
        await page.locator('#repositoryDisplay').click();
        assert.equal(await page.locator('#repositorySelectorMenu').isVisible(), true);
        const menuGeometry = await page.evaluate(() => {
            const button = document.getElementById('repositoryDisplay').getBoundingClientRect();
            const menu = document.getElementById('repositorySelectorMenu').getBoundingClientRect();
            return { buttonCenter: (button.left + button.right) / 2, menuCenter: (menu.left + menu.right) / 2 };
        });
        assert.ok(Math.abs(menuGeometry.menuCenter - menuGeometry.buttonCenter) < 1, 'repository selector menu centers on its button');
        assert.equal(await page.locator('.repository-selector-option').count(), 2);
        await page.locator('.repository-selector-option').nth(1).click();
        assert.equal(await page.locator('#repositoryDisplay .dropdown-value').textContent(), 'repo-b');
        assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.type === 'repositoryChangesAction')), [
            { type: 'repositoryChangesAction', action: 'focus', repositoryPath: 'file:///fixture/repo-b' },
        ]);
        await page.evaluate(repository => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedRepoDisplayChanged', repository } })), repositories[1]);
        assert.equal(await page.locator('.repository-selector-option[aria-selected="true"] .repository-selector-option-label').textContent(), 'repo-b');
        assert.deepEqual(errors, []);
        console.log('Repository selector UI passed: menu selection, card-focus action, selected-state sync, and repository-row placement.');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});