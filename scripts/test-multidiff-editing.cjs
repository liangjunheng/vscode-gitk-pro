const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderMultiDiffHtml } = require('../out/webview/multiDiffPanelDocument');

async function main() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const html = renderMultiDiffHtml('http://fixture', 'http://fixture/icons.css', 'http://fixture/vs', 'test')
            .replace("window.addEventListener('message',event=>receive(event.data))", `
                window.testEntryValue = key => cardByPath.get(key)?.modifiedValue;
                window.addEventListener('message',event=>receive(event.data))`)
            .replace('<style>', '<style>:root{--vscode-editor-font-family:Consolas,monospace;--vscode-editor-font-size:16px;--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-editor-foreground:#cccccc;--vscode-tab-activeForeground:#ffffff;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#aaaaaa;--vscode-widget-border:#454545;--vscode-editorGroup-border:#454545;--vscode-panel-border:#454545;--vscode-focusBorder:#007acc}');
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
        const identity = 'editable-unstaged-fixture';
        const original = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
        const modified = original.replace('line 40', 'changed 40');
        const diff = { path: 'editable.txt', diffKey: 'unstaged:editable.txt', workingTreeKind: 'unstaged', status: 'M', loaded: true, editable: true, original, modified };
        const publish = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
        await publish({ type: 'snapshot', revision: 1, identity, loading: false, editable: true, diffs: [diff], total: 1, completed: 1, selectionEpoch: 1 });
        await page.waitForFunction(() => document.querySelector('.diff .monaco-diff-editor'));
        await page.waitForTimeout(500);
        await page.evaluate(async () => {
            const card = document.querySelector('.diff');
            window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const geometry = () => page.evaluate(() => {
            const card = document.querySelector('.diff');
            const body = card.querySelector('.diff-body');
            return { cardHeight: card.getBoundingClientRect().height, bodyHeight: body.getBoundingClientRect().height, cardTop: card.getBoundingClientRect().top, scrollY: window.scrollY, collapsed: card.classList.contains('collapsed') };
        });
        const before = await geometry();
        assert.equal(await page.evaluate(() => {
            const editor = monaco.editor.getEditors().find(candidate => !candidate.getOption(monaco.editor.EditorOption.readOnly));
            if (!editor) return false;
            editor.getDomNode().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            const model = editor.getModel();
            const lineNumber = model.getLineCount();
            editor.setPosition({ lineNumber, column: model.getLineMaxColumn(lineNumber) });
            editor.focus();
            return true;
        }), true);
        await page.keyboard.type('X');
        await page.waitForTimeout(650);
        const duringEdit = await geometry();
        assert.ok(Math.abs(duringEdit.cardHeight - before.cardHeight) < 1, JSON.stringify({ before, duringEdit }));
        assert.ok(Math.abs(duringEdit.bodyHeight - before.bodyHeight) < 1, JSON.stringify({ before, duringEdit }));
        assert.equal(duringEdit.cardTop, before.cardTop);
        assert.equal(duringEdit.scrollY, before.scrollY);
        assert.equal(duringEdit.collapsed, false);
        const save = await page.evaluate(() => window.messages.filter(message => message.type === 'saveFile').at(-1));
        assert.ok(save && save.content.endsWith('X'));

        const editorState = () => page.evaluate(() => {
            const editor = monaco.editor.getEditors().find(candidate => !candidate.getOption(monaco.editor.EditorOption.readOnly));
            return { value: editor.getValue(), position: editor.getPosition(), scrollTop: editor.getScrollTop() };
        });
        const beforeEcho = await editorState();

        // A delayed watcher echo can contain an older file body. It must not replace the active model or reset the cursor to 1:1.
        await publish({ type: 'diffUpdates', revision: 2, identity, loading: false, completed: 1, total: 1, diffs: [{ ...diff, modified: 'stale watcher body\n' }] });
        await page.waitForTimeout(250);
        const afterEcho = await editorState();
        assert.deepEqual(afterEcho, beforeEcho);
        const afterRefresh = await geometry();
        assert.ok(Math.abs(afterRefresh.cardHeight - before.cardHeight) < 1, JSON.stringify({ before, afterRefresh }));
        assert.ok(Math.abs(afterRefresh.bodyHeight - before.bodyHeight) < 1, JSON.stringify({ before, afterRefresh }));
        assert.equal(afterRefresh.cardTop, before.cardTop);
        assert.equal(afterRefresh.scrollY, before.scrollY);
        const savesDuringEcho = await page.evaluate(() => window.messages.filter(message => message.type === 'saveFile'));
        assert.ok(savesDuringEcho.length >= 2);
        assert.equal(savesDuringEcho.at(-1).content, save.content);

        // Losing focus releases the height lock without allowing the stale watcher body to win.
        await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
        await page.waitForTimeout(300);
        const afterBlur = await geometry();
        assert.equal(afterBlur.collapsed, false);
        assert.ok(afterBlur.bodyHeight > before.bodyHeight + 1, JSON.stringify({ before, afterBlur }));
        const savesAfterEcho = await page.evaluate(() => window.messages.filter(message => message.type === 'saveFile'));
        assert.ok(savesAfterEcho.length >= 2);
        assert.equal(savesAfterEcho.at(-1).content, save.content);

        // An empty Host refresh received for an offscreen logical card must replace, not retain, its previous text.
        await page.goto('http://fixture/');
        await page.waitForTimeout(50);
        errors.length = 0; // Monaco cancels the previous page's diff worker during this deliberate fixture reload.
        const emptyIdentity = 'empty-offscreen-fixture';
        const offscreenDiffs = Array.from({ length: 30 }, (_, index) => ({
            path: `file-${index}.txt`, diffKey: `unstaged:file-${index}.txt`, workingTreeKind: 'unstaged', status: 'M', loaded: true, editable: true,
            original: 'before\n', modified: index === 29 ? 'stale text' : 'after\n',
        }));
        const emptyTarget = offscreenDiffs.at(-1);
        await publish({ type: 'snapshot', revision: 1, identity: emptyIdentity, loading: false, editable: true, diffs: offscreenDiffs, total: offscreenDiffs.length, completed: offscreenDiffs.length, selectionEpoch: 1 });
        await page.waitForFunction(() => window.messages.some(message => message.type === 'rendered'));
        assert.equal(await page.locator(`.diff[data-diff-key="${emptyTarget.diffKey}"]`).count(), 0, 'fixture target must remain outside the mounted virtual window');
        await publish({ type: 'diffUpdates', revision: 2, identity: emptyIdentity, loading: false, completed: offscreenDiffs.length, total: offscreenDiffs.length, diffs: [{ ...emptyTarget, modified: '' }] });
        assert.equal(await page.evaluate(key => window.testEntryValue(key), emptyTarget.diffKey), '');
        await publish({ type: 'reveal', path: emptyTarget.diffKey, selectionEpoch: 2 });
        await page.waitForFunction(key => {
            const card = document.querySelector(`.diff[data-diff-key="${key}"]`);
            return card && monaco.editor.getEditors().some(editor => card.contains(editor.getDomNode()) && !editor.getOption(monaco.editor.EditorOption.readOnly));
        }, emptyTarget.diffKey);
        assert.equal(await page.evaluate(key => {
            const card = document.querySelector(`.diff[data-diff-key="${key}"]`);
            return monaco.editor.getEditors().find(editor => card.contains(editor.getDomNode()) && !editor.getOption(monaco.editor.EditorOption.readOnly)).getValue();
        }, emptyTarget.diffKey), '');

        // Collapsing before the 400 ms debounce expires must flush the pending edit instead of cancelling it.
        await page.evaluate(() => { window.messages.length = 0; });
        assert.equal(await page.evaluate(key => {
            const card = document.querySelector(`.diff[data-diff-key="${key}"]`);
            const editor = monaco.editor.getEditors().find(candidate => card.contains(candidate.getDomNode()) && !candidate.getOption(monaco.editor.EditorOption.readOnly));
            if (!editor) return false;
            editor.getDomNode().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            editor.setPosition({ lineNumber: 1, column: 1 });
            editor.focus();
            return true;
        }, emptyTarget.diffKey), true);
        await page.keyboard.type('pending edit');
        await page.waitForTimeout(250); // Let Monaco finish the diff while keeping the 400 ms save pending.
        await page.evaluate(key => document.querySelector(`.diff[data-diff-key="${key}"] .file-header`).click(), emptyTarget.diffKey);
        await page.waitForTimeout(50);
        const collapsedSave = await page.evaluate(() => window.messages.filter(message => message.type === 'saveFile').at(-1));
        assert.ok(collapsedSave && collapsedSave.content === 'pending edit');
        assert.equal(await page.locator(`.diff[data-diff-key="${emptyTarget.diffKey}"]`).evaluate(card => card.classList.contains('collapsed')), true);

        assert.deepEqual(errors, []);
        console.log('MultiDiff editing: stable geometry, stale watcher echo, empty refresh, and pending-save flush passed');
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
