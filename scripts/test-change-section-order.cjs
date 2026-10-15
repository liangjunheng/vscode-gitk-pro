const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { renderCommitPanelHtml } = require('../out/webview/commitPanelDocument');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

async function main() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.exposeFunction('noop', () => {});
        const shim = () => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} }); };
        await page.evaluate(shim);
        const repositoryPath = 'file:///fixture';
        const conflict = { path: 'conflict.cpp', status: 'U', isConflict: true };
        const staged = { path: 'staged.cpp', status: 'M' };
        const unstaged = { path: 'unstaged.cpp', status: 'M' };
        const card = { repositoryPath, repositoryLabel: 'fixture', repositoryHasSubmodules: false, repositoryAncestry: [],
            message: '', selectedCommitSubmoduleRepositoryPaths: [], selectedPushSubmoduleRepositoryPaths: [], pullBeforePush: true,
            amend: false, committedFiles: [], committedFilesLoading: false, latestCommitSubmodulePaths: [], hasUnpushedCommits: false,
            unpushedCommitCount: 0, changedSubmoduleRepositoryPaths: [], conflictFiles: [conflict], stagedFiles: [staged], unstagedFiles: [unstaged], committing: false };
        await page.setContent(renderCommitPanelHtml('icons.css', 'test', '', JSON.stringify({ cards: [card], displayMode: 'flat' })));
        assert.deepEqual(await page.locator('.section:not([hidden]) .section-title .left > span:nth-child(2)').allTextContents(), ['Merge Changes', 'Unstaged Changes', 'Staged Changes']);
        await page.locator('.stage-all').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1).paths), ['unstaged.cpp']);
        await page.locator('.staged-all').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1).paths), ['staged.cpp']);
        assert.equal(await page.locator('.merge-continue').isDisabled(), true);
        await page.evaluate(card => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', cards: [{ ...card, mergeOperation: 'merge' }], displayMode: 'flat' } })), card);
        assert.equal(await page.locator('.merge-abort').isDisabled(), false);
        await page.locator('.merge-abort').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), { type: 'mergeOperation', repositoryPath, action: 'abort' });
        await page.evaluate(card => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', cards: [{ ...card, conflictFiles: [], mergeOperation: 'merge' }], displayMode: 'flat' } })), card);
        assert.equal(await page.locator('.section.conflict').isVisible(), true, 'keep operation controls after last conflict is staged');
        await page.locator('.merge-continue').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), { type: 'mergeOperation', repositoryPath, action: 'continue' });
        await page.setContent(renderGitkWebviewHtml('icons.css'));
        await page.evaluate(shim);
        await page.evaluate(({ repositoryPath, conflict, staged, unstaged }) => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'stateUpdate', state: { repositoryChanges: [{ repositoryPath, repositoryLabel: 'fixture', isMainRepository: true,
                headLabel: 'main', message: '', staged: [conflict, staged], unstaged: [conflict, unstaged] }],
                commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [], workingTreeRows: [], files: [],
                selectedCommit: { hash: 'uncommitted', repositoryPath }, filesLoading: false, filesMode: 'flat', commitLoading: false }
        } })), { repositoryPath, conflict, staged, unstaged });
        assert.deepEqual(await page.locator('.repo-group').evaluateAll(groups => groups.map(group => group.dataset.section)), ['conflict', 'unstaged', 'staged']);
        assert.deepEqual(await page.locator('.repo-group-toggle > span:nth-child(2)').allTextContents(), ['Merge Changes', 'Unstaged Changes', 'Staged Changes']);
        await page.evaluate(repositoryPath => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: {
            repositoryChanges: [{ repositoryPath, repositoryLabel: 'fixture', isMainRepository: true, headLabel: 'main',
                staged: [{ path: 'resolved.cpp', status: 'M' }], unstaged: [], mergeOperation: 'merge' }],
            commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [], workingTreeRows: [], files: [],
            selectedCommit: { hash: 'uncommitted', repositoryPath }, filesLoading: false, filesMode: 'flat', commitLoading: false
        } } })), repositoryPath);
        assert.equal(await page.locator('.repo-group[data-section="conflict"]').isVisible(), true);
        await page.locator('[data-repo-action="continue"]').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), { type: 'repositoryChangesAction', repositoryPath, action: 'continue' });
        await page.locator('[data-repo-action="abort"]').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), { type: 'repositoryChangesAction', repositoryPath, action: 'abort' });
        assert.deepEqual(errors, []);
        console.log('Change section order: Commit Panel and repository cards use Merge / Unstaged / Staged; actions remain scoped');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
