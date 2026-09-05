import * as vscode from 'vscode';
import type { DiffPayload } from '../types';
import { store } from '../state/store';
import { renderMultiDiffHtml } from './multiDiffPanelDocument';

type DiffSnapshot = {
    type: 'snapshot';
    revision: number;
    identity: string;
    loading: boolean;
    completed: number;
    total: number;
    error?: string;
    revealPath?: string;
    // changes 虚拟提交对比的是工作区文件, 右侧允许编辑并回写。
    editable: boolean;
    diffs: Array<Omit<DiffPayload, 'equals'> & { editable?: boolean }>;
};

// 单一 Webview 接收 Store 的原子完整快照，并为每个文件创建一套共享 Monaco Diff 配置。
export class MultiDiffPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private webviewReady = false;
    private revision = 0;
    private publishScheduled = false;
    private readonly unsubscribers: (() => void)[];

    constructor(
        private readonly onSelectFile?: (path: string, generation: number) => void,
        private readonly onRendered?: (identity?: string) => void,
        private readonly onOpenFileAtLine?: (path: string, line?: number, column?: number, side?: 'original' | 'modified') => void,
        private readonly onSaveFile?: (path: string, content: string) => void,
        private readonly onWorkingTreeAction?: (action: 'stage' | 'unstage' | 'discard', section: 'staged' | 'unstaged', path: string) => void,
    ) {
        this.unsubscribers = [
            store.subscribeSelector(state => state.diffLoading, () => this.schedulePublish()),
            store.subscribeSelector(state => state.diffError, () => this.schedulePublish()),
            store.subscribeSelector(state => state.files, () => this.schedulePublish()),
            store.subscribeSelector(state => state.diffProgress, () => this.schedulePublish()),
        ];
    }

    // 打开(必要时创建)面板并定位; 新建或未就绪时发完整快照, 否则只做定位。
    show(hash: string, commitTitle: string, revealPath?: string): void {
        const isNewPanel = !this.panel;
        this.ensurePanel();
        // 标题仅在提交变化时更新, 避免重复写入面板属性。
        const title = `${commitTitle || 'Gitk Diff'} (${hash.slice(0, 8)})`;
        if (this.panel!.title !== title) { this.panel!.title = title; }
        this.panel!.reveal(this.panel!.viewColumn ?? vscode.ViewColumn.Active, false);
        // 已渲染的面板只做定位，避免重建全部 Monaco 编辑器；卡片重建仅由 Store 快照驱动。
        if (isNewPanel || !this.webviewReady) { this.publish(); return; }
        this.post({ type: 'reveal', path: revealPath });
    }

    // 已渲染面板的轻量定位: 只发 reveal, 不 ensurePanel / 不改标题 / 不抢焦点。
    // 仅当面板已是活动标签时可用; 返回 false 表示需回退到 show() 先激活标签。
    revealFile(revealPath?: string): boolean {
        if (!this.panel?.active || !this.webviewReady) { return false; }
        this.post({ type: 'reveal', path: revealPath });
        return true;
    }

    navigateChange(direction: -1 | 1): void {
        this.post({ type: 'navigateChange', direction });
    }

    // 推进 generation 使在途 DiffReader 失效；新 Store 快照由订阅自动发布。
    cancelPending(): void {
        // 只使在途读取失效，加载状态由新的提交选择流程统一设置。
        store.setState({ diffGeneration: store.getState().diffGeneration + 1 });
    }

    hide(): void { this.panel?.dispose(); }

    // 面板是否已创建(打开)。用于区分"面板开着但文件清空"(应保留面板显示空态)与"面板本就未开"(不主动弹出)。
    isOpen(): boolean { return !!this.panel; }

    dispose(): void {
        this.unsubscribers.forEach(unsubscribe => unsubscribe());
        this.panel?.dispose();
    }

    private ensurePanel(): void {
        if (this.panel) { return; }
        this.webviewReady = false;
        const mediaRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..', 'media');
        const monacoRoot = vscode.Uri.joinPath(mediaRoot, 'monaco');
        const codiconsRoot = vscode.Uri.joinPath(mediaRoot, 'codicons');
        this.panel = vscode.window.createWebviewPanel('vscode-gitk.multiDiff', 'Gitk Diff', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [monacoRoot, codiconsRoot],
        });
        this.panel.webview.onDidReceiveMessage(message => {
            if (message?.type === 'ready') {
                this.webviewReady = true;
                this.publish();
            } else if (message?.type === 'selectFile' && typeof message.path === 'string') {
                // 顶部卡片变化时同步 Changed Files 高亮。
                this.onSelectFile?.(message.path, store.getState().diffGeneration);
            } else if (message?.type === 'saveFile' && typeof message.path === 'string' && typeof message.content === 'string') {
                this.onSaveFile?.(message.path, message.content);
            } else if (message?.type === 'openFileAtLine' && typeof message.path === 'string') {
                // line 缺省表示标题栏按钮触发, 只打开文件不定位。
                const line = typeof message.line === 'number' ? message.line : undefined;
                const column = typeof message.column === 'number' ? message.column : undefined;
                const side = message.side === 'original' || message.side === 'modified' ? message.side : undefined;
                this.onOpenFileAtLine?.(message.path, line, column, side);
            } else if (message?.type === 'workingTreeAction'
                && (message.action === 'stage' || message.action === 'unstage' || message.action === 'discard')
                && (message.section === 'staged' || message.section === 'unstaged')
                && typeof message.path === 'string') {
                this.onWorkingTreeAction?.(message.action, message.section, message.path);
            } else if (message?.type === 'rendered') {
                // Diff 卡片与行号渲染完成, 通知 Provider 放行 Changed Files 列表。
                this.onRendered?.(typeof message.identity === 'string' ? message.identity : undefined);
            } else if (message?.type === 'error') {
                console.error('[gitk-multi-diff]', message.message);
            } else if (message?.type === 'log') {
                console.log('[gitk-multi-diff]', message.message);
            }
        });
        // 面板被关闭后不会再有渲染完成信号, 通知 Provider 兜底放行 Changed Files 列表。
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.webviewReady = false;
            this.onRendered?.();
        });
        this.panel.webview.html = this.getHtml(monacoRoot, codiconsRoot);
    }

    private schedulePublish(): void {
        if (this.publishScheduled) { return; }
        this.publishScheduled = true;
        queueMicrotask(() => {
            this.publishScheduled = false;
            this.publish();
        });
    }

    private publish(): void {
        if (!this.panel || !this.webviewReady) { return; }
        const state = store.getState();
        const diffs = state.files
            .filter((file): file is DiffPayload => 'original' in file && 'modified' in file)
            .map(file => ({
                ...file,
                editable: state.currentChangeSet === 'changes'
                    || (state.currentChangeSet === 'uncommitted' && file.workingTreeKind !== 'staged'),
            }));
        const snapshot: DiffSnapshot = {
            type: 'snapshot',
            revision: ++this.revision,
            identity: `${state.currentRepositoryPath ?? ''}\u0000${state.currentHash ?? ''}`,
            // 与 CustomDiffPanel 一致：只由 Store 的 diffLoading 决定加载态；完成空快照也必须结束 loading。
            loading: state.diffLoading,
            completed: state.diffProgress.completed,
            total: state.diffProgress.total,
            error: state.diffError,
            revealPath: state.selectedPath,
            // changes 与 uncommitted 的右侧都是工作区文件本身，允许编辑并回写。
            editable: state.currentChangeSet === 'changes' || state.currentChangeSet === 'uncommitted',
            diffs,
        };
        void this.panel.webview.postMessage(snapshot);
    }

    private post(message: unknown): void {
        if (!this.panel || !this.webviewReady) { return; }
        void this.panel.webview.postMessage(message);
    }

    private getHtml(monacoRoot: vscode.Uri, codiconsRoot: vscode.Uri): string {
        const webview = this.panel!.webview;
        const monacoUri = webview.asWebviewUri(vscode.Uri.joinPath(monacoRoot, 'vs'));
        // 显式加载 codicon 样式，不再依赖 Monaco 自带字体隐式提供 .codicon-* 字形。
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css'));
        const nonce = String(Date.now());
        return renderMultiDiffHtml(webview.cspSource, String(codiconCssUri), String(monacoUri), nonce);
    }
}
