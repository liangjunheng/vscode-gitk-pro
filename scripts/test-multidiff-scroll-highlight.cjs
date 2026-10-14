const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderMultiDiffHtml } = require('../out/webview/multiDiffPanelDocument');

async function main() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const height of [360, 760]) {
            const page = await browser.newPage({ viewport: { width: 1200, height } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            // Inspect the real webview closure without adding a production testing API.
            const html = renderMultiDiffHtml('http://fixture', 'http://fixture/icons.css', 'http://fixture/vs', 'test')
                .replace("window.addEventListener('message',event=>receive(event.data))", `
                    window.inspectLayout = () => {
                        if (layoutDirty) rebuildLayoutMetrics();
                        return cards.filter(entry => entry.card).map(entry => ({
                            path: entry.path, logicalHeight: entryHeight(entry),
                            actualHeight: entry.card.getBoundingClientRect().height + (parseFloat(getComputedStyle(entry.card).marginBottom) || 0),
                            bodyHeight: entry.bodyHeight, actualBodyHeight: entry.body.getBoundingClientRect().height
                        }));
                    };
                    window.testSuppressedSync = () => {
                        suppressSyncUntil = performance.now() + 100;
                        syncActiveFromViewport();
                    };
                    window.addEventListener('message',event=>receive(event.data))`);
            for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script[1]);
            await page.route('http://fixture/**', route => {
                const name = new URL(route.request().url()).pathname;
                if (name === '/') return route.fulfill({ body: html, contentType: 'text/html' });
                const file = name.startsWith('/vs/')
                    ? path.resolve(__dirname, '../media/monaco', name.slice(1))
                    : path.resolve(__dirname, '../media/codicons', name === '/icons.css' ? 'codicon.css' : 'codicon.ttf');
                if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
                return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
            });
            await page.addInitScript(() => {
                window.messages = [];
                window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
            });
            await page.goto('http://fixture/');
            const identity = 'scroll-highlight-fixture';
            const publish = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
            await publish({ type: 'snapshot', revision: 1, identity: 'missing-path-fixture', loading: false, editable: false,
                diffs: [{ diffKey: 'missing-path', status: 'M', loaded: true, original: 'before\n', modified: 'after\n' }], total: 1, completed: 1, selectionEpoch: 1, revealPath: 'missing-path' });
            await page.waitForFunction(() => window.messages.some(message => message.type === 'rendered'));
            assert.equal(await page.locator('.diff[data-diff-key="missing-path"]').count(), 1, 'missing paths fall back to plaintext without failing the whole diff');
            assert.equal(errors.length, 0);
            const diffs = [
                ...Array.from({ length: 10 }, (_, index) => ({ path: `repo-${index}`, status: 'M', loaded: true, isGitlink: true, gitlinkWorktreeDirty: true })),
                { path: '.clangd', status: 'M', loaded: true, original: 'before\n', modified: 'after\n' },
                { path: 'canvas_handle_jni.cpp', status: 'M', loaded: true, original: 'old\n', modified: 'new\n' }
            ];
            await publish({ type: 'snapshot', revision: 2, identity, loading: false, editable: false, diffs, total: diffs.length, completed: diffs.length, selectionEpoch: 1, revealPath: diffs[0].path,
                parentCommit: height === 360 ? { hash: '123456789', title: 'Parent commit' } : undefined });
            await page.waitForFunction(() => window.messages.some(message => message.type === 'rendered'));
            await page.mouse.move(900, height / 2);
            await page.waitForTimeout(300);
            // Only wheel input, including the final event at the bottom. No card clicks or reveals.
            for (let step = 0; step < 35; step++) {
                await page.mouse.wheel(0, 90);
                await page.waitForTimeout(120);
            }
            await page.waitForFunction(() => document.querySelector('.diff.selected')?.dataset.path === 'canvas_handle_jni.cpp');
            assert.deepEqual(await page.locator('.diff.selected').evaluateAll(cards => cards.map(card => card.dataset.path)), ['canvas_handle_jni.cpp']);
            assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'selectFile').at(-1)?.path), 'canvas_handle_jni.cpp');
            const metrics = await page.evaluate(() => window.inspectLayout());
            for (const metric of metrics) assert.ok(Math.abs(metric.logicalHeight - metric.actualHeight) < 1, JSON.stringify(metric));
            const staticMetric = metrics.find(metric => metric.path.startsWith('repo-'));
            assert.ok(staticMetric && staticMetric.actualBodyHeight < 80, 'fixture exercises natural-height static cards');
            assert.ok(Math.abs(staticMetric.bodyHeight - staticMetric.actualBodyHeight) < 1);

            // Scrolling upward to the penultimate short card must also switch exactly one highlight.
            const delta = await page.locator('.diff[data-path=".clangd"]').evaluate(card => card.getBoundingClientRect().top - (document.getElementById('parent-commit-navigation').hidden ? 0 : 40));
            await page.mouse.wheel(0, delta);
            await page.waitForFunction(() => document.querySelector('.diff.selected')?.dataset.path === '.clangd');
            assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'selectFile').at(-1)?.path), '.clangd');

            // A suppressed final scroll must be retried even when there are no further scroll events.
            await page.evaluate(() => {
                const last = document.querySelector('.diff[data-path="canvas_handle_jni.cpp"]');
                window.testSuppressedSync();
                window.scrollBy(0, last.getBoundingClientRect().top - (document.getElementById('parent-commit-navigation').hidden ? 0 : 40));
            });
            await page.waitForFunction(() => document.querySelector('.diff.selected')?.dataset.path === 'canvas_handle_jni.cpp');
            assert.equal(await page.locator('.diff.selected').count(), 1);

            // Explicit selection still owns the highlight until the next manual wheel input.
            await publish({ type: 'reveal', path: '.clangd', selectionEpoch: 2 });
            await page.waitForFunction(() => document.querySelector('.diff.selected')?.dataset.path === '.clangd');
            await page.waitForTimeout(300);
            assert.equal(await page.locator('.diff.selected').getAttribute('data-path'), '.clangd');
            await page.locator('.diff[data-path=".clangd"] .file-header').click();
            await page.waitForTimeout(200);
            const collapsed = (await page.evaluate(() => window.inspectLayout())).find(metric => metric.path === '.clangd');
            assert.ok(Math.abs(collapsed.logicalHeight - collapsed.actualHeight) < 1, JSON.stringify(collapsed));
            await page.mouse.wheel(0, 10000);
            await page.waitForFunction(() => document.querySelector('.diff.selected')?.dataset.path === 'canvas_handle_jni.cpp');
            assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'selectFile').at(-1)?.selectionEpoch), 2);
            assert.deepEqual(errors, []);
            console.log(`MultiDiff scroll highlight: short static cards, final two text cards, bottom retry, parent navigation (height=${height}) passed`);
            await page.close();
        }
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
