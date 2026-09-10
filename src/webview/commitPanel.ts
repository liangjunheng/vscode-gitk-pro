import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { renderCommitPanelHtml } from './commitPanelDocument';

export interface CommitPanelFile {
    readonly path: string;
    readonly status: string;
    readonly isUntracked?: boolean;
    readonly isSubmodule?: boolean;
}

export interface CommitCardRepository {
    readonly path: string;
    readonly label: string;
    readonly hasSubmodules: boolean;
}

/** 单个仓库提交卡片数据。 */
export interface CommitCard {
    readonly repositoryPath: string;
    readonly repositoryLabel: string;
    readonly repositoryHasSubmodules: boolean;
    readonly repositoryParentPath?: string;
    readonly repositoryAncestry: readonly CommitCardRepository[];
    readonly message: string;
    readonly selectedCommitSubmoduleRepositoryPaths: readonly string[];
    readonly selectedPushSubmoduleRepositoryPaths: readonly string[];
    readonly pullBeforePush: boolean;
    readonly pushTargetLabel?: string;
    readonly amend: boolean;
    readonly committedFiles: readonly CommitPanelFile[];
    readonly committedFilesLoading: boolean;
    readonly latestCommitSubmodulePaths: readonly string[];
    readonly hasUnpushedCommits: boolean;
    readonly unpushedCommitCount: number;
    readonly changedSubmoduleRepositoryPaths: readonly string[];
    readonly stagedFiles: readonly CommitPanelFile[];
    readonly unstagedFiles: readonly CommitPanelFile[];
    readonly committing: boolean;
}

export interface CommitPanelSnapshot {
    readonly cards: readonly CommitCard[];
    readonly displayMode: 'tree' | 'flat';
}

export type CommitCardStatePatch = {
    readonly message?: string;
    readonly selectedCommitSubmoduleRepositoryPaths?: readonly string[];
    readonly selectedPushSubmoduleRepositoryPaths?: readonly string[];
    readonly pullBeforePush?: boolean;
};

type CommitPanelCallbacks = {
    readonly onCommit: (repositoryPath: string, repositoryPaths: readonly string[], message: string, amend: boolean) => void;
    readonly onPush: (repositoryPaths: readonly string[], pullBeforePush: boolean) => void;
    readonly onPickPushBranch: (repositoryPath: string) => void;
    readonly onUpdateCardState: (repositoryPath: string, patch: CommitCardStatePatch) => void;
    readonly onToggleDisplayMode: () => void;
    readonly onToggleAmend: (repositoryPath: string, message: string) => void;
    readonly onHistory: (repositoryPath: string) => void;
    readonly onFocusRepository: (repositoryPath: string) => void;
    readonly onSelectFile: (repositoryPath: string, section: 'staged' | 'unstaged', path: string) => void;
    readonly onWorkingTreeAction: (
        repositoryPath: string,
        action: 'stage' | 'unstage' | 'discard',
        section: 'staged' | 'unstaged',
        paths: readonly string[],
        untrackedPaths: readonly string[],
    ) => void;
};

/**
 * Commit 面板: 编辑器区 webview, 纵向排列所有仓库卡片(标题=仓库名),
 * 每张卡片=一个仓库的提交信息框 + staged/unstaged 列表。
 */
export class CommitPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private webviewReady = false;
    private snapshot?: CommitPanelSnapshot;
    /** 已下发到 webview 的快照对象引用; 每次 update/show 都传入新对象, 用引用比较去重避免重复渲染。 */
    private publishedSnapshot?: CommitPanelSnapshot;
    private postQueue: Promise<unknown> = Promise.resolve();
    private pendingFocusRepositoryPath?: string;

    constructor(private readonly callbacks: CommitPanelCallbacks) {}

    show(snapshot: CommitPanelSnapshot, focusRepositoryPath?: string): void {
        this.snapshot = snapshot;
        const isNew = !this.panel;
        // 快照在创建面板前就已就绪, 直接随 HTML 内联下发, 首次渲染与首次绘制同步完成。
        this.ensurePanel(snapshot);
        this.panel!.reveal(this.panel!.viewColumn ?? vscode.ViewColumn.Active, false);
        if (focusRepositoryPath) { this.pendingFocusRepositoryPath = focusRepositoryPath; }
        if (isNew || !this.webviewReady) { return; }
        this.publish();
        this.sendPendingFocus();
    }

    update(snapshot: CommitPanelSnapshot): void {
        this.snapshot = snapshot;
        if (this.panel && this.webviewReady) { this.publish(); }
    }

    /** 把面板带回编辑器区前台并定位到指定仓库卡片, 不重新渲染。 */
    focus(repositoryPath: string): void {
        if (this.panel && this.webviewReady) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
            this.post({ type: 'focus', repositoryPath });
        }
    }

    /** 把历史提交信息填入指定仓库卡片的信息框。 */
    setMessage(repositoryPath: string, message: string): void {
        if (this.panel && this.webviewReady) { this.post({ type: 'setMessage', repositoryPath, message }); }
    }

    isVisible(): boolean { return Boolean(this.panel); }

    hide(): void { this.panel?.dispose(); }

    dispose(): void { this.panel?.dispose(); }

    private ensurePanel(initialSnapshot: CommitPanelSnapshot): void {
        if (this.panel) { return; }
        this.webviewReady = false;
        this.postQueue = Promise.resolve();
        const codiconsRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..', 'media', 'codicons');
        this.panel = vscode.window.createWebviewPanel('vscode-gitk.commit', 'commit', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [codiconsRoot],
        });
        this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
        this.panel.onDidDispose(() => { this.panel = undefined; this.webviewReady = false; this.publishedSnapshot = undefined; this.pendingFocusRepositoryPath = undefined; });
        this.panel.webview.html = this.getHtml(codiconsRoot, initialSnapshot);
        // 首屏快照已内联, ready 后无需再发一次相同内容。
        this.publishedSnapshot = initialSnapshot;
    }

    private sendPendingFocus(): void {
        if (!this.pendingFocusRepositoryPath || !this.panel || !this.webviewReady) { return; }
        const repositoryPath = this.pendingFocusRepositoryPath;
        this.pendingFocusRepositoryPath = undefined;
        this.post({ type: 'focus', repositoryPath });
    }

    private handleMessage(message: unknown): void {
        if (!message || typeof message !== 'object') { return; }
        const data = message as Record<string, unknown>;
        const repo = typeof data.repositoryPath === 'string' ? data.repositoryPath : undefined;
        if (data.type === 'ready') {
            this.webviewReady = true;
            this.publish();
            this.sendPendingFocus();
        } else if (data.type === 'rendered' && typeof data.cardCount === 'number') {
            console.log('[Gitk][CommitPanel] rendered', {
                timestamp: new Date().toISOString(),
                cardCount: data.cardCount,
            });
        } else if (data.type === 'commit' && repo && typeof data.message === 'string' && typeof data.amend === 'boolean'
            && Array.isArray(data.repositoryPaths)
            && data.repositoryPaths.every(repositoryPath => typeof repositoryPath === 'string')) {
            this.callbacks.onCommit(repo, data.repositoryPaths as string[], data.message, data.amend);
        } else if (data.type === 'toggleAmend' && repo && typeof data.message === 'string') {
            this.callbacks.onToggleAmend(repo, data.message);
        } else if (data.type === 'gitSync' && data.action === 'push' && typeof data.pullBeforePush === 'boolean'
            && Array.isArray(data.repositoryPaths)
            && data.repositoryPaths.every(repositoryPath => typeof repositoryPath === 'string')) {
            this.callbacks.onPush(data.repositoryPaths as string[], data.pullBeforePush);
        } else if (data.type === 'pickPushBranch' && repo) {
            this.callbacks.onPickPushBranch(repo);
        } else if (data.type === 'updateCardState' && repo && data.patch && typeof data.patch === 'object') {
            const patch = data.patch as Record<string, unknown>;
            const selectedCommitSubmoduleRepositoryPaths = Array.isArray(patch.selectedCommitSubmoduleRepositoryPaths)
                && patch.selectedCommitSubmoduleRepositoryPaths.every(repositoryPath => typeof repositoryPath === 'string')
                ? patch.selectedCommitSubmoduleRepositoryPaths as string[] : undefined;
            const selectedPushSubmoduleRepositoryPaths = Array.isArray(patch.selectedPushSubmoduleRepositoryPaths)
                && patch.selectedPushSubmoduleRepositoryPaths.every(repositoryPath => typeof repositoryPath === 'string')
                ? patch.selectedPushSubmoduleRepositoryPaths as string[] : undefined;
            if ((patch.message === undefined || typeof patch.message === 'string')
                && (patch.pullBeforePush === undefined || typeof patch.pullBeforePush === 'boolean')) {
                this.callbacks.onUpdateCardState(repo, {
                    message: patch.message as string | undefined,
                    selectedCommitSubmoduleRepositoryPaths,
                    selectedPushSubmoduleRepositoryPaths,
                    pullBeforePush: patch.pullBeforePush as boolean | undefined,
                });
            }
        } else if (data.type === 'toggleDisplayMode') {
            this.callbacks.onToggleDisplayMode();
        } else if (data.type === 'history' && repo) {
            this.callbacks.onHistory(repo);
        } else if (data.type === 'focusRepository' && repo) {
            this.callbacks.onFocusRepository(repo);
        } else if (data.type === 'selectFile' && repo
            && (data.section === 'staged' || data.section === 'unstaged')
            && typeof data.path === 'string') {
            this.callbacks.onSelectFile(repo, data.section, data.path);
        } else if (data.type === 'workingTreeAction' && repo
            && (data.action === 'stage' || data.action === 'unstage' || data.action === 'discard')
            && (data.section === 'staged' || data.section === 'unstaged')
            && Array.isArray(data.paths)
            && data.paths.every(filePath => typeof filePath === 'string')
            && Array.isArray(data.untrackedPaths)
            && data.untrackedPaths.every(filePath => typeof filePath === 'string')) {
            this.callbacks.onWorkingTreeAction(
                repo,
                data.action,
                data.section,
                data.paths as string[],
                data.untrackedPaths as string[],
            );
        } else if (data.type === 'error') {
            console.error('[gitk-commit]', data.message);
        }
    }

    private publish(): void {
        if (!this.panel || !this.webviewReady || !this.snapshot) { return; }
        if (this.publishedSnapshot === this.snapshot) { return; }
        const snapshot = this.snapshot;
        this.publishedSnapshot = snapshot;
        void this.panel.webview.postMessage({ type: 'snapshot', cards: snapshot.cards, displayMode: snapshot.displayMode })
            .then(() => console.log('[Gitk][CommitPanel] snapshot posted', {
                timestamp: new Date().toISOString(),
                cardCount: snapshot.cards.length,
            }));
    }

    private post(message: unknown): Promise<void> {
        this.postQueue = this.postQueue
            .catch(() => undefined)
            .then(() => this.panel?.webview.postMessage(message));
        return this.postQueue.then(() => undefined);
    }

    private getHtml(codiconsRoot: vscode.Uri, initialSnapshot: CommitPanelSnapshot): string {
        const webview = this.panel!.webview;
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css'));
        const nonce = randomBytes(16).toString('base64');
        // 首屏数据作为 JSON 数据块内联: 转义 '<' 可阻断内容里出现的 "</script>" 提前闭合标签。
        const initialSnapshotJson = JSON.stringify(initialSnapshot).replace(/</g, '\\u003c');
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
        return renderCommitPanelHtml(String(codiconCssUri), nonce, csp, initialSnapshotJson);
    }
}
