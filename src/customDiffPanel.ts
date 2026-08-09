import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { ChangeSetMode, CommitFile } from './gitLogProvider';

interface DiffPayload {
    index: number;
    path: string;
    fullPath: string;
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
    private childProcess?: ChildProcess;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly onSelectFile: (path: string) => void,
    ) {}

    async show(rootUri: vscode.Uri, hash: string, files: CommitFile[], revealPath?: string, changeSetMode: ChangeSetMode = 'commit'): Promise<void> {
        const isSameCommit = this.panel && this.rootUri?.toString() === rootUri.toString() && this.hash === hash && this.changeSetMode === changeSetMode;
        if (!isSameCommit) {
            this.requestGeneration++;
            // 终止旧 git cat-file 进程
            if (this.childProcess) {
                try { this.childProcess.kill(); } catch { /* 已退出 */ }
                this.childProcess = undefined;
            }
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
                this.panel.onDidDispose(() => {
                    this.panel = undefined;
                    this.stopChildProcess();
                    // 清理已释放的面板级 disposable, 避免数组无限增长
                    vscode.Disposable.from(...this.disposables).dispose();
                    this.disposables.length = 0;
                }),
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
            try {
                await this.readAllDiffsIncrementally(generation);
            } catch {
                // 请求被取消或失败, 忽略 (generation 不匹配时已被新请求取代)
            }
        } else if (payload.type === 'selectFile' && typeof payload.path === 'string') {
            this.onSelectFile(payload.path);
        }
    }

    private async readAllDiffsIncrementally(generation: number): Promise<void> {
        const batchSize = 20;
        const total = this.files.length;
        for (let start = 0; start < total; start += batchSize) {
            const files = this.files.slice(start, start + batchSize);
            const diffs = await this.readDiffs(files, start);
            if (generation !== this.requestGeneration) { return; }
            await this.panel?.webview.postMessage({ type: 'diffs', generation, diffs, append: start > 0 });
            await this.panel?.webview.postMessage({ type: 'progress', generation, completed: Math.min(start + files.length, total), total });
        }
    }

    private async readAllDiffs(): Promise<DiffPayload[]> {
        return this.readDiffs(this.files);
    }

    private async readDiffs(files: CommitFile[], indexOffset = 0): Promise<DiffPayload[]> {
        if (!this.rootUri) { throw new Error('未找到 Git 仓库'); }
        if (this.changeSetMode !== 'commit') {
            return this.readWorkingTreeDiffs(files, indexOffset);
        }
        const objects: string[] = [];
        for (const file of files) {
            if (file.status !== 'A') { objects.push(`${this.hash}^:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { objects.push(`${this.hash}:${file.path}`); }
        }
        const contents = await this.readGitObjects(objects);
        return files.map((file, index) => {
            const originalObject = file.status === 'A' ? undefined : `${this.hash}^:${file.oldPath || file.path}`;
            const modifiedObject = file.status === 'D' ? undefined : `${this.hash}:${file.path}`;
            const original = originalObject ? contents.get(originalObject) : '';
            const modified = modifiedObject ? contents.get(modifiedObject) : '';
            const missing = [originalObject, modifiedObject].find(object => object && !contents.has(object));
            return { index: index + indexOffset, path: file.path, fullPath: path.join(this.rootUri!.fsPath, file.path), oldPath: file.oldPath, status: file.status, original: original || '', modified: modified || '', error: missing ? `无法读取 Git 对象：${missing}` : undefined };
        });
    }

    private async readWorkingTreeDiffs(files = this.files, indexOffset = 0): Promise<DiffPayload[]> {
        const originalRef = this.changeSetMode === 'staged' ? 'HEAD' : '';
        const objects: string[] = [];
        for (const file of files) {
            if (file.status !== 'A') { objects.push(`${originalRef}:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { objects.push(`:${file.path}`); }
        }
        const contents = await this.readGitObjects(objects);
        return Promise.all(files.map(async (file, index) => {
            const originalObject = file.status === 'A' ? undefined : `${originalRef}:${file.oldPath || file.path}`;
            const modifiedObject = file.status === 'D' ? undefined : `:${file.path}`;
            const original = originalObject ? contents.get(originalObject) || '' : '';
            const modified = this.changeSetMode === 'staged'
                ? (modifiedObject ? contents.get(modifiedObject) || '' : '')
                : await this.readWorkspaceFile(file.path);
            return { index: index + indexOffset, path: file.path, fullPath: path.join(this.rootUri!.fsPath, file.path), oldPath: file.oldPath, status: file.status, original, modified };
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
            this.childProcess = child;
            const chunks: Buffer[] = [];
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
            child.on('error', err => {
                if (this.childProcess === child) { this.childProcess = undefined; }
                reject(err);
            });
            child.on('close', code => {
                if (this.childProcess === child) { this.childProcess = undefined; }
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

    private stopChildProcess(): void {
        if (this.childProcess) {
            try { this.childProcess.kill(); } catch { /* 已退出 */ }
            this.childProcess = undefined;
        }
    }

    hide(): void {
        this.requestGeneration++;
        this.stopChildProcess();
        this.panel?.dispose();
    }

    dispose(): void {
        this.stopChildProcess();
        this.panel?.dispose();
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables.length = 0;
    }

    private getHtml(): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
:root { color-scheme: light dark; --font-family: var(--vscode-editor-font-family); --font-size: var(--vscode-editor-font-size); --font-weight: var(--vscode-editor-font-weight); --line-height: var(--vscode-editor-line-height, 19px); } * { box-sizing: border-box; } body { margin: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); } button { font: inherit; } #toolbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; min-height: 35px; padding: 0 8px; color: var(--vscode-editor-foreground); border-bottom: 1px solid var(--vscode-editorGroup-border); background: var(--vscode-editor-background); } #title, #hash { color: var(--vscode-descriptionForeground); } #toolbar-spacer { flex: 1; } .toolbar-button { padding: 3px 8px; border: 0; border-radius: 0; color: var(--vscode-foreground); background: transparent; cursor: pointer; } .toolbar-button:hover, .toolbar-button.active { color: var(--vscode-toolbar-hoverForeground); background: var(--vscode-toolbar-hoverBackground); } .toolbar-button:disabled { cursor: default; opacity: .45; } .toolbar-button:disabled:hover { color: var(--vscode-foreground); background: transparent; } #list { padding: 0; } .diff { margin: 0; border-bottom: 1px solid var(--vscode-editorGroup-border); background: var(--vscode-editor-background); } .file-header { position: sticky; top: 35px; z-index: 2; width: 100%; min-height: 32px; display: flex; align-items: center; gap: 7px; margin: 4px 0; padding: 0 7px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 5px; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); box-shadow: 0 1px 4px rgba(0, 0, 0, .07); cursor: pointer; font-size: calc(var(--font-size) * .89); text-align: left; } .status { min-width: 15px; color: var(--vscode-gitDecoration-modifiedResourceForeground); font-weight: var(--font-weight); } .status-A { color: var(--vscode-gitDecoration-addedResourceForeground); } .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); } .status-M, .status-R { color: var(--vscode-gitDecoration-modifiedResourceForeground); } .file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rename { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; } .editor { width: 100%; overflow: hidden; background: var(--vscode-editor-background); } .split { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: stretch; } .split.unified { display: block; min-width: 0; } .pane { min-width: 0; overflow-x: auto; overflow-y: hidden; border-right: 1px solid var(--vscode-editorGroup-border); } .right-pane { border-right: 0; } .unified-pane { display: none; } .unified .pane { display: none; } .unified .unified-pane { display: block; } .pane-title { box-sizing: border-box; display: block; height: 25px; padding: 4px 8px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editorGroup-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .line { box-sizing: border-box; width: max-content; min-width: 100%; height: var(--line-height); min-height: var(--line-height); display: grid; grid-template-columns: 52px minmax(max-content, 1fr); color: var(--vscode-editor-foreground); font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); line-height: var(--line-height); white-space: pre; } .unified .line { grid-template-columns: 18px 52px 52px minmax(max-content, 1fr); } .line-number, .line-marker { color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background); user-select: none; } .line-number { padding-right: 8px; text-align: right; } .line-marker { text-align: center; } .line-code { min-width: 0; padding: 0 8px; overflow: hidden; text-overflow: clip; } .line:not(.placeholder) .line-code { cursor: text; } .change-block { overflow: hidden; } .removed-block { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .20)); } .added-block { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0, 155, 0, .20)); } .modified-block { background: var(--vscode-diffEditor-unchangedCodeBackground, rgba(86, 156, 214, .14)); } .change-block .removed, .change-block .added, .change-block .modified-removed, .change-block .modified-added, .change-block .line-number, .change-block .line-marker, .change-block .line-code { background: transparent; border-color: transparent; } .removed .line-number, .removed .line-marker { background: var(--vscode-diffEditorGutter-removedLineBackground, var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .20))); } .added .line-number, .added .line-marker { background: var(--vscode-diffEditorGutter-insertedLineBackground, var(--vscode-diffEditor-insertedLineBackground, rgba(0, 155, 0, .20))); } .modified-removed .line-number, .modified-added .line-number { background: var(--vscode-diffEditor-unchangedCodeBackground, rgba(86, 156, 214, .14)); } .removed .line-code { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); border: 1px solid var(--vscode-diffEditor-removedTextBorder, transparent); } .added .line-code { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 155, 0, .35)); border: 1px solid var(--vscode-diffEditor-insertedTextBorder, transparent); } .modified-removed .line-code, .modified-added .line-code { background: transparent; border: 0; } .change-block .line-number, .change-block .line-marker, .change-block .line-code { background: transparent; border-color: transparent; } .change-block .removed .line-code { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); border-color: var(--vscode-diffEditor-removedTextBorder, transparent); } .change-block .added .line-code { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 155, 0, .35)); border-color: var(--vscode-diffEditor-insertedTextBorder, transparent); } .empty-line { color: transparent; } .placeholder { background-image: linear-gradient(-45deg, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 12.5%, transparent 12.5%, transparent 50%, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 50%, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 62.5%, transparent 62.5%, transparent 100%); background-size: 8px 8px; } .placeholder .line-number, .placeholder .line-code { background-color: transparent; } .context-fold { position: relative; width: 100%; height: 24px; border: 0; color: var(--vscode-diffEditor-unchangedRegionForeground, var(--vscode-editorCodeLens-foreground)); background: var(--vscode-diffEditor-unchangedRegionBackground, transparent); font-family: var(--font-family); font-size: 13px; line-height: 14px; opacity: .5; user-select: none; } .context-fold-center { position: absolute; inset: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; box-shadow: inset 0 -5px 5px -7px var(--vscode-diffEditor-unchangedRegionShadow), inset 0 5px 5px -7px var(--vscode-diffEditor-unchangedRegionShadow); } .context-fold:hover, .context-fold:focus-within { opacity: 1; } .context-fold-unfold { padding: 0; border: 0; color: inherit; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; } .context-fold-label { overflow: hidden; text-overflow: ellipsis; cursor: default; } .context-fold-label:hover { text-decoration: underline; } .context-fold-edge { position: absolute; z-index: 1; left: 0; width: 100%; height: 4px; padding: 0; border: 0; background: transparent; cursor: ns-resize; } .context-fold-edge:hover { background: var(--vscode-focusBorder); } .context-fold-top { top: 0; } .context-fold-bottom { bottom: 0; } .context-fold button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; } .empty { padding: 16px 8px; color: var(--vscode-descriptionForeground); text-align: center; } #loadingView { padding-top: 32px; } #progressTrack { width: min(360px, calc(100vw - 48px)); height: 4px; margin: 12px auto 0; overflow: hidden; background: var(--vscode-progressBar-background); } #progressBar { width: 0; height: 100%; background: var(--vscode-progressBar-background); transition: width .12s linear; } .loading { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.diff.selected > .file-header { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; } .change-block.change-reveal { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; animation: change-reveal 1s ease-out forwards; } .line.change-cursor .line-code { position: relative; } .line.change-cursor .line-code::before { content: ''; position: absolute; top: 2px; bottom: 2px; left: var(--cursor-x, 8px); width: 1px; background: var(--vscode-editorCursor-foreground, var(--vscode-focusBorder)); animation: cursor-blink 1s steps(1, end) infinite; } @keyframes change-reveal { from { background-color: var(--vscode-editor-selectionBackground); } to { background-color: transparent; outline-color: transparent; } } @keyframes cursor-blink { 50% { opacity: 0; } }
</style></head><body><header id="toolbar"><span id="title">Gitk Diff</span><span id="hash"></span><span id="toolbar-spacer"></span><button id="previousChange" class="toolbar-button" title="上一个修改点" aria-label="上一个修改点">↑</button><button id="nextChange" class="toolbar-button" title="下一个修改点" aria-label="下一个修改点">↓</button><button id="layout" class="toolbar-button" title="切换并排 / 内联差异">并排</button></header><section id="loadingView" class="empty"><span class="loading"></span><span id="loadingText">正在准备 Diff...</span><div id="progressTrack"><div id="progressBar"></div></div></section><main id="list" hidden></main><script>
(function() {
  const vscode = acquireVsCodeApi(); const list = document.getElementById('list'); const loadingView = document.getElementById('loadingView'); const loadingText = document.getElementById('loadingText'); const progressBar = document.getElementById('progressBar'); const layoutButton = document.getElementById('layout'); const previousChangeButton = document.getElementById('previousChange'); const nextChangeButton = document.getElementById('nextChange');
  let files = []; let loaded = new Set(); let unified = false; let selectedPath = ''; let revealPath = ''; let generation = 0;
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function splitLines(text) { const lines = String(text || '').split(/\\r?\\n/); return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines; }
  function lineHtml(leftNumber, rightNumber, code, type, marker, change) { const attribute = change === undefined ? '' : ' data-change="' + change + '"'; return '<div class="line ' + type + '"' + attribute + '><span class="line-marker">' + (marker || '') + '</span><span class="line-number">' + (leftNumber || '') + '</span><span class="line-number">' + (rightNumber || '') + '</span><span class="line-code">' + (code === '' ? '&nbsp;' : escapeHtml(code)) + '</span></div>'; }
  function splitLineHtml(number, code, type, change) { const attribute = change === undefined ? '' : ' data-change="' + change + '"'; return '<div class="line ' + type + '"' + attribute + '><span class="line-number">' + (number || '') + '</span><span class="line-code">' + (code === '' ? '&nbsp;' : escapeHtml(code)) + '</span></div>'; }
  function calculateDiff(original, modified) {
    const left = splitLines(original); const right = splitLines(modified); const maxCells = 160000; const rowsLeft = []; const rowsRight = []; let changeIndex = 0;
    function unchanged(leftIndex, rightIndex) { rowsLeft.push({ value: left[leftIndex], number: leftIndex + 1, type: '' }); rowsRight.push({ value: right[rightIndex], number: rightIndex + 1, type: '' }); }
    function changed(removed, added) { const paired = removed.length === added.length ? removed.length : 0; const change = changeIndex++; for (let row = 0; row < paired; row++) { rowsLeft.push({ value: left[removed[row]], number: removed[row] + 1, type: 'modified-removed', change: change }); rowsRight.push({ value: right[added[row]], number: added[row] + 1, type: 'modified-added', change: change }); } for (let row = paired; row < removed.length; row++) { rowsLeft.push({ value: left[removed[row]], number: removed[row] + 1, type: 'removed', change: change }); rowsRight.push({ value: '', number: '', type: 'placeholder', change: change }); } for (let row = paired; row < added.length; row++) { rowsLeft.push({ value: '', number: '', type: 'placeholder', change: change }); rowsRight.push({ value: right[added[row]], number: added[row] + 1, type: 'added', change: change }); } }
    function exact(leftStart, leftEnd, rightStart, rightEnd) { const height = leftEnd - leftStart; const width = rightEnd - rightStart; const matrix = Array.from({ length: height + 1 }, function() { return new Uint32Array(width + 1); }); for (let i = height - 1; i >= 0; i--) for (let j = width - 1; j >= 0; j--) matrix[i][j] = left[leftStart + i] === right[rightStart + j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]); let i = 0; let j = 0; while (i < height || j < width) { if (i < height && j < width && left[leftStart + i] === right[rightStart + j]) { unchanged(leftStart + i++, rightStart + j++); continue; } const removed = []; const added = []; while (i < height || j < width) { if (i < height && j < width && left[leftStart + i] === right[rightStart + j]) break; if (j < width && (i === height || matrix[i][j + 1] >= matrix[i + 1][j])) added.push(rightStart + j++); else removed.push(leftStart + i++); } changed(removed, added); } }
    function fallback(leftStart, leftEnd, rightStart, rightEnd) { const originalLeftEnd = leftEnd; const originalRightEnd = rightEnd; let prefix = 0; while (leftStart + prefix < leftEnd && rightStart + prefix < rightEnd && left[leftStart + prefix] === right[rightStart + prefix]) { unchanged(leftStart + prefix, rightStart + prefix); prefix++; } while (leftEnd > leftStart + prefix && rightEnd > rightStart + prefix && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; } changed(Array.from({ length: leftEnd - leftStart - prefix }, function(_, index) { return leftStart + prefix + index; }), Array.from({ length: rightEnd - rightStart - prefix }, function(_, index) { return rightStart + prefix + index; })); for (let index = 0; index < originalLeftEnd - leftEnd && leftEnd + index < originalLeftEnd && rightEnd + index < originalRightEnd; index++) unchanged(leftEnd + index, rightEnd + index); }
    function compare(leftStart, leftEnd, rightStart, rightEnd) { if ((leftEnd - leftStart) * (rightEnd - rightStart) <= maxCells) { exact(leftStart, leftEnd, rightStart, rightEnd); return; } const leftCounts = new Map(); const rightCounts = new Map(); for (let index = leftStart; index < leftEnd; index++) leftCounts.set(left[index], (leftCounts.get(left[index]) || 0) + 1); for (let index = rightStart; index < rightEnd; index++) rightCounts.set(right[index], (rightCounts.get(right[index]) || 0) + 1); const rightIndexes = new Map(); for (let index = rightStart; index < rightEnd; index++) if (rightCounts.get(right[index]) === 1) rightIndexes.set(right[index], index); const candidates = []; for (let index = leftStart; index < leftEnd; index++) if (leftCounts.get(left[index]) === 1 && rightIndexes.has(left[index])) candidates.push([index, rightIndexes.get(left[index])]); const tails = []; const previous = new Array(candidates.length); for (let index = 0; index < candidates.length; index++) { let low = 0; let high = tails.length; while (low < high) { const middle = (low + high) >> 1; if (candidates[tails[middle]][1] < candidates[index][1]) low = middle + 1; else high = middle; } previous[index] = low ? tails[low - 1] : -1; tails[low] = index; } if (!tails.length) { fallback(leftStart, leftEnd, rightStart, rightEnd); return; } const anchors = []; for (let index = tails[tails.length - 1]; index >= 0; index = previous[index]) anchors.unshift(candidates[index]); let currentLeft = leftStart; let currentRight = rightStart; anchors.forEach(function(anchor) { compare(currentLeft, anchor[0], currentRight, anchor[1]); unchanged(anchor[0], anchor[1]); currentLeft = anchor[0] + 1; currentRight = anchor[1] + 1; }); compare(currentLeft, leftEnd, currentRight, rightEnd); }
    compare(0, left.length, 0, right.length); return { left: rowsLeft, right: rowsRight };
  }
  function requestAll() { vscode.postMessage({ type: 'loadAll', generation: generation }); }
  let syncingPaneScroll = false;
  function syncPaneScroll(source) {
    if (unified || syncingPaneScroll) return;
    const diff = source.closest('.diff'); if (!diff) return;
    const peer = source.classList.contains('left-pane') ? diff.querySelector('.right-pane') : diff.querySelector('.left-pane');
    if (!peer || peer.scrollLeft === source.scrollLeft) return;
    syncingPaneScroll = true;
    peer.scrollLeft = source.scrollLeft;
    requestAnimationFrame(function() { syncingPaneScroll = false; });
  }
  list.addEventListener('scroll', function(event) {
    const source = event.target;
    if (source instanceof HTMLElement && source.classList.contains('pane')) syncPaneScroll(source);
  }, true);
  let suppressViewportSyncUntil = 0;
  function revealDiffTarget(target) { const toolbarHeight = document.getElementById('toolbar').offsetHeight; const targetTop = target.getBoundingClientRect().top + window.scrollY; suppressViewportSyncUntil = performance.now() + 200; window.scrollTo({ top: Math.max(0, targetTop - toolbarHeight), behavior: 'auto' }); }
  function selectFile(path, reveal) { const file = files.find(function(item) { return item.path === path; }); if (!file) return; selectedPath = path; revealPath = path; document.querySelectorAll('.diff').forEach(function(item) { item.classList.toggle('selected', Number(item.dataset.index) === file.index); }); if (reveal) { const target = document.querySelector('[data-index="' + file.index + '"]'); if (target) revealDiffTarget(target); } }
  function syncSelectedFromViewport() { if (performance.now() < suppressViewportSyncUntil) return; const viewportTop = 105; const pointTarget = document.elementFromPoint(Math.max(1, Math.floor(window.innerWidth / 2)), viewportTop + 1); const firstVisible = pointTarget && pointTarget.closest('.diff') || Array.from(document.querySelectorAll('.diff')).find(function(item) { return item.getBoundingClientRect().bottom > viewportTop; }); if (!firstVisible) return; const index = Number(firstVisible.dataset.index); const file = files[index]; if (!file || file.path === selectedPath) return; selectFile(file.path, false); vscode.postMessage({ type: 'selectFile', path: file.path }); }
  let scrollFrame = 0; window.addEventListener('scroll', function() { if (scrollFrame) return; scrollFrame = requestAnimationFrame(function() { scrollFrame = 0; syncSelectedFromViewport(); }); }, { passive: true });
  function contextFoldHtml(start, end) { const count = end - start; return '<div class="context-fold" data-start="' + start + '" data-end="' + end + '"><button class="context-fold-edge context-fold-top" type="button" data-action="top" title="显示更多上方内容"></button><div class="context-fold-center"><button class="context-fold-unfold" type="button" data-action="all" title="显示未更改区域" aria-label="显示未更改区域">⌄</button><span class="context-fold-label" title="双击显示未更改区域">' + count + ' 个隐藏行</span></div><button class="context-fold-edge context-fold-bottom" type="button" data-action="bottom" title="显示更多下方内容"></button></div>'; }
  function renderRows(result, expandedRanges) {
    let leftRows = ''; let rightRows = ''; let unifiedRows = ''; let index = 0;
    while (index < result.left.length) {
      const left = result.left[index]; const right = result.right[index]; const unchanged = !left.type && !right.type;
      if (unchanged) {
        let end = index + 1;
        while (end < result.left.length && !result.left[end].type && !result.right[end].type) end++;
        const rangeKey = index + ':' + end; const expansion = expandedRanges.get(rangeKey) || { top: 0, bottom: 0, all: false }; const showLeading = index === 0 ? 0 : 5; const showTrailing = end === result.left.length ? 0 : 5;
        const leadingEnd = expansion.all ? end : Math.min(end - showTrailing, index + showLeading + expansion.top);
        const trailingStart = expansion.all ? end : Math.max(leadingEnd, end - showTrailing - expansion.bottom);
        for (let rowIndex = index; rowIndex < leadingEnd; rowIndex++) {
          const currentLeft = result.left[rowIndex]; const currentRight = result.right[rowIndex]; leftRows += splitLineHtml(currentLeft.number, currentLeft.value, ''); rightRows += splitLineHtml(currentRight.number, currentRight.value, ''); unifiedRows += lineHtml(currentLeft.number, currentRight.number, currentLeft.value, '', '');
        }
        if (!expansion.all && trailingStart > leadingEnd) { leftRows += contextFoldHtml(index, end); rightRows += contextFoldHtml(index, end); unifiedRows += contextFoldHtml(index, end); }
        for (let rowIndex = trailingStart; rowIndex < end; rowIndex++) {
          const currentLeft = result.left[rowIndex]; const currentRight = result.right[rowIndex]; leftRows += splitLineHtml(currentLeft.number, currentLeft.value, ''); rightRows += splitLineHtml(currentRight.number, currentRight.value, ''); unifiedRows += lineHtml(currentLeft.number, currentRight.number, currentLeft.value, '', '');
        }
        index = end;
      } else {
        const change = left.change === undefined ? right.change : left.change; let end = index + 1;
        while (end < result.left.length && (result.left[end].change === undefined ? result.right[end].change : result.left[end].change) === change) end++;
        let leftBlock = ''; let rightBlock = ''; let unifiedBlock = ''; let leftClass = ''; let rightClass = '';
        for (let rowIndex = index; rowIndex < end; rowIndex++) {
          const currentLeft = result.left[rowIndex]; const currentRight = result.right[rowIndex];
          leftBlock += splitLineHtml(currentLeft.number, currentLeft.value, currentLeft.type, change); rightBlock += splitLineHtml(currentRight.number, currentRight.value, currentRight.type, change);
          if (currentLeft.type === 'removed') unifiedBlock += lineHtml(currentLeft.number, '', currentLeft.value, 'removed', '−', change);
          else if (currentRight.type === 'added') unifiedBlock += lineHtml('', currentRight.number, currentRight.value, 'added', '+', change);
          else if (currentLeft.type === 'modified-removed') { unifiedBlock += lineHtml(currentLeft.number, '', currentLeft.value, 'modified-removed', '−', change); unifiedBlock += lineHtml('', currentRight.number, currentRight.value, 'modified-added', '+', change); }
          if (currentLeft.type === 'removed') leftClass = 'removed-block'; else if (currentLeft.type === 'modified-removed') leftClass = 'modified-block';
          if (currentRight.type === 'added') rightClass = 'added-block'; else if (currentRight.type === 'modified-added') rightClass = 'modified-block';
        }
        const unifiedClass = leftClass === 'modified-block' || rightClass === 'modified-block' ? 'modified-block' : (leftClass || rightClass);
        leftRows += '<div class="change-block ' + leftClass + '">' + leftBlock + '</div>'; rightRows += '<div class="change-block ' + rightClass + '">' + rightBlock + '</div>'; unifiedRows += '<div class="change-block ' + unifiedClass + '">' + unifiedBlock + '</div>';
        index = end;
      }
    }
    return { leftRows: leftRows, rightRows: rightRows, unifiedRows: unifiedRows };
  }
  function renderDiff(diff, expandedRanges) {
    loaded.add(diff.index); const holder = document.querySelector('[data-index="' + diff.index + '"]'); if (!holder) return;
    const oldLabel = diff.status === 'A' ? '/dev/null' : (diff.oldPath || diff.path); const newLabel = diff.status === 'D' ? '/dev/null' : diff.path;
    if (diff.error) {
      const unavailable = '<div class="empty">文件：' + escapeHtml(diff.fullPath) + '<br>无法读取原因：该文件无法进行内容对比</div>';
      holder.innerHTML = '<button class="file-header"><span class="status status-' + escapeHtml(diff.status) + '">' + escapeHtml(diff.status) + '</span><span class="file-path">' + escapeHtml(diff.path) + '</span>' + (diff.oldPath ? '<span class="rename">← ' + escapeHtml(diff.oldPath) + '</span>' : '') + '</button><div class="editor"><div class="split' + (unified ? ' unified' : '') + '"><section class="pane left-pane"><span class="pane-title">' + escapeHtml(oldLabel) + '</span>' + unavailable + '</section><section class="pane right-pane"><span class="pane-title">' + escapeHtml(newLabel) + '</span>' + unavailable + '</section><section class="unified-pane"><span class="pane-title">' + escapeHtml(diff.path) + '</span>' + unavailable + '</section></div></div>';
      holder.querySelector('.file-header').addEventListener('click', function() { revealDiffTarget(holder); });
      return;
    }
    const result = calculateDiff(diff.original, diff.modified); const rows = renderRows(result, expandedRanges || new Map());
    holder.innerHTML = '<button class="file-header"><span class="status status-' + escapeHtml(diff.status) + '">' + escapeHtml(diff.status) + '</span><span class="file-path">' + escapeHtml(diff.path) + '</span>' + (diff.oldPath ? '<span class="rename">← ' + escapeHtml(diff.oldPath) + '</span>' : '') + '</button><div class="editor"><div class="split' + (unified ? ' unified' : '') + '"><section class="pane left-pane"><span class="pane-title">' + escapeHtml(oldLabel) + '</span>' + rows.leftRows + '</section><section class="pane right-pane"><span class="pane-title">' + escapeHtml(newLabel) + '</span>' + rows.rightRows + '</section><section class="unified-pane"><span class="pane-title">' + escapeHtml(diff.path) + '</span>' + rows.unifiedRows + '</section></div></div>';
    holder.querySelector('.file-header').addEventListener('click', function() { revealDiffTarget(holder); });
    holder.querySelectorAll('.context-fold').forEach(function(fold) {
      function expand(action) { const start = fold.dataset.start; const end = fold.dataset.end; const key = start + ':' + end; const expanded = expandedRanges || new Map(); const state = expanded.get(key) || { top: 0, bottom: 0, all: false }; if (action === 'all') state.all = true; else state[action] += 10; expanded.set(key, state); renderDiff(diff, expanded); }
      fold.querySelectorAll('button').forEach(function(button) { button.addEventListener('click', function(event) { event.stopPropagation(); expand(button.dataset.action); }); });
      const label = fold.querySelector('.context-fold-label'); if (label) label.addEventListener('dblclick', function(event) { event.stopPropagation(); expand('all'); });
    });
  }
  function renderAllDiffs(diffs) {
    let index = 0;
    function renderNext() {
      if (index >= diffs.length) {
        loadingView.style.display = 'none';
        list.hidden = false;
        const target = files.find(function(file) { return file.path === revealPath; });
        if (target) { selectFile(target.path, true); } else if (files.length && loaded.size === files.length) { selectFile(files[0].path, false); vscode.postMessage({ type: 'selectFile', path: files[0].path }); }
        updateNavigationButtons(changeTargets(), -1);
        return;
      }
      renderDiff(diffs[index++]);
      loadingView.style.display = 'none';
      list.hidden = false;
      requestAnimationFrame(renderNext);
    }
    requestAnimationFrame(renderNext);
  }
  function updateLayout() { document.querySelectorAll('.split').forEach(function(element) { element.classList.toggle('unified', unified); }); layoutButton.textContent = unified ? '内联' : '并排'; layoutButton.classList.toggle('active', unified); }
  function changeTargets() {
    const lineSelector = unified
      ? '.unified-pane .line[data-change]:not(.placeholder)'
      : '.left-pane .line[data-change]:not(.placeholder), .right-pane .line[data-change]:not(.placeholder)';
    const targets = [];
    document.querySelectorAll('.diff').forEach(function(diff) {
      const hunks = new Map();
      diff.querySelectorAll(lineSelector).forEach(function(line) {
        const change = line.dataset.change; const current = hunks.get(change);
        if (!current || line.getBoundingClientRect().top < current.getBoundingClientRect().top) hunks.set(change, line);
      });
      hunks.forEach(function(line) { targets.push(line); });
    });
    return targets.sort(function(left, right) { return left.getBoundingClientRect().top - right.getBoundingClientRect().top; });
  }
  let lastChangeTarget = null;
  let lastChangeKey = '';
  function targetKey(target) { const diff = target.closest('.diff'); return diff ? diff.dataset.index + ':' + target.dataset.change : ''; }
  function clearChangeReveal(event) {
    const target = event.target;
    if (target && target.classList && target.classList.contains('change-reveal')) target.classList.remove('change-reveal');
  }
  document.addEventListener('animationend', clearChangeReveal);
  document.addEventListener('animationcancel', clearChangeReveal);
  function highlightChangeTarget(target) {
    document.querySelectorAll('.change-block.change-reveal, .line.change-cursor').forEach(function(item) { item.classList.remove('change-reveal', 'change-cursor'); });
    const diff = target.closest('.diff'); const change = target.dataset.change;
    const related = diff ? Array.from(diff.querySelectorAll('.change-block')).filter(function(block) { return block.querySelector('.line[data-change="' + change + '"]'); }) : [target.closest('.change-block')];
    related.forEach(function(item) { if (item) item.classList.add('change-reveal'); });
    const cursorTarget = target.classList.contains('placeholder') ? Array.from(related).map(function(block) { return block && block.querySelector('.line[data-change="' + change + '"]:not(.placeholder)'); }).find(Boolean) : target;
    if (cursorTarget) cursorTarget.classList.add('change-cursor');
  }
  function updateNavigationButtons(targets, currentIndex) {
    previousChangeButton.disabled = !targets.length || currentIndex <= 0;
    nextChangeButton.disabled = !targets.length || currentIndex >= targets.length - 1;
  }
  function navigateChange(direction) {
    const targets = changeTargets(); if (!targets.length) { updateNavigationButtons(targets, -1); return; }
    let currentIndex = targets.findIndex(function(target) { return targetKey(target) === lastChangeKey; });
    if (currentIndex < 0) {
      const toolbarHeight = document.getElementById('toolbar').offsetHeight; const pinnedOffset = 40; const visibleTargetTop = toolbarHeight + pinnedOffset;
      currentIndex = direction > 0
        ? targets.reduce(function(found, item, index) { return item.getBoundingClientRect().top <= visibleTargetTop + 1 ? index : found; }, -1)
        : targets.findIndex(function(item) { return item.getBoundingClientRect().top >= visibleTargetTop - 1; });
      if (currentIndex < 0) currentIndex = direction > 0 ? -1 : targets.length;
    }
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= targets.length) { updateNavigationButtons(targets, currentIndex); return; }
    const target = targets[nextIndex];
    lastChangeTarget = target; lastChangeKey = targetKey(target); updateNavigationButtons(targets, nextIndex);
    const diff = target.closest('.diff'); const index = diff && Number(diff.dataset.index); const file = files[index];
    if (file) { selectFile(file.path, false); vscode.postMessage({ type: 'selectFile', path: file.path }); }
    highlightChangeTarget(target);
    const toolbarHeight = document.getElementById('toolbar').offsetHeight; const header = diff && diff.querySelector('.file-header'); const headerHeight = header ? header.offsetHeight + 4 : 0; const targetHeight = target.getBoundingClientRect().height;
    const visibleTop = toolbarHeight + headerHeight; const visibleHeight = Math.max(targetHeight, window.innerHeight - visibleTop);
    suppressViewportSyncUntil = performance.now() + 300;
    window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - visibleTop - (visibleHeight - targetHeight) / 2), behavior: 'auto' });
  }
  previousChangeButton.addEventListener('click', function() { navigateChange(-1); });
  nextChangeButton.addEventListener('click', function() { navigateChange(1); });
  layoutButton.addEventListener('click', function() { unified = !unified; lastChangeTarget = null; lastChangeKey = ''; updateLayout(); updateNavigationButtons(changeTargets(), -1); });
  document.addEventListener('click', function(event) {
    const element = event.target instanceof Element ? event.target : null; const line = element && element.closest('.line');
    if (!line || line.classList.contains('placeholder')) return;
    const code = line.querySelector('.line-code'); if (!code) return;
    document.querySelectorAll('.line.change-cursor').forEach(function(item) { item.classList.remove('change-cursor'); });
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
    const codeRect = code.getBoundingClientRect(); const text = code.textContent || ''; const textRange = document.createRange(); textRange.selectNodeContents(code); const textRect = textRange.getBoundingClientRect(); let offset = 8;
    const clickedCode = element.closest('.line-code');
    if (!clickedCode || (text && event.clientX >= textRect.right)) offset = Math.max(8, textRect.right - codeRect.left);
    else if (range && code.contains(range.startContainer)) {
      const caret = document.createRange(); caret.setStart(code, 0); caret.setEnd(range.startContainer, range.startOffset);
      const caretRect = caret.getBoundingClientRect();
      offset = Math.max(8, caretRect.right ? caretRect.right - codeRect.left : 8);
    }
    line.classList.add('change-cursor'); code.style.setProperty('--cursor-x', offset + 'px');
  });
  window.addEventListener('message', function(event) { const message = event.data; if (message.type === 'reset') { generation = message.generation; files = message.files || []; loaded = new Set(); selectedPath = ''; revealPath = message.revealPath || ''; lastChangeTarget = null; updateNavigationButtons([], -1); document.getElementById('hash').textContent = message.hash ? '(' + message.hash.slice(0, 8) + ')' : ''; loadingView.hidden = false; loadingView.style.display = 'block'; loadingText.textContent = '正在准备 Diff：已处理 0 / ' + files.length + ' 个文件'; progressBar.style.width = '0%'; list.hidden = true; list.innerHTML = files.map(function(file) { return '<section class="diff" data-index="' + file.index + '"></section>'; }).join(''); requestAll(); } else if (message.type === 'progress' && message.generation === generation) { const total = Number(message.total) || 0; const completed = Number(message.completed) || 0; loadingText.textContent = '正在准备 Diff：已处理 ' + completed + ' / ' + total + ' 个文件'; progressBar.style.width = (total ? completed / total * 100 : 100) + '%'; } else if (message.type === 'selectFile') { selectFile(message.path, true); } else if (message.type === 'diffs' && message.generation === generation) { renderAllDiffs(message.diffs || []); if (message.append) { return; } } });
})();</script></body></html>`;
    }
}
