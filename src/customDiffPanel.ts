import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { ChangeSetMode, CommitFile } from './gitLogProvider';

interface DiffPayload {
    index: number;
    path: string;
    oldPath?: string;
    status: string;
    original: string;
    modified: string;
    error?: string;
}

// 自定义 Diff 面板，按需读取文件，并使用接近 VS Code 的并排行级差异渲染。
export class CustomDiffPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private files: CommitFile[] = [];
    private hash = '';
    private changeSetMode: ChangeSetMode = 'commit';
    private rootUri?: vscode.Uri;
    private requestGeneration = 0;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly onSelectFile: (path: string) => void,
    ) {}

    async show(rootUri: vscode.Uri, hash: string, files: CommitFile[], revealPath?: string, changeSetMode: ChangeSetMode = 'commit'): Promise<void> {
        const isSameCommit = this.panel && this.rootUri?.toString() === rootUri.toString() && this.hash === hash && this.changeSetMode === changeSetMode;
        if (!isSameCommit) {
            this.requestGeneration++;
        }
        this.rootUri = rootUri;
        this.hash = hash;
        this.changeSetMode = changeSetMode;
        this.files = files;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'vscode-gitk.customDiff',
                'Gitk Diff',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            this.panel.webview.html = this.getHtml();
            this.disposables.push(
                this.panel.webview.onDidReceiveMessage(message => this.onMessage(message)),
                this.panel.onDidDispose(() => { this.panel = undefined; }),
            );
        }
        this.panel.title = `Gitk Diff (${hash.slice(0, 8)})`;
        this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
        if (isSameCommit) {
            await this.panel.webview.postMessage({ type: 'selectFile', path: revealPath || '' });
            return;
        }
        await this.panel.webview.postMessage({
            type: 'reset',
            hash,
            generation: this.requestGeneration,
            files: files.map((file, index) => ({ index, path: file.path, oldPath: file.oldPath, status: file.status })),
            revealPath,
        });
    }

    private async onMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') { return; }
        const payload = message as { type?: string; start?: unknown; end?: unknown; path?: unknown; generation?: unknown };
        if (payload.type === 'loadAll') {
            const generation = Number(payload.generation);
            if (generation !== this.requestGeneration) { return; }
            const diffs = await this.readAllDiffs();
            if (generation !== this.requestGeneration) { return; }
            await this.panel?.webview.postMessage({ type: 'progress', generation, completed: diffs.length, total: diffs.length });
            await this.panel?.webview.postMessage({ type: 'diffs', generation, diffs });
        } else if (payload.type === 'selectFile' && typeof payload.path === 'string') {
            this.onSelectFile(payload.path);
        }
    }

    private async readAllDiffs(): Promise<DiffPayload[]> {
        if (!this.rootUri) { throw new Error('未找到 Git 仓库'); }
        if (this.changeSetMode !== 'commit') {
            return this.readWorkingTreeDiffs();
        }
        const objects: string[] = [];
        for (const file of this.files) {
            if (file.status !== 'A') { objects.push(`${this.hash}^:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { objects.push(`${this.hash}:${file.path}`); }
        }
        const contents = await this.readGitObjects(objects);
        return this.files.map((file, index) => {
            const originalObject = file.status === 'A' ? undefined : `${this.hash}^:${file.oldPath || file.path}`;
            const modifiedObject = file.status === 'D' ? undefined : `${this.hash}:${file.path}`;
            const original = originalObject ? contents.get(originalObject) : '';
            const modified = modifiedObject ? contents.get(modifiedObject) : '';
            const missing = [originalObject, modifiedObject].find(object => object && !contents.has(object));
            return { index, path: file.path, oldPath: file.oldPath, status: file.status, original: original || '', modified: modified || '', error: missing ? `无法读取 Git 对象：${missing}` : undefined };
        });
    }

    private async readWorkingTreeDiffs(): Promise<DiffPayload[]> {
        const originalRef = this.changeSetMode === 'staged' ? 'HEAD' : '';
        const objects: string[] = [];
        for (const file of this.files) {
            if (file.status !== 'A') { objects.push(`${originalRef}:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { objects.push(`:${file.path}`); }
        }
        const contents = await this.readGitObjects(objects);
        return Promise.all(this.files.map(async (file, index) => {
            const originalObject = file.status === 'A' ? undefined : `${originalRef}:${file.oldPath || file.path}`;
            const modifiedObject = file.status === 'D' ? undefined : `:${file.path}`;
            const original = originalObject ? contents.get(originalObject) || '' : '';
            const modified = this.changeSetMode === 'staged'
                ? (modifiedObject ? contents.get(modifiedObject) || '' : '')
                : await this.readWorkspaceFile(file.path);
            return { index, path: file.path, oldPath: file.oldPath, status: file.status, original, modified };
        }));
    }

    private async readWorkspaceFile(filePath: string): Promise<string> {
        if (!this.rootUri) { return ''; }
        try { return await readFile(path.join(this.rootUri.fsPath, filePath), 'utf8'); } catch { return ''; }
    }

    private readGitObjects(objects: string[]): Promise<Map<string, string>> {
        if (!this.rootUri || objects.length === 0) { return Promise.resolve(new Map()); }
        const uniqueObjects = [...new Set(objects)];
        return new Promise((resolve, reject) => {
            const child = spawn('git', ['-C', this.rootUri!.fsPath, 'cat-file', '--batch'], { windowsHide: true });
            const chunks: Buffer[] = [];
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
            child.on('error', reject);
            child.on('close', code => {
                if (code !== 0) { reject(new Error(stderr || `git cat-file 失败（退出码 ${code}）`)); return; }
                try {
                    const output = Buffer.concat(chunks);
                    const result = new Map<string, string>();
                    let offset = 0;
                    for (const object of uniqueObjects) {
                        const headerEnd = output.indexOf(0x0A, offset);
                        if (headerEnd < 0) { throw new Error('git cat-file 输出不完整'); }
                        const header = output.subarray(offset, headerEnd).toString('utf8');
                        offset = headerEnd + 1;
                        const size = Number(header.split(' ')[2]);
                        if (!Number.isFinite(size)) { continue; }
                        result.set(object, output.subarray(offset, offset + size).toString('utf8'));
                        offset += size + 1;
                    }
                    resolve(result);
                } catch (error) { reject(error); }
            });
            child.stdin.end(`${uniqueObjects.join('\n')}\n`);
        });
    }

    hide(): void {
        this.panel?.dispose();
    }

    dispose(): void {
        this.panel?.dispose();
        vscode.Disposable.from(...this.disposables).dispose();
    }

    private getHtml(): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
:root { color-scheme: light dark; --font-family: var(--vscode-editor-font-family); --font-size: var(--vscode-editor-font-size); --font-weight: var(--vscode-editor-font-weight); --line-height: var(--vscode-editor-line-height, 19px); } * { box-sizing: border-box; } body { margin: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); } button { font: inherit; } #toolbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; min-height: 35px; padding: 0 8px; color: var(--vscode-editor-foreground); border-bottom: 1px solid var(--vscode-editorGroup-border); background: var(--vscode-editor-background); } #title, #hash { color: var(--vscode-descriptionForeground); } #toolbar-spacer { flex: 1; } .toolbar-button { padding: 3px 8px; border: 0; border-radius: 0; color: var(--vscode-foreground); background: transparent; cursor: pointer; } .toolbar-button:hover, .toolbar-button.active { color: var(--vscode-toolbar-hoverForeground); background: var(--vscode-toolbar-hoverBackground); } #list { padding: 0; } .diff { margin: 0; border-bottom: 1px solid var(--vscode-editorGroup-border); background: var(--vscode-editor-background); } .file-header { position: sticky; top: 35px; z-index: 2; width: 100%; min-height: 32px; display: flex; align-items: center; gap: 7px; margin: 4px 0; padding: 0 7px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 5px; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); box-shadow: 0 1px 4px rgba(0, 0, 0, .07); cursor: pointer; font-size: calc(var(--font-size) * .89); text-align: left; } .chevron { display: flex; align-items: center; justify-content: center; width: 15px; align-self: stretch; color: var(--vscode-icon-foreground); line-height: 1; text-align: center; } .status { min-width: 15px; color: var(--vscode-gitDecoration-modifiedResourceForeground); font-weight: var(--font-weight); } .status-A { color: var(--vscode-gitDecoration-addedResourceForeground); } .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); } .status-M, .status-R { color: var(--vscode-gitDecoration-modifiedResourceForeground); } .file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rename { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; } .editor { width: 100%; overflow: hidden; background: var(--vscode-editor-background); } .split { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: stretch; } .split.unified { display: block; min-width: 0; } .pane { min-width: 0; overflow: hidden; border-right: 1px solid var(--vscode-editorGroup-border); } .right-pane { border-right: 0; } .unified-pane { display: none; } .unified .pane { display: none; } .unified .unified-pane { display: block; } .pane-title { box-sizing: border-box; display: block; height: 25px; padding: 4px 8px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editorGroup-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .line { box-sizing: border-box; height: var(--line-height); min-height: var(--line-height); display: grid; grid-template-columns: 52px minmax(0, 1fr); color: var(--vscode-editor-foreground); font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); line-height: var(--line-height); white-space: pre; } .unified .line { grid-template-columns: 18px 52px 52px minmax(0, 1fr); } .line-number, .line-marker { color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background); user-select: none; } .line-number { padding-right: 8px; text-align: right; } .line-marker { text-align: center; } .line-code { min-width: 0; padding: 0 8px; overflow: hidden; text-overflow: clip; } .removed { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .20)); } .added { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0, 155, 0, .20)); } .modified-removed, .modified-added { background: var(--vscode-diffEditor-unchangedCodeBackground, rgba(86, 156, 214, .14)); } .removed .line-number, .removed .line-marker { background: var(--vscode-diffEditorGutter-removedLineBackground, var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .20))); } .added .line-number, .added .line-marker { background: var(--vscode-diffEditorGutter-insertedLineBackground, var(--vscode-diffEditor-insertedLineBackground, rgba(0, 155, 0, .20))); } .modified-removed .line-number, .modified-added .line-number { background: var(--vscode-diffEditor-unchangedCodeBackground, rgba(86, 156, 214, .14)); } .removed .line-code { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); border: 1px solid var(--vscode-diffEditor-removedTextBorder, transparent); } .added .line-code { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 155, 0, .35)); border: 1px solid var(--vscode-diffEditor-insertedTextBorder, transparent); } .modified-removed .line-code, .modified-added .line-code { background: transparent; border: 0; } .empty-line { color: transparent; } .placeholder { background-image: linear-gradient(-45deg, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 12.5%, transparent 12.5%, transparent 50%, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 50%, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 62.5%, transparent 62.5%, transparent 100%); background-size: 8px 8px; } .placeholder .line-number, .placeholder .line-code { background-color: transparent; } .context-fold { width: 100%; min-height: var(--line-height); padding: 0 8px; border: 0; color: var(--vscode-textLink-foreground); background: var(--vscode-diffEditor-unchangedRegionBackground); cursor: pointer; font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); line-height: var(--line-height); text-align: left; } .context-fold:hover { color: var(--vscode-textLink-activeForeground); background: var(--vscode-diffEditor-unchangedRegionForeground); } .unified .context-fold { padding-left: 26px; } .empty { padding: 16px 8px; color: var(--vscode-descriptionForeground); text-align: center; } #loadingView { padding-top: 32px; } #progressTrack { width: min(360px, calc(100vw - 48px)); height: 4px; margin: 12px auto 0; overflow: hidden; background: var(--vscode-progressBar-background); } #progressBar { width: 0; height: 100%; background: var(--vscode-progressBar-background); transition: width .12s linear; } .loading { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.diff.selected > .file-header { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
</style></head><body><header id="toolbar"><span id="title">Gitk Diff</span><span id="hash"></span><span id="toolbar-spacer"></span><button id="previousChange" class="toolbar-button" title="上一个修改点" aria-label="上一个修改点">↑</button><button id="nextChange" class="toolbar-button" title="下一个修改点" aria-label="下一个修改点">↓</button><button id="layout" class="toolbar-button" title="切换并排 / 内联差异">并排</button></header><section id="loadingView" class="empty"><span class="loading"></span><span id="loadingText">正在准备 Diff...</span><div id="progressTrack"><div id="progressBar"></div></div></section><main id="list" hidden></main><script>
(function() {
  const vscode = acquireVsCodeApi(); const list = document.getElementById('list'); const loadingView = document.getElementById('loadingView'); const loadingText = document.getElementById('loadingText'); const progressBar = document.getElementById('progressBar'); const layoutButton = document.getElementById('layout'); const previousChangeButton = document.getElementById('previousChange'); const nextChangeButton = document.getElementById('nextChange');
  let files = []; let loaded = new Set(); let unified = false; let selectedPath = ''; let revealPath = ''; let generation = 0;
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function splitLines(text) { const lines = String(text || '').split(/\\r?\\n/); return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines; }
  function lineHtml(leftNumber, rightNumber, code, type, marker, change) { const attribute = change === undefined ? '' : ' data-change="' + change + '"'; return '<div class="line ' + type + '"' + attribute + '><span class="line-marker">' + (marker || '') + '</span><span class="line-number">' + (leftNumber || '') + '</span><span class="line-number">' + (rightNumber || '') + '</span><span class="line-code">' + (code === '' ? '&nbsp;' : escapeHtml(code)) + '</span></div>'; }
  function splitLineHtml(number, code, type, change) { const attribute = change === undefined ? '' : ' data-change="' + change + '"'; return '<div class="line ' + type + '"' + attribute + '><span class="line-number">' + (number || '') + '</span><span class="line-code">' + (code === '' ? '&nbsp;' : escapeHtml(code)) + '</span></div>'; }
  function calculateDiff(original, modified) {
    const left = splitLines(original); const right = splitLines(modified); const maxCells = 160000;
    if (left.length * right.length > maxCells) return { left: left.map(function(value, index) { return { value: value, number: index + 1, type: '' }; }), right: right.map(function(value, index) { return { value: value, number: index + 1, type: '' }; }) };
    const matrix = Array.from({ length: left.length + 1 }, function() { return new Uint32Array(right.length + 1); });
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    const rowsLeft = []; const rowsRight = []; let i = 0; let j = 0; let changeIndex = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { rowsLeft.push({ value: left[i], number: i + 1, type: '' }); rowsRight.push({ value: right[j], number: j + 1, type: '' }); i++; j++; continue; }
      const removed = []; const added = [];
      while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) break;
        if (j < right.length && (i === left.length || matrix[i][j + 1] >= matrix[i + 1][j])) { added.push({ value: right[j], number: j + 1 }); j++; }
        else { removed.push({ value: left[i], number: i + 1 }); i++; }
      }
      const paired = Math.min(removed.length, added.length); const change = changeIndex++;
      for (let row = 0; row < paired; row++) { rowsLeft.push({ value: removed[row].value, number: removed[row].number, type: 'modified-removed', change: change }); rowsRight.push({ value: added[row].value, number: added[row].number, type: 'modified-added', change: change }); }
      for (let row = paired; row < removed.length; row++) { rowsLeft.push({ value: removed[row].value, number: removed[row].number, type: 'removed', change: change }); rowsRight.push({ value: '', number: '', type: 'placeholder', change: change }); }
      for (let row = paired; row < added.length; row++) { rowsLeft.push({ value: '', number: '', type: 'placeholder', change: change }); rowsRight.push({ value: added[row].value, number: added[row].number, type: 'added', change: change }); }
    }
    return { left: rowsLeft, right: rowsRight };
  }
  function requestAll() { vscode.postMessage({ type: 'loadAll', generation: generation }); }
  let suppressViewportSyncUntil = 0;
  function revealDiffTarget(target) { const toolbarHeight = document.getElementById('toolbar').offsetHeight; const targetTop = target.getBoundingClientRect().top + window.scrollY; suppressViewportSyncUntil = performance.now() + 200; window.scrollTo({ top: Math.max(0, targetTop - toolbarHeight), behavior: 'auto' }); }
  function selectFile(path, reveal) { const file = files.find(function(item) { return item.path === path; }); if (!file) return; selectedPath = path; revealPath = path; document.querySelectorAll('.diff').forEach(function(item) { item.classList.toggle('selected', Number(item.dataset.index) === file.index); }); if (reveal) { const target = document.querySelector('[data-index="' + file.index + '"]'); if (target) revealDiffTarget(target); } }
  function syncSelectedFromViewport() { if (performance.now() < suppressViewportSyncUntil) return; const viewportTop = 105; const pointTarget = document.elementFromPoint(Math.max(1, Math.floor(window.innerWidth / 2)), viewportTop + 1); const firstVisible = pointTarget && pointTarget.closest('.diff') || Array.from(document.querySelectorAll('.diff')).find(function(item) { return item.getBoundingClientRect().bottom > viewportTop; }); if (!firstVisible) return; const index = Number(firstVisible.dataset.index); const file = files[index]; if (!file || file.path === selectedPath) return; selectFile(file.path, false); vscode.postMessage({ type: 'selectFile', path: file.path }); }
  let scrollFrame = 0; window.addEventListener('scroll', function() { if (scrollFrame) return; scrollFrame = requestAnimationFrame(function() { scrollFrame = 0; syncSelectedFromViewport(); }); }, { passive: true });
  function contextFoldHtml(start, end) { const count = end - start; return '<button class="context-fold" data-start="' + start + '" data-end="' + end + '">⌄ 展开 ' + count + ' 行未更改内容</button>'; }
  function renderRows(result, expandedRanges) {
    let leftRows = ''; let rightRows = ''; let unifiedRows = ''; let index = 0;
    while (index < result.left.length) {
      const left = result.left[index]; const right = result.right[index]; const unchanged = !left.type && !right.type;
      if (unchanged) {
        let end = index + 1;
        while (end < result.left.length && !result.left[end].type && !result.right[end].type) end++;
        const rangeKey = index + ':' + end; const expanded = expandedRanges.has(rangeKey); const showLeading = index === 0 ? 0 : 5; const showTrailing = end === result.left.length ? 0 : 5;
        const leadingEnd = expanded ? end : Math.min(end, index + showLeading);
        const trailingStart = expanded ? end : Math.max(leadingEnd, end - showTrailing);
        for (let rowIndex = index; rowIndex < leadingEnd; rowIndex++) {
          const currentLeft = result.left[rowIndex]; const currentRight = result.right[rowIndex]; leftRows += splitLineHtml(currentLeft.number, currentLeft.value, ''); rightRows += splitLineHtml(currentRight.number, currentRight.value, ''); unifiedRows += lineHtml(currentLeft.number, currentRight.number, currentLeft.value, '', '');
        }
        if (!expanded && trailingStart > leadingEnd) { leftRows += contextFoldHtml(index, end); rightRows += contextFoldHtml(index, end); unifiedRows += contextFoldHtml(index, end); }
        for (let rowIndex = trailingStart; rowIndex < end; rowIndex++) {
          const currentLeft = result.left[rowIndex]; const currentRight = result.right[rowIndex]; leftRows += splitLineHtml(currentLeft.number, currentLeft.value, ''); rightRows += splitLineHtml(currentRight.number, currentRight.value, ''); unifiedRows += lineHtml(currentLeft.number, currentRight.number, currentLeft.value, '', '');
        }
        index = end;
      } else {
        const change = left.change === undefined ? right.change : left.change;
        leftRows += splitLineHtml(left.number, left.value, left.type, change); rightRows += splitLineHtml(right.number, right.value, right.type, change);
        if (left.type === 'removed') unifiedRows += lineHtml(left.number, '', left.value, 'removed', '−', change);
        else if (right.type === 'added') unifiedRows += lineHtml('', right.number, right.value, 'added', '+', change);
        else if (left.type === 'modified-removed') { unifiedRows += lineHtml(left.number, '', left.value, 'modified-removed', '−', change); unifiedRows += lineHtml('', right.number, right.value, 'modified-added', '+', change); }
        index++;
      }
    }
    return { leftRows: leftRows, rightRows: rightRows, unifiedRows: unifiedRows };
  }
  function renderDiff(diff, expandedRanges) {
    loaded.add(diff.index); const holder = document.querySelector('[data-index="' + diff.index + '"]'); if (!holder) return;
    const oldLabel = diff.status === 'A' ? '/dev/null' : (diff.oldPath || diff.path); const newLabel = diff.status === 'D' ? '/dev/null' : diff.path;
    if (diff.error) {
      const unavailable = '<div class="empty">无法读取文件内容：' + escapeHtml(diff.error) + '</div>';
      holder.innerHTML = '<button class="file-header"><span class="chevron">⌄</span><span class="status status-' + escapeHtml(diff.status) + '">' + escapeHtml(diff.status) + '</span><span class="file-path">' + escapeHtml(diff.path) + '</span>' + (diff.oldPath ? '<span class="rename">← ' + escapeHtml(diff.oldPath) + '</span>' : '') + '</button><div class="editor"><div class="split' + (unified ? ' unified' : '') + '"><section class="pane left-pane"><span class="pane-title">' + escapeHtml(oldLabel) + '</span>' + unavailable + '</section><section class="pane right-pane"><span class="pane-title">' + escapeHtml(newLabel) + '</span>' + unavailable + '</section><section class="unified-pane"><span class="pane-title">' + escapeHtml(diff.path) + '</span>' + unavailable + '</section></div></div>';
      holder.querySelector('.file-header').addEventListener('click', function() { revealDiffTarget(holder); });
      return;
    }
    const result = calculateDiff(diff.original, diff.modified); const rows = renderRows(result, expandedRanges || new Set());
    holder.innerHTML = '<button class="file-header"><span class="chevron">⌄</span><span class="status status-' + escapeHtml(diff.status) + '">' + escapeHtml(diff.status) + '</span><span class="file-path">' + escapeHtml(diff.path) + '</span>' + (diff.oldPath ? '<span class="rename">← ' + escapeHtml(diff.oldPath) + '</span>' : '') + '</button><div class="editor"><div class="split' + (unified ? ' unified' : '') + '"><section class="pane left-pane"><span class="pane-title">' + escapeHtml(oldLabel) + '</span>' + rows.leftRows + '</section><section class="pane right-pane"><span class="pane-title">' + escapeHtml(newLabel) + '</span>' + rows.rightRows + '</section><section class="unified-pane"><span class="pane-title">' + escapeHtml(diff.path) + '</span>' + rows.unifiedRows + '</section></div></div>';
    holder.querySelector('.file-header').addEventListener('click', function() { revealDiffTarget(holder); });
    holder.querySelectorAll('.context-fold').forEach(function(button) { button.addEventListener('click', function(event) { event.stopPropagation(); const start = button.dataset.start; const end = button.dataset.end; const expanded = expandedRanges || new Set(); expanded.add(start + ':' + end); renderDiff(diff, expanded); }); });
  }
  function renderAllDiffs(diffs) {
    let index = 0;
    function renderNext() {
      if (index >= diffs.length) {
        loadingView.style.display = 'none';
        list.hidden = false;
        const target = files.find(function(file) { return file.path === revealPath; });
        if (target) { selectFile(target.path, true); } else if (files.length) { selectFile(files[0].path, false); vscode.postMessage({ type: 'selectFile', path: files[0].path }); }
        return;
      }
      renderDiff(diffs[index++]);
      loadingText.textContent = '正在生成 Diff：' + index + ' / ' + diffs.length;
      progressBar.style.width = (index / diffs.length * 100) + '%';
      requestAnimationFrame(renderNext);
    }
    requestAnimationFrame(renderNext);
  }
  function updateLayout() { document.querySelectorAll('.split').forEach(function(element) { element.classList.toggle('unified', unified); }); layoutButton.textContent = unified ? '内联' : '并排'; layoutButton.classList.toggle('active', unified); }
  function changeTargets() {
    const paneSelector = unified ? '.unified-pane' : '.left-pane, .right-pane';
    const targets = [];
    document.querySelectorAll('.diff').forEach(function(diff) {
      const hunks = new Map();
      diff.querySelectorAll(paneSelector + ' .line[data-change]:not(.placeholder)').forEach(function(line) {
        const change = line.dataset.change; const current = hunks.get(change);
        if (!current || line.getBoundingClientRect().top < current.getBoundingClientRect().top) hunks.set(change, line);
      });
      hunks.forEach(function(line) { targets.push(line); });
    });
    return targets.sort(function(left, right) { return left.getBoundingClientRect().top - right.getBoundingClientRect().top; });
  }
  function navigateChange(direction) {
    const targets = changeTargets(); if (!targets.length) return;
    const toolbarHeight = document.getElementById('toolbar').offsetHeight; const current = window.scrollY + toolbarHeight;
    let target = direction > 0
      ? targets.find(function(item) { return item.getBoundingClientRect().top + window.scrollY > current + 1; })
      : targets.slice().reverse().find(function(item) { return item.getBoundingClientRect().top + window.scrollY < current - 1; });
    if (!target) target = direction > 0 ? targets[0] : targets[targets.length - 1];
    const diff = target.closest('.diff'); const index = diff && Number(diff.dataset.index); const file = files[index];
    if (file) { selectFile(file.path, false); vscode.postMessage({ type: 'selectFile', path: file.path }); }
    suppressViewportSyncUntil = performance.now() + 300;
    window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - toolbarHeight), behavior: 'smooth' });
  }
  previousChangeButton.addEventListener('click', function() { navigateChange(-1); });
  nextChangeButton.addEventListener('click', function() { navigateChange(1); });
  layoutButton.addEventListener('click', function() { unified = !unified; updateLayout(); });
  window.addEventListener('message', function(event) { const message = event.data; if (message.type === 'reset') { generation = message.generation; files = message.files || []; loaded = new Set(); selectedPath = ''; revealPath = message.revealPath || ''; document.getElementById('hash').textContent = message.hash ? '(' + message.hash.slice(0, 8) + ')' : ''; loadingView.hidden = false; loadingView.style.display = 'block'; loadingText.textContent = '正在准备 Diff：0 / ' + files.length; progressBar.style.width = '0%'; list.hidden = true; list.innerHTML = files.map(function(file) { return '<section class="diff" data-index="' + file.index + '"></section>'; }).join(''); requestAll(); } else if (message.type === 'progress' && message.generation === generation) { const total = Number(message.total) || 0; const completed = Number(message.completed) || 0; loadingText.textContent = '正在准备 Diff：' + completed + ' / ' + total; progressBar.style.width = (total ? completed / total * 100 : 100) + '%'; } else if (message.type === 'selectFile') { selectFile(message.path, true); } else if (message.type === 'diffs' && message.generation === generation) { renderAllDiffs(message.diffs || []); } });
})();</script></body></html>`;
    }
}
