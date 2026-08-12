import * as vscode from 'vscode';
import type { ChangeSetMode, ChangedFile, DiffPayload } from '../types';
import { store } from '../state/store';

// 自定义 Diff 面板，按需读取文件，并使用接近 VS Code 的并排行级差异渲染。
// 数据来自 Store.files（单一数据源），订阅加载状态并在完成时转发完整 Diff。
export class CustomDiffPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private files: ChangedFile[] = [];
    private hash = '';
    private changeSetMode: ChangeSetMode = 'commit';
    private rootUri?: vscode.Uri;
    private requestGeneration = 0;
    // 仅在 Webview 接收对应 reset 后转发 Diff，避免快速切换时旧 loading 收到新批次。
    private webviewGeneration = 0;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly storeUnsubscribers: (() => void)[] = [];

    constructor(
        private readonly onSelectFile: (path: string, generation: number) => void,
    ) {
        // 订阅 Store diff 数据变化, 自动转发到 Webview (单一数据源)
        this.storeUnsubscribers.push(
            store.subscribeSelector(state => state.diffProgress, progress => this.forwardProgress(progress)),
            store.subscribeSelector(state => state.diffLoading, loading => this.forwardLoading(loading)),
            store.subscribeSelector(state => state.diffError, error => this.forwardError(error)),
        );
    }

    // 转发 diffProgress 到 Webview
    private forwardProgress(progress: { completed: number; total: number }): void {
        if (!this.panel) return;
        const gen = store.getState().diffGeneration;
        if (gen !== this.requestGeneration || gen !== this.webviewGeneration) return;
        this.panel.webview.postMessage({ type: 'progress', generation: gen, completed: progress.completed, total: progress.total });
    }

    // 当前 Diff 投影读取完成后立即结束准备态；文件目录不能阻塞同一投影的内容展示。
    private forwardLoading(loading: boolean): void {
        if (!this.panel) return;
        const gen = store.getState().diffGeneration;
        if (gen !== this.requestGeneration || gen !== this.webviewGeneration) return;
        this.panel.webview.postMessage({ type: 'loading', generation: gen, loading });
        if (!loading) this.forwardCompleteSnapshot();
    }

    private forwardCompleteSnapshot(): void {
        if (!this.panel) return;
        const state = store.getState();
        const gen = state.diffGeneration;
        if (gen !== this.requestGeneration || gen !== this.webviewGeneration || state.diffLoading) return;
        if (state.diffError) return;
        this.panel.webview.postMessage({
            type: 'complete',
            generation: gen,
            diffs: state.files.filter((file): file is DiffPayload => 'original' in file && 'modified' in file),
        });
    }

    // 转发 diffError 到 Webview
    private forwardError(error: string | undefined): void {
        if (!this.panel || !error) return;
        const gen = store.getState().diffGeneration;
        if (gen !== this.requestGeneration || gen !== this.webviewGeneration) return;
        this.panel.webview.postMessage({ type: 'error', generation: gen, message: error });
    }

    async show(rootUri: vscode.Uri, hash: string, files: ChangedFile[], revealPath?: string, changeSetMode: ChangeSetMode = 'commit'): Promise<boolean> {
        const isSameCommit = this.panel
            && this.rootUri?.toString() === rootUri.toString()
            && this.hash === hash
            && this.changeSetMode === changeSetMode
            && this.webviewGeneration === this.requestGeneration;
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
                    // 清理已释放的面板级 disposable, 避免数组无限增长
                    vscode.Disposable.from(...this.disposables).dispose();
                    this.disposables.length = 0;
                }),
            );
        }
        this.panel.title = `Gitk Diff (${hash.slice(0, 8)})`;
        this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
        if (isSameCommit) {
            if (revealPath) {
                await this.panel.webview.postMessage({ type: 'selectFile', path: revealPath });
            }
            return false;
        }
        // 新 commit: 同步到 Store 的 generation (数据可能已在后台加载)
        this.requestGeneration = store.getState().diffGeneration;
        this.webviewGeneration = 0;
        const generation = this.requestGeneration;
        await this.panel.webview.postMessage({
            type: 'reset',
            hash,
            generation,
            files: files.map((file, index) => ({ index, path: file.path, oldPath: file.oldPath, status: file.status })),
            revealPath,
        });
        if (!this.panel || generation !== this.requestGeneration || generation !== store.getState().diffGeneration) { return false; }
        // reset 已入队后再补发完整 Store 快照，防止快速切换时数据消息先于 reset 被新 Webview 忽略。
        this.webviewGeneration = generation;
        const state = store.getState();
        this.forwardProgress(state.diffProgress);
        this.forwardCompleteSnapshot();
        if (state.diffError) { this.forwardError(state.diffError); }
        return true;
    }

    private async onMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') { return; }
        const payload = message as { type?: string; path?: unknown; generation?: unknown };
        if (payload.type !== 'selectFile' || typeof payload.path !== 'string' || payload.generation !== this.requestGeneration) { return; }
        this.onSelectFile(payload.path, payload.generation);
    }

    // 取消旧请求, 不销毁 panel, 显示加载态等待下一次 show()
    cancelPending(): void {
        this.requestGeneration++;
        this.webviewGeneration = 0;
        store.setState({
            diffGeneration: this.requestGeneration,
            diffLoading: true,
            diffError: undefined,
        });
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
            this.panel.webview.postMessage({ type: 'loading', generation: this.requestGeneration, loading: true });
        }
    }

    hide(): void {
        this.requestGeneration++;
        store.setState({
            diffGeneration: this.requestGeneration,
            diffLoading: false,
            diffError: undefined,
        });
        this.panel?.dispose();
    }

    dispose(): void {
        this.storeUnsubscribers.forEach(unsub => unsub());
        this.storeUnsubscribers.length = 0;
        this.panel?.dispose();
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables.length = 0;
    }

    private getHtml(): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
:root { color-scheme: light dark; --font-family: var(--vscode-editor-font-family); --font-size: var(--vscode-editor-font-size); --font-weight: var(--vscode-editor-font-weight); --line-height: var(--vscode-editor-line-height, 19px); } * { box-sizing: border-box; } body { margin: 0; color: var(--vscode-editor-foreground); background: color-mix(in srgb, var(--vscode-editor-background) 50%, #000); font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); } button { font: inherit; } #toolbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; min-height: 35px; padding: 0 8px; color: var(--vscode-editor-foreground); border-bottom: 1px solid var(--vscode-editorGroup-border); background: var(--vscode-editor-background); } #title, #hash { color: var(--vscode-descriptionForeground); } #toolbar-spacer { flex: 1; } .toolbar-button { padding: 3px 8px; border: 0; border-radius: 0; color: var(--vscode-foreground); background: transparent; cursor: pointer; } .toolbar-button:hover, .toolbar-button.active { color: var(--vscode-toolbar-hoverForeground); background: var(--vscode-toolbar-hoverBackground); } .toolbar-button:disabled { cursor: default; opacity: .45; } .toolbar-button:disabled:hover { color: var(--vscode-foreground); background: transparent; } #list { padding: 8px; } .diff { margin: 0 0 10px; overflow: visible; border: 3px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 8px; background: var(--vscode-editor-background); box-shadow: 0 1px 4px rgba(0, 0, 0, .08); } .file-header { position: sticky; top: 35px; z-index: 2; width: calc(100% + 2px); min-height: 26px; display: flex; align-items: center; gap: 6px; margin: -1px -1px 0; padding: 0 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 6px 6px 4px 4px; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); box-shadow: 0 1px 3px rgba(0, 0, 0, .07); cursor: pointer; font-size: calc(var(--font-size) * .95); text-align: left; } .status { min-width: 12px; color: var(--vscode-gitDecoration-modifiedResourceForeground); font-weight: var(--font-weight); } .status-A { color: var(--vscode-gitDecoration-addedResourceForeground); } .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); } .status-M, .status-R { color: var(--vscode-gitDecoration-modifiedResourceForeground); } .line-stats { display: flex; flex: 0 0 auto; gap: 6px; align-items: center; font-variant-numeric: tabular-nums; white-space: nowrap; } .line-stat { display: inline-flex; align-items: center; gap: 1px; font-size: calc(1em * 5 / 6); letter-spacing: 0; } .line-stat svg { width: 9px; height: 9px; margin-right: 0; fill: currentColor; stroke: none; } .context-fold-icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; } .line-stat-added { color: var(--vscode-gitDecoration-addedResourceForeground); } .line-stat-removed { color: var(--vscode-gitDecoration-deletedResourceForeground); } .file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rename { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; } .editor { width: 100%; overflow: hidden; border-radius: 0 0 5px 5px; background: var(--vscode-editor-background); } .split { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: stretch; } .split.unified { display: block; min-width: 0; } .pane { min-width: 0; overflow-x: auto; overflow-y: hidden; border-right: 1px solid var(--vscode-editorGroup-border); } .right-pane { border-right: 0; } .unified-pane { display: none; } .unified .pane { display: none; } .unified .unified-pane { display: block; } .pane-title { box-sizing: border-box; display: block; height: 25px; padding: 4px 8px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editorGroup-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .line { box-sizing: border-box; width: max-content; min-width: 100%; height: var(--line-height); min-height: var(--line-height); display: grid; grid-template-columns: 52px minmax(max-content, 1fr); color: var(--vscode-editor-foreground); font-family: var(--font-family); font-size: var(--font-size); font-weight: var(--font-weight); line-height: var(--line-height); white-space: pre; } .unified .line { grid-template-columns: 18px 52px 52px minmax(max-content, 1fr); } .line-number, .line-marker { color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background); user-select: none; } .line-number { padding-right: 8px; text-align: right; } .line-marker { text-align: center; } .line-code { min-width: 0; padding: 0 8px; overflow: hidden; text-overflow: clip; } .line:not(.placeholder) .line-code { cursor: text; } .change-block { overflow: hidden; } .removed-block { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .20)); } .added-block { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0, 155, 0, .20)); } .modified-block { background: var(--vscode-diffEditor-unchangedCodeBackground, rgba(86, 156, 214, .14)); } .change-block .removed, .change-block .added, .change-block .modified-removed, .change-block .modified-added, .change-block .line-number, .change-block .line-marker, .change-block .line-code { background: transparent; border-color: transparent; } .removed .line-number, .removed .line-marker { background: var(--vscode-diffEditorGutter-removedLineBackground, var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .20))); } .added .line-number, .added .line-marker { background: var(--vscode-diffEditorGutter-insertedLineBackground, var(--vscode-diffEditor-insertedLineBackground, rgba(0, 155, 0, .20))); } .modified-removed .line-number, .modified-added .line-number { background: var(--vscode-diffEditor-unchangedCodeBackground, rgba(86, 156, 214, .14)); } .removed .line-code { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); border: 1px solid var(--vscode-diffEditor-removedTextBorder, transparent); } .added .line-code { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 155, 0, .35)); border: 1px solid var(--vscode-diffEditor-insertedTextBorder, transparent); } .modified-removed .line-code, .modified-added .line-code { background: transparent; border: 0; } .change-block .line-number, .change-block .line-marker, .change-block .line-code { background: transparent; border-color: transparent; } .change-block .removed .line-code { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); border-color: var(--vscode-diffEditor-removedTextBorder, transparent); } .change-block .added .line-code { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 155, 0, .35)); border-color: var(--vscode-diffEditor-insertedTextBorder, transparent); } .empty-line { color: transparent; } .placeholder { background-image: linear-gradient(-45deg, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 12.5%, transparent 12.5%, transparent 50%, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 50%, var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, .20)) 62.5%, transparent 62.5%, transparent 100%); background-size: 8px 8px; } .placeholder .line-number, .placeholder .line-code { background-color: transparent; } .context-fold { position: relative; width: 100%; height: 24px; border: 0; color: var(--vscode-diffEditor-unchangedRegionForeground, var(--vscode-editorCodeLens-foreground)); background: var(--vscode-diffEditor-unchangedRegionBackground, transparent); font-family: var(--font-family); font-size: 13px; line-height: 14px; opacity: .5; user-select: none; } .context-fold-center { position: absolute; inset: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; box-shadow: inset 0 -5px 5px -7px var(--vscode-diffEditor-unchangedRegionShadow), inset 0 5px 5px -7px var(--vscode-diffEditor-unchangedRegionShadow); } .context-fold:hover, .context-fold:focus-within { opacity: 1; } .context-fold-unfold { display: inline-flex; align-items: center; padding: 0; border: 0; color: inherit; background: transparent; cursor: pointer; line-height: 1; } .context-fold-label { overflow: hidden; text-overflow: ellipsis; cursor: default; } .context-fold-label:hover { text-decoration: underline; } .context-fold-edge { position: absolute; z-index: 1; left: 0; display: flex; align-items: center; width: 100%; height: 7px; padding: 0 8px; border: 0; color: inherit; background: transparent; cursor: pointer; opacity: 0; } .context-fold-edge:hover, .context-fold:focus-within .context-fold-edge { opacity: 1; background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent); } .context-fold-top { top: 0; justify-content: flex-start; } .context-fold-bottom { bottom: 0; justify-content: flex-start; } .context-fold button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; } .empty { padding: 16px 8px; color: var(--vscode-descriptionForeground); text-align: center; } #loadingView { padding-top: 32px; } #progressTrack { width: min(360px, calc(100vw - 48px)); height: 4px; margin: 12px auto 0; overflow: hidden; background: var(--vscode-progressBar-background); } #progressBar { width: 0; height: 100%; background: var(--vscode-progressBar-background); transition: width .12s linear; } .loading { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.diff.selected > .file-header { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; } .change-block.change-reveal { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; animation: change-reveal 1s ease-out forwards; } .line.change-cursor .line-code { position: relative; } .line.change-cursor .line-code::before { content: ''; position: absolute; top: 2px; bottom: 2px; left: var(--cursor-x, 8px); width: 1px; background: var(--vscode-editorCursor-foreground, var(--vscode-focusBorder)); animation: cursor-blink 1s steps(1, end) infinite; } @keyframes change-reveal { from { background-color: var(--vscode-editor-selectionBackground); } to { background-color: transparent; outline-color: transparent; } } @keyframes cursor-blink { 50% { opacity: 0; } }
</style></head><body><header id="toolbar"><span id="title">Gitk Diff</span><span id="hash"></span><span id="toolbar-spacer"></span><button id="previousChange" class="toolbar-button" title="上一个修改点" aria-label="上一个修改点">↑</button><button id="nextChange" class="toolbar-button" title="下一个修改点" aria-label="下一个修改点">↓</button><button id="layout" class="toolbar-button" title="切换并排 / 内联差异">并排</button></header><section id="loadingView" class="empty"><span class="loading"></span><span id="loadingText">正在准备 Diff...</span><div id="progressTrack"><div id="progressBar"></div></div></section><main id="list" hidden></main><script>
(function() {
  const vscode = acquireVsCodeApi(); const list = document.getElementById('list'); const loadingView = document.getElementById('loadingView'); const loadingText = document.getElementById('loadingText'); const progressBar = document.getElementById('progressBar'); const layoutButton = document.getElementById('layout'); const previousChangeButton = document.getElementById('previousChange'); const nextChangeButton = document.getElementById('nextChange');
  let files = []; let renderStarted = false; let renderEpoch = 0; let loaded = new Set(); let unified = false; let selectedPath = ''; let revealPath = ''; let generation = 0;
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function splitLines(text) { const lines = String(text || '').split(/\\r?\\n/); return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines; }
  function lineHtml(leftNumber, rightNumber, code, type, marker, change) { const attribute = change === undefined ? '' : ' data-change="' + change + '"'; return '<div class="line ' + type + '"' + attribute + '><span class="line-marker">' + (marker || '') + '</span><span class="line-number">' + (leftNumber || '') + '</span><span class="line-number">' + (rightNumber || '') + '</span><span class="line-code">' + (code === '' ? '&nbsp;' : escapeHtml(code)) + '</span></div>'; }
  function splitLineHtml(number, code, type, change) { const attribute = change === undefined ? '' : ' data-change="' + change + '"'; return '<div class="line ' + type + '"' + attribute + '><span class="line-number">' + (number || '') + '</span><span class="line-code">' + (code === '' ? '&nbsp;' : escapeHtml(code)) + '</span></div>'; }
  function calculateDiff(original, modified) {
    const left = splitLines(original); const right = splitLines(modified); const rowsLeft = []; const rowsRight = []; let changeIndex = 0;
    function append(leftIndex, rightIndex, leftType, rightType, change) { rowsLeft.push({ value: leftIndex === undefined ? '' : left[leftIndex], number: leftIndex === undefined ? '' : leftIndex + 1, type: leftType, change: change }); rowsRight.push({ value: rightIndex === undefined ? '' : right[rightIndex], number: rightIndex === undefined ? '' : rightIndex + 1, type: rightType, change: change }); }
    function appendUnchanged(leftIndex, rightIndex) { append(leftIndex, rightIndex, '', '', undefined); }
    function appendChanged(removed, added) { if (!removed.length && !added.length) return; const change = changeIndex++; const paired = Math.min(removed.length, added.length); for (let index = 0; index < paired; index++) append(removed[index], added[index], 'modified-removed', 'modified-added', change); for (let index = paired; index < removed.length; index++) append(removed[index], undefined, 'removed', 'placeholder', change); for (let index = paired; index < added.length; index++) append(undefined, added[index], 'placeholder', 'added', change); }
    // Patience anchors match VS Code's preference for stable, low-noise line alignment.
    function patienceAnchors(leftStart, leftEnd, rightStart, rightEnd) { const leftCounts = new Map(); const rightPositions = new Map(); for (let i = leftStart; i < leftEnd; i++) leftCounts.set(left[i], (leftCounts.get(left[i]) || 0) + 1); for (let i = rightStart; i < rightEnd; i++) rightPositions.set(right[i], rightPositions.has(right[i]) ? -1 : i); const candidates = []; for (let i = leftStart; i < leftEnd; i++) { const rightIndex = rightPositions.get(left[i]); if (leftCounts.get(left[i]) === 1 && rightIndex !== undefined && rightIndex >= rightStart) candidates.push([i, rightIndex]); } const tails = []; const previous = new Array(candidates.length); for (let i = 0; i < candidates.length; i++) { let low = 0; let high = tails.length; while (low < high) { const middle = (low + high) >>> 1; if (candidates[tails[middle]][1] < candidates[i][1]) low = middle + 1; else high = middle; } previous[i] = low ? tails[low - 1] : -1; tails[low] = i; } const anchors = []; for (let index = tails.length ? tails[tails.length - 1] : -1; index >= 0; index = previous[index]) anchors.unshift(candidates[index]); return anchors; }
    // Myers shortest-edit-script is the line-level basis used by modern editor diff engines.
    function myers(leftStart, leftEnd, rightStart, rightEnd) { const height = leftEnd - leftStart; const width = rightEnd - rightStart; const limit = height + width; const offset = limit; let frontier = new Int32Array(limit * 2 + 3); frontier.fill(-1); frontier[offset + 1] = 0; const trace = []; for (let distance = 0; distance <= limit; distance++) { const current = new Int32Array(frontier); for (let diagonal = -distance; diagonal <= distance; diagonal += 2) { const slot = offset + diagonal; let x = diagonal === -distance || (diagonal !== distance && frontier[slot - 1] < frontier[slot + 1]) ? frontier[slot + 1] : frontier[slot - 1] + 1; let y = x - diagonal; while (x < height && y < width && left[leftStart + x] === right[rightStart + y]) { x++; y++; } current[slot] = x; if (x >= height && y >= width) { trace.push(current); const operations = []; let backX = height; let backY = width; for (let step = trace.length - 1; step > 0; step--) { const prior = trace[step - 1]; const backDiagonal = backX - backY; const priorDiagonal = backDiagonal === -step || (backDiagonal !== step && prior[offset + backDiagonal - 1] < prior[offset + backDiagonal + 1]) ? backDiagonal + 1 : backDiagonal - 1; const priorX = prior[offset + priorDiagonal]; const priorY = priorX - priorDiagonal; while (backX > priorX && backY > priorY) { operations.push(['equal', leftStart + --backX, rightStart + --backY]); } if (backX === priorX) operations.push(['insert', undefined, rightStart + --backY]); else operations.push(['delete', leftStart + --backX, undefined]); } while (backX > 0 && backY > 0) operations.push(['equal', leftStart + --backX, rightStart + --backY]); while (backX > 0) operations.push(['delete', leftStart + --backX, undefined]); while (backY > 0) operations.push(['insert', undefined, rightStart + --backY]); return operations.reverse(); } } trace.push(current); frontier = current; } return []; }
    function emitRegion(leftStart, leftEnd, rightStart, rightEnd) { const operations = myers(leftStart, leftEnd, rightStart, rightEnd); let removed = []; let added = []; function flush() { appendChanged(removed, added); removed = []; added = []; } operations.forEach(function(operation) { if (operation[0] === 'equal') { flush(); appendUnchanged(operation[1], operation[2]); } else if (operation[0] === 'delete') removed.push(operation[1]); else added.push(operation[2]); }); flush(); }
    function diffRegion(leftStart, leftEnd, rightStart, rightEnd) { let prefix = 0; while (leftStart + prefix < leftEnd && rightStart + prefix < rightEnd && left[leftStart + prefix] === right[rightStart + prefix]) { appendUnchanged(leftStart + prefix, rightStart + prefix); prefix++; } leftStart += prefix; rightStart += prefix; let suffix = 0; while (leftEnd - suffix > leftStart && rightEnd - suffix > rightStart && left[leftEnd - suffix - 1] === right[rightEnd - suffix - 1]) suffix++; const middleLeftEnd = leftEnd - suffix; const middleRightEnd = rightEnd - suffix; const anchors = patienceAnchors(leftStart, middleLeftEnd, rightStart, middleRightEnd); let currentLeft = leftStart; let currentRight = rightStart; anchors.forEach(function(anchor) { emitRegion(currentLeft, anchor[0], currentRight, anchor[1]); appendUnchanged(anchor[0], anchor[1]); currentLeft = anchor[0] + 1; currentRight = anchor[1] + 1; }); emitRegion(currentLeft, middleLeftEnd, currentRight, middleRightEnd); for (let index = suffix; index > 0; index--) appendUnchanged(leftEnd - index, rightEnd - index); }
    diffRegion(0, left.length, 0, right.length);
    return { left: rowsLeft, right: rowsRight };
  }
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
  function firstVisibleDiff() { const toolbarHeight = document.getElementById('toolbar').offsetHeight; const viewportTop = toolbarHeight + 1; const pointTarget = document.elementFromPoint(Math.max(1, Math.floor(window.innerWidth / 2)), viewportTop); const pointDiff = pointTarget && pointTarget.closest('.diff'); if (pointDiff) return pointDiff; return Array.from(document.querySelectorAll('.diff')).find(function(item) { const rect = item.getBoundingClientRect(); return rect.bottom > viewportTop && rect.top < window.innerHeight; }); }
  function syncSelectedFromViewport() { if (performance.now() < suppressViewportSyncUntil) return; const firstVisible = firstVisibleDiff(); if (!firstVisible) return; const index = Number(firstVisible.dataset.index); const file = files[index]; if (!file || file.path === selectedPath) return; selectFile(file.path, false); vscode.postMessage({ type: 'selectFile', path: file.path, generation: generation }); }
  let scrollFrame = 0; window.addEventListener('scroll', function() { if (scrollFrame) return; scrollFrame = requestAnimationFrame(function() { scrollFrame = 0; syncSelectedFromViewport(); }); }, { passive: true });
  function contextFoldHtml(start, end, canExpandUp, canExpandDown) { const count = end - start; const upIcon = '<svg class="context-fold-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5 8 5.5l5 5"/></svg>'; const downIcon = '<svg class="context-fold-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 5.5 5 5 5-5"/></svg>'; const unfoldIcon = '<svg class="context-fold-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 6 5 5 5-5"/><path d="M3 2.5h10"/></svg>'; const upButton = canExpandUp ? '<button class="context-fold-edge context-fold-top" type="button" data-action="top" title="向上展开更多内容" aria-label="向上展开更多内容">' + upIcon + '</button>' : ''; const downButton = canExpandDown ? '<button class="context-fold-edge context-fold-bottom" type="button" data-action="bottom" title="向下展开更多内容" aria-label="向下展开更多内容">' + downIcon + '</button>' : ''; return '<div class="context-fold" data-start="' + start + '" data-end="' + end + '">' + upButton + '<div class="context-fold-center"><button class="context-fold-unfold" type="button" data-action="all" title="显示未更改区域" aria-label="显示未更改区域">' + unfoldIcon + '</button><span class="context-fold-label" title="双击显示未更改区域">' + count + ' 个隐藏行</span></div>' + downButton + '</div>'; }
  function renderRows(result, expandedRanges) {
    const placeholder = { value: '', number: '', type: 'placeholder' };
    const rowCount = Math.max(result.left.length, result.right.length);
    // Normalize into dense arrays before rendering so malformed algorithm output cannot escape to DOM access.
    result.left = Array.from({ length: rowCount }, function(_, rowIndex) { return result.left[rowIndex] || placeholder; });
    result.right = Array.from({ length: rowCount }, function(_, rowIndex) { return result.right[rowIndex] || placeholder; });
    function rowAt(rows, rowIndex) { return rows[rowIndex] || placeholder; }
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
          const currentLeft = rowAt(result.left, rowIndex); const currentRight = rowAt(result.right, rowIndex); leftRows += splitLineHtml(currentLeft.number, currentLeft.value, ''); rightRows += splitLineHtml(currentRight.number, currentRight.value, ''); unifiedRows += lineHtml(currentLeft.number, currentRight.number, currentLeft.value, '', '');
        }
        if (!expansion.all && trailingStart > leadingEnd) { const canExpandUp = leadingEnd > index; const canExpandDown = trailingStart < end; leftRows += contextFoldHtml(index, end, canExpandUp, canExpandDown); rightRows += contextFoldHtml(index, end, canExpandUp, canExpandDown); unifiedRows += contextFoldHtml(index, end, canExpandUp, canExpandDown); }
        for (let rowIndex = trailingStart; rowIndex < end; rowIndex++) {
          const currentLeft = rowAt(result.left, rowIndex); const currentRight = rowAt(result.right, rowIndex); leftRows += splitLineHtml(currentLeft.number, currentLeft.value, ''); rightRows += splitLineHtml(currentRight.number, currentRight.value, ''); unifiedRows += lineHtml(currentLeft.number, currentRight.number, currentLeft.value, '', '');
        }
        index = end;
      } else {
        const change = left.change === undefined ? right.change : left.change; let end = index + 1;
        while (end < result.left.length && (result.left[end].change === undefined ? result.right[end].change : result.left[end].change) === change) end++;
        let leftBlock = ''; let rightBlock = ''; let unifiedBlock = ''; let leftClass = ''; let rightClass = '';
        for (let rowIndex = index; rowIndex < end; rowIndex++) {
          const currentLeft = rowAt(result.left, rowIndex); const currentRight = rowAt(result.right, rowIndex);
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
      holder.querySelector('.file-header').addEventListener('click', function() { selectFile(diff.path, true); vscode.postMessage({ type: 'selectFile', path: diff.path, generation: generation }); });
      return;
    }
    const result = calculateDiff(diff.original, diff.modified); const rows = renderRows(result, expandedRanges || new Map());
    const addedLines = result.right.filter(function(row) { return row.type === 'added' || row.type === 'modified-added'; }).length;
    const removedLines = result.left.filter(function(row) { return row.type === 'removed' || row.type === 'modified-removed'; }).length;
    const addedIcon = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M5 1h2v4h4v2H7v4H5V7H1V5h4z"/></svg>';
    const removedIcon = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 5h10v2H1z"/></svg>';
    const lineStats = '<span class="line-stats"><span class="line-stat line-stat-added" title="新增 ' + addedLines + ' 行">' + addedIcon + '<span>' + addedLines + '</span></span><span class="line-stat line-stat-removed" title="删除 ' + removedLines + ' 行">' + removedIcon + '<span>' + removedLines + '</span></span></span>';
    holder.innerHTML = '<button class="file-header"><span class="status status-' + escapeHtml(diff.status) + '">' + escapeHtml(diff.status) + '</span>' + lineStats + '<span class="file-path">' + escapeHtml(diff.path) + '</span>' + (diff.oldPath ? '<span class="rename">← ' + escapeHtml(diff.oldPath) + '</span>' : '') + '</button><div class="editor"><div class="split' + (unified ? ' unified' : '') + '"><section class="pane left-pane"><span class="pane-title">' + escapeHtml(oldLabel) + '</span>' + rows.leftRows + '</section><section class="pane right-pane"><span class="pane-title">' + escapeHtml(newLabel) + '</span>' + rows.rightRows + '</section><section class="unified-pane"><span class="pane-title">' + escapeHtml(diff.path) + '</span>' + rows.unifiedRows + '</section></div></div>';
    holder.querySelector('.file-header').addEventListener('click', function() { selectFile(diff.path, true); vscode.postMessage({ type: 'selectFile', path: diff.path, generation: generation }); });
    holder.querySelectorAll('.context-fold').forEach(function(fold) {
      function expand(action) { const start = fold.dataset.start; const end = fold.dataset.end; const key = start + ':' + end; const expanded = expandedRanges || new Map(); const state = expanded.get(key) || { top: 0, bottom: 0, all: false }; if (action === 'all') state.all = true; else state[action] += 10; expanded.set(key, state); renderDiff(diff, expanded); }
      fold.querySelectorAll('button').forEach(function(button) { button.addEventListener('click', function(event) { event.stopPropagation(); expand(button.dataset.action); }); });
      const label = fold.querySelector('.context-fold-label'); if (label) label.addEventListener('dblclick', function(event) { event.stopPropagation(); expand('all'); });
    });
  }
  function renderAllDiffs(diffs, expectedGeneration, expectedEpoch) {
    if (renderStarted || generation !== expectedGeneration || renderEpoch !== expectedEpoch) { return; }
    renderStarted = true;
    list.hidden = false;
    loadingView.hidden = true;
    loadingView.style.display = 'none';
    if (!diffs.length) {
      list.innerHTML = '<div class="empty">没有可显示的 Diff 内容。</div>';
      return;
    }
    list.innerHTML = diffs.map(function(diff) { return '<section class="diff" data-index="' + Number(diff.index) + '"></section>'; }).join('');
    for (const diff of diffs) {
      if (generation !== expectedGeneration || renderEpoch !== expectedEpoch) { return; }
      try {
        renderDiff(diff);
      } catch (error) {
        console.error('无法渲染 Diff：' + diff.path, error);
        const holder = document.querySelector('[data-index="' + Number(diff.index) + '"]');
        if (!holder) { continue; }
        const message = error instanceof Error ? error.message : String(error);
        holder.innerHTML = '<button class="file-header"><span class="status status-' + escapeHtml(diff.status) + '">' + escapeHtml(diff.status) + '</span><span class="file-path">' + escapeHtml(diff.path) + '</span></button><div class="empty">无法渲染此文件的 Diff：' + escapeHtml(message) + '</div>';
        const header = holder.querySelector('.file-header');
        if (header) { header.addEventListener('click', function() { selectFile(diff.path, true); vscode.postMessage({ type: 'selectFile', path: diff.path, generation: generation }); }); }
      }
    }
    const target = files.find(function(file) { return file.path === revealPath; });
    if (target) { selectFile(target.path, true); } else if (files.length && loaded.size === files.length) { selectFile(files[0].path, false); vscode.postMessage({ type: 'selectFile', path: files[0].path, generation: generation }); }
    updateNavigationButtons(changeTargets(), -1);
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
    lastChangeKey = targetKey(target); updateNavigationButtons(targets, nextIndex);
    const diff = target.closest('.diff'); const index = diff && Number(diff.dataset.index); const file = files[index];
    if (file) { selectFile(file.path, false); vscode.postMessage({ type: 'selectFile', path: file.path, generation: generation }); }
    highlightChangeTarget(target);
    const toolbarHeight = document.getElementById('toolbar').offsetHeight; const header = diff && diff.querySelector('.file-header'); const headerHeight = header ? header.offsetHeight + 4 : 0; const targetHeight = target.getBoundingClientRect().height;
    const visibleTop = toolbarHeight + headerHeight; const visibleHeight = Math.max(targetHeight, window.innerHeight - visibleTop);
    suppressViewportSyncUntil = performance.now() + 300;
    window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - visibleTop - (visibleHeight - targetHeight) / 2), behavior: 'auto' });
  }
  previousChangeButton.addEventListener('click', function() { navigateChange(-1); });
  nextChangeButton.addEventListener('click', function() { navigateChange(1); });
  layoutButton.addEventListener('click', function() { unified = !unified; lastChangeKey = ''; updateLayout(); updateNavigationButtons(changeTargets(), -1); });
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
  window.addEventListener('message', function(event) { const message = event.data; if (message.type === 'loading') { if (message.loading && message.generation !== generation) { generation = message.generation; renderEpoch++; renderStarted = false; loaded = new Set(); selectedPath = ''; revealPath = ''; lastChangeKey = ''; updateNavigationButtons([], -1); document.getElementById('hash').textContent = ''; loadingView.hidden = false; loadingView.style.display = 'block'; loadingText.textContent = '正在准备 Diff...'; progressBar.style.width = '0%'; list.hidden = true; list.innerHTML = ''; } } else if (message.type === 'reset') { generation = message.generation; renderEpoch++; files = message.files || []; renderStarted = false; loaded = new Set(); selectedPath = ''; revealPath = message.revealPath || ''; lastChangeKey = ''; updateNavigationButtons([], -1); document.getElementById('hash').textContent = message.hash ? '(' + message.hash.slice(0, 8) + ')' : ''; loadingView.hidden = false; loadingView.style.display = 'block'; loadingText.textContent = '正在准备 Diff：已处理 0 / ' + files.length + ' 个文件'; progressBar.style.width = '0%'; list.hidden = true; list.innerHTML = ''; } else if (message.type === 'progress' && message.generation === generation) { const total = Number(message.total) || 0; const completed = Number(message.completed) || 0; loadingText.textContent = '正在准备 Diff：已处理 ' + completed + ' / ' + total + ' 个文件'; progressBar.style.width = (total ? completed / total * 100 : 100) + '%'; } else if (message.type === 'complete' && message.generation === generation) { renderAllDiffs(message.diffs || [], generation, renderEpoch); } else if (message.type === 'error' && message.generation === generation) { loadingText.textContent = '准备 Diff 失败：' + (message.message || '未知错误'); progressBar.style.width = '0%'; } else if (message.type === 'selectFile') { selectFile(message.path, true); } });
})();</script></body></html>`;
    }
}
