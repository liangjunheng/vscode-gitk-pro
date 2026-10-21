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
        assert.equal(await page.locator('.pull-before-push-checkbox').count(), 0, 'push no longer offers a pull-before-push mode');
        await page.locator('.push-btn').click();
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), { type: 'gitSync', action: 'push', repositoryPaths: [repositoryPath], pullBeforePush: false });
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
        await page.locator('.repo-changes-label').click();
        assert.equal(await page.locator('.repo-group[data-section="unstaged"]').isVisible(), true, 'the card is expanded so the badges have real geometry');
        const badgeGaps = await page.locator('.repo-group').evaluateAll(groups => Object.fromEntries(groups.map(group => {
            const label = group.querySelector('.repo-group-toggle > span:nth-child(2)').getBoundingClientRect();
            const badge = group.querySelector('.repo-count').getBoundingClientRect();
            return [group.dataset.section, Math.round(badge.left - label.right)];
        })));
        assert.equal(badgeGaps.unstaged, 5, 'the Unstaged count badge sits right after its title');
        assert.equal(badgeGaps.staged, 5, 'the Staged count badge sits right after its title');
        assert.equal(badgeGaps.conflict, 5, 'the Merge Changes count badge sits right after its title too');
        const badgeSize = await page.locator('.repo-count').first().evaluate(node => { const r = node.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; });
        assert.ok(badgeSize.height <= 16 && badgeSize.width <= 18, 'the repository-card count badge is compact, got ' + JSON.stringify(badgeSize));
        await verifyCountBadgeCentering(browser, repositoryPath);
        assert.equal(await page.locator('.repo-group[data-section="unstaged"] .repo-group-toggle .repo-count').textContent(), '1');
        // A file row's action icons must sit under the matching icons of the group header, otherwise the two columns look shifted and click the opposite action.
        const iconColumns = await page.locator('.repo-group[data-section="unstaged"], .repo-group[data-section="staged"]').evaluateAll(groups => Object.fromEntries(groups.map(group => {
            const columns = scope => Object.fromEntries([...scope.querySelectorAll(':scope > .toolbar-icon, :scope > .repo-file-actions > .toolbar-icon')].map(button => [button.dataset.repoAction, Math.round(button.getBoundingClientRect().left)]));
            return [group.dataset.section, { header: columns(group.querySelector('.repo-group-header')), row: columns(group.querySelector('.repo-file-row')) }];
        })));
        assert.ok(iconColumns.unstaged.header.discard < iconColumns.unstaged.header.stage, 'the header lists discard before stage');
        assert.equal(iconColumns.unstaged.row.discard, iconColumns.unstaged.header.discard, 'the row discard icon is under the header discard icon: ' + JSON.stringify(iconColumns.unstaged));
        assert.equal(iconColumns.unstaged.row.stage, iconColumns.unstaged.header.stage, 'the row stage icon is under the header stage icon: ' + JSON.stringify(iconColumns.unstaged));
        assert.equal(iconColumns.staged.row.unstage, iconColumns.staged.header.unstage, 'the staged row unstage icon is under the header unstage icon: ' + JSON.stringify(iconColumns.staged));
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
// Measures the rendered pixels, not the box: the digits must sit in the middle of the pill for 1, 2 and 3 digits, at a fractional zoom too.
async function verifyCountBadgeCentering(browser, repositoryPath) {
    const { PNG } = require('pngjs');
    const files = count => Array.from({ length: count }, (_, index) => ({ path: 'file-' + index + '.cpp', status: 'M' }));
    const state = count => ({ repositoryChanges: [{ repositoryPath, repositoryLabel: 'fixture', isMainRepository: true, headLabel: 'main', message: '', staged: [], unstaged: files(count) }],
        commits: [], branches: [], selectedBranches: [], selectedRepositoryPaths: [repositoryPath], workingTreeRows: [], files: [],
        selectedCommit: { hash: 'uncommitted', repositoryPath }, filesLoading: false, filesMode: 'flat', commitLoading: false });
    for (const scale of [1, 1.5, 2]) {
        const page = await browser.newPage({ viewport: { width: 380, height: 420 }, deviceScaleFactor: scale });
        try {
            await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} }); });
            await page.setContent(renderGitkWebviewHtml('icons.css'));
            await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} }); });
            await page.addStyleTag({ content: ':root{--vscode-badge-background:#24758e;--vscode-badge-foreground:#ffffff;--vscode-font-family:"Segoe UI";--vscode-font-size:13px}body{background:#181818}' });
            const publish = count => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), state(count));
            await publish(1);
            await page.locator('.repo-changes-label').click();
            const widths = {};
            for (const count of [1, 8, 10, 99, 123]) {
                await publish(count);
                const badge = page.locator('.repo-group[data-section="unstaged"] .repo-count');
                await badge.waitFor();
                assert.equal((await badge.textContent()).trim(), String(count), 'the badge shows the file count');
                const png = PNG.sync.read(await badge.screenshot());
                let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
                for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
                    const offset = (y * png.width + x) * 4;
                    // White digit ink on the badge colour; the red channel separates them (digit 255, badge 36, page 24).
                    if (png.data[offset] > 150 && png.data[offset + 1] > 150) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
                }
                assert.ok(maxX >= 0, 'digit ink was found for ' + count);
                const vertical = Math.abs(minY - (png.height - 1 - maxY)) / 2 / scale;
                const horizontal = Math.abs(minX - (png.width - 1 - maxX)) / 2 / scale;
                assert.ok(vertical <= 0.75, count + ' is vertically centred at ' + scale + 'x, off by ' + vertical.toFixed(2) + 'px');
                assert.ok(horizontal <= 0.75, count + ' is horizontally centred at ' + scale + 'x, off by ' + horizontal.toFixed(2) + 'px');
                widths[count] = Math.round(await badge.evaluate(node => node.getBoundingClientRect().width * 10)) / 10;
            }
            assert.equal(widths[10], widths[99], 'every 2-digit count gives the same pill width');
            assert.ok(widths[10] > widths[1] && widths[123] > widths[10], 'the pill grows with the digits: ' + JSON.stringify(widths));
            assert.ok(widths[10] - widths[1] <= 8, '2 digits are not much wider than 1, got ' + JSON.stringify(widths));
        } finally { await page.close(); }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
