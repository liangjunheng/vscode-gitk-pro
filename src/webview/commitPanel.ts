import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

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
    private postQueue: Promise<unknown> = Promise.resolve();
    private pendingFocusRepositoryPath?: string;

    constructor(private readonly callbacks: CommitPanelCallbacks) {}

    show(snapshot: CommitPanelSnapshot, focusRepositoryPath?: string): void {
        this.snapshot = snapshot;
        const isNew = !this.panel;
        this.ensurePanel();
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

    /** 定位到指定仓库卡片, 不重新渲染。 */
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

    private ensurePanel(): void {
        if (this.panel) { return; }
        this.webviewReady = false;
        this.postQueue = Promise.resolve();
        const codiconsRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..', 'media', 'codicons');
        this.panel = vscode.window.createWebviewPanel('vscode-gitk.commit', 'Commit', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [codiconsRoot],
        });
        this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
        this.panel.onDidDispose(() => { this.panel = undefined; this.webviewReady = false; this.pendingFocusRepositoryPath = undefined; });
        this.panel.webview.html = this.getHtml(codiconsRoot);
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
        this.post({ type: 'snapshot', cards: this.snapshot.cards, displayMode: this.snapshot.displayMode })
            .then(() => console.log('[Gitk][CommitPanel] snapshot posted', {
                timestamp: new Date().toISOString(),
                cardCount: this.snapshot?.cards.length,
            }));
    }

    private post(message: unknown): Promise<void> {
        this.postQueue = this.postQueue
            .catch(() => undefined)
            .then(() => this.panel?.webview.postMessage(message));
        return this.postQueue.then(() => undefined);
    }

    private getHtml(codiconsRoot: vscode.Uri): string {
        const webview = this.panel!.webview;
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css'));
        const nonce = randomBytes(16).toString('base64');
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconCssUri}">
<style>
:root{color-scheme:light dark;--card-radius:9px;--card-border:1px;--card-ring:1px;--header-surface:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground))}
*{box-sizing:border-box}
/* 与 MultiDiff 一致: 偏暗背板 + 卡片浮起, 视觉统一。 */
body{margin:0;padding-bottom:14px;background:color-mix(in srgb, var(--vscode-editor-background) 50%, #000);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
#app{width:100%;padding:8px}
.card{position:relative;width:100%;margin:0 0 14px;display:flex;flex-direction:column;border:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius);background:var(--vscode-editor-background);box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:visible}
/* 卡片标题吸顶, 与 MultiDiff 的 file-header 行为一致。 */
.card-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--header-surface);font-weight:600;border-bottom:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.repo-label{white-space:nowrap}
.repository-ancestry{display:inline-flex;align-items:center;gap:3px;min-width:0;color:var(--vscode-descriptionForeground);font-size:inherit;font-weight:400;opacity:.65}
.repository-ancestry[hidden]{display:none}
.repository-ancestry-link{border:0;padding:0;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.repository-ancestry-link:hover{text-decoration:underline;color:var(--vscode-textLink-foreground)}
.repository-ancestry-separator{opacity:.8}
.repository-icon{display:inline-flex;width:16px;height:16px;flex:0 0 16px;color:var(--vscode-icon-foreground)}
.repository-icon.has-submodules{color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-icon-foreground))}
.repository-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.card.selected-card{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder),0 1px 4px rgba(0,0,0,.12)}
.card.selected-card .card-header{border-bottom-color:var(--vscode-focusBorder)}
.card-header .codicon{font-size:15px;color:var(--vscode-icon-foreground)}
.card.collapsible-card .card-header{cursor:pointer}
/* 折叠后只剩标题栏: 去掉多余底边框, 让标题栏自身呈完整卡片外观。 */
.card.collapsed .card-header{border-bottom:0;border-radius:var(--card-radius);box-shadow:none}
.card.collapsible-card .card-header:hover{background:var(--vscode-list-hoverBackground)}
.card-empty-tag{margin-left:6px;padding:2px 7px;border-radius:9px;background:#2e7d32;color:#fff;font-weight:600;font-size:calc(var(--vscode-editor-font-size) * .85);line-height:16px}
.card-empty-tag:empty{display:none}
.section-count-badge,.repository-status-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;font-weight:600;line-height:18px}
.section-count-badge[hidden],.repository-status-badge[hidden]{display:none}
.card-body{display:flex;flex-direction:column;gap:10px;padding:10px 12px}
/* 作者样式 display:flex 会覆盖 hidden 的 UA 默认 display:none，必须显式声明。 */
.card-body[hidden]{display:none}
.message-box{position:relative;display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:6px;overflow:hidden}
.message-input{box-sizing:border-box;width:100%;min-height:calc(3 * 1.5em + 20px);resize:none;overflow-y:hidden;border:0;outline:0;padding:10px 42px 32px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5}
.actions{display:flex;gap:8px;align-items:stretch;flex-direction:column}
.hint{min-width:120px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size) * .9)}
.action-groups{display:flex;gap:8px;align-items:stretch;flex-direction:column;width:100%}
.action-group{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:7px;background:var(--vscode-editorWidget-background)}
.commit-group{border-color:var(--vscode-button-background)}
.submodule-group{max-width:100%;overflow:visible}
.commit-submodule-prefix,.submodule-prefix{display:none}
.commit-submodule-selector,.submodule-group .submodule-selector{display:block;flex:1 1 240px;min-width:180px;max-width:none;align-self:stretch;order:2}
.commit-group .commit-btn{order:0}
.commit-group .commit-option{order:1;flex:0 0 auto}
.submodule-group .push-btn{order:0}
.submodule-group .pull-option{order:1;flex:0 0 auto}
.submodule-inline-box{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:40px;box-sizing:border-box;border:1px dashed var(--vscode-focusBorder,var(--vscode-widget-border));border-radius:8px;padding:7px 10px;background:transparent;color:var(--vscode-foreground)}
.submodule-inline-title{flex:0 0 auto;min-width:5.5em;padding:2px 10px 2px 0;border-right:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .9);font-weight:600;line-height:20px;white-space:nowrap}
.submodule-inline-options{display:flex;flex:1 1 auto;flex-wrap:wrap;align-items:stretch;gap:6px;max-height:100px;min-width:0;overflow:auto}
.submodule-inline-option{display:inline-flex;align-items:center;gap:5px;min-height:24px;box-sizing:border-box;padding:3px 7px;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:5px;background:var(--vscode-list-inactiveSelectionBackground);white-space:nowrap;cursor:pointer;font-size:calc(var(--vscode-editor-font-size) * .9);transition:border-color .12s ease,background .12s ease}
.submodule-inline-repository{border:0;padding:0;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;cursor:pointer;white-space:nowrap}
.submodule-inline-repository:hover{text-decoration:underline;color:var(--vscode-textLink-activeForeground)}
.submodule-inline-option .repository-status-badge{height:18px;line-height:18px}
.submodule-push-target{margin-left:auto;border:0;border-left:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));padding:0 0 0 7px;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;font-size:calc(var(--vscode-editor-font-size) * .85);cursor:pointer;white-space:nowrap}
.submodule-push-target:hover{text-decoration:underline;color:var(--vscode-textLink-activeForeground)}
.submodule-inline-option:hover{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
.submodule-inline-option:has(input:checked){border-color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 12%,transparent)}
.submodule-inline-option input{margin:0;accent-color:var(--vscode-checkbox-background,var(--vscode-button-background))}
.submodule-inline-empty{line-height:20px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .9)}
.commit-options{display:inline-flex;align-items:center;gap:8px}
.history-btn{box-sizing:border-box;height:calc(1em + 12px);min-width:calc(1em + 16px);border:0;padding:0 8px;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;font:inherit}
.history-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.message-history-btn{position:absolute;right:4px;bottom:4px;z-index:1}
.history-btn .codicon{font-size:14px}
.submodule-selector{position:relative;display:inline-flex;align-items:center}
.submodule-selector[hidden]{display:none}
/* 这里位于外层 HTML 模板字符串内，内嵌脚本的反斜杠必须保留。 */
.submodule-selector-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:5px;width:auto;max-width:100%;min-width:7em;border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:2px;padding:5px 8px;background:var(--vscode-dropdown-background,var(--vscode-editorWidget-background));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));cursor:pointer;font:inherit}
.submodule-selector-label{min-width:0;max-width:36em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.submodule-selector-btn:hover{background:var(--vscode-list-hoverBackground)}
.submodule-selector-btn:disabled{opacity:.55;cursor:default}
.submodule-selector-chevron{font-size:12px;transition:transform .12s ease}
.submodule-selector-btn[aria-expanded="true"] .submodule-selector-chevron{transform:rotate(180deg)}
.submodule-dropdown{position:absolute;right:0;top:calc(100% + 4px);z-index:1000;display:flex;flex-direction:column;min-width:280px;max-width:min(480px,calc(100vw - 24px));max-height:min(420px,calc(100vh - 24px));padding:6px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));border-radius:2px;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.submodule-dropdown[hidden]{display:none}
.submodule-dropdown-title{padding:5px 8px;color:var(--vscode-menu-foreground,var(--vscode-foreground));font-weight:600}
.submodule-dropdown-filter{width:100%;box-sizing:border-box;margin:2px 0 6px;padding:5px 7px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border));outline:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}
.submodule-dropdown-filter:focus{border-color:var(--vscode-focusBorder)}
.submodule-dropdown-options{min-height:24px;overflow:auto}
.submodule-dropdown-option{display:flex;align-items:center;gap:7px;padding:5px 8px;color:var(--vscode-menu-foreground,var(--vscode-foreground));cursor:pointer}
.submodule-dropdown-option:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground))}
.submodule-dropdown-option input{margin:0;accent-color:var(--vscode-checkbox-background,var(--vscode-button-background))}
.submodule-dropdown-empty{padding:7px 8px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .9)}
.submodule-dropdown-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;padding:6px 8px 2px;border-top:1px solid var(--vscode-menu-separatorBackground,var(--vscode-widget-border))}
.submodule-dropdown-action{border:0;border-radius:2px;padding:4px 9px;background:transparent;color:var(--vscode-menu-foreground,var(--vscode-foreground));cursor:pointer;font:inherit}
.submodule-dropdown-action:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground))}
.commit-option,.pull-option{display:inline-flex;align-items:center;gap:4px;color:var(--vscode-foreground);font-size:var(--vscode-editor-font-size);cursor:pointer;user-select:none}
.pull-option input{margin:0;accent-color:var(--vscode-checkbox-background,var(--vscode-button-background))}
.commit-option input{margin:0;accent-color:var(--vscode-button-background)}
.commit-option input:disabled+span{opacity:.5}
.commit-btn,.push-btn{flex:0 0 auto;border:0;border-radius:5px;padding:6px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font:inherit}
.commit-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.commit-btn:hover{background:var(--vscode-button-hoverBackground)}
.push-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.push-btn:hover{background:var(--vscode-button-hoverBackground)}
.push-btn{display:inline-flex;align-items:center;gap:8px}
.push-target-label{max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:1px solid color-mix(in srgb,currentColor 45%,transparent);padding-left:8px;font-size:calc(var(--vscode-editor-font-size) * .85);opacity:.85}

.commit-btn:disabled,.push-btn:disabled{opacity:1;cursor:pointer}
.commit-option input:disabled{cursor:default}
.commit-option input:disabled+span{cursor:default}
.section{display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:6px;overflow:hidden}
.section[hidden]{display:none}
.section.committed .file-row{cursor:default}
.section-title{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:var(--vscode-editorWidget-background);font-weight:600;font-size:calc(var(--vscode-font-size) * .95)}
.section-title.collapsible{cursor:pointer;user-select:none}
.section-title .left{display:flex;align-items:center;gap:4px}
.section-title .section-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
.section-title .codicon{font-size:14px}
.display-mode-btn{margin-left:4px}
.file-row,.folder-row{display:flex;align-items:center;gap:6px;padding:3px 10px}
.gitlink-label{display:inline-flex;align-items:center;flex:0 0 auto;margin:0 1.5px 0 0;padding:0 6px;border:1px solid var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-badge-background));border-radius:8px;background:color-mix(in srgb,var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-badge-background)) 12%,transparent);color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-badge-foreground));font-size:10px;font-weight:600;line-height:16px;letter-spacing:.02em}
.file-row:hover,.folder-row:hover{background:var(--vscode-list-hoverBackground)}
.file-row .status{width:14px;text-align:center;color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.file-row .path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(var(--vscode-editor-font-size) * .9)}
.file-row .file-folder{opacity:.55}
.file-row.staged .file-name{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.file-row.unstaged .file-name{color:var(--vscode-textLink-foreground,#3794ff)}
.file-row.untracked .file-name{color:var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)}
.folder-row{cursor:pointer;font-weight:600}
.folder-row .codicon{font-size:14px}
.folder-row .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-row .row-actions,.file-row .row-actions .icon-btn,.file-row .row-actions .codicon{opacity:1}
.file-row .row-actions{display:flex;gap:4px}
.icon-btn{border:0;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;padding:2px;border-radius:3px;display:inline-flex;align-items:center}
.icon-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.icon-btn:disabled{opacity:.35;cursor:default}
.icon-btn:disabled:hover{background:transparent}
.icon-btn .codicon{font-size:14px}
.empty{padding:6px 10px;color:var(--vscode-descriptionForeground)}
.no-repos{padding:20px;color:var(--vscode-descriptionForeground);text-align:center}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
(function(){
  const vscode=acquireVsCodeApi();
  const app=document.getElementById('app');
  const cardEls=new Map();
  const collapsedFolders=new Set();
  let selectedRepositoryPath='';
  let displayMode='flat';
  let currentCards=[];

  function selectCard(repositoryPath){
    selectedRepositoryPath=repositoryPath;
    cardEls.forEach(function(card){card.classList.toggle('selected-card',card.dataset.repo===repositoryPath)});
  }

  function statusLabel(file){return file.isUntracked?'U':(file.status||'M').slice(0,1).toUpperCase()}
  function isGitlinkFile(file){return file.isSubmodule===true}
  function isDescendantRepository(candidate,parentPath){return candidate.repositoryAncestry.some(function(ancestor){return ancestor.path===parentPath})}
  function changedGitlinkDescendants(card){
    const changedPaths=new Set(card.changedSubmoduleRepositoryPaths||[]);
    return currentCards.filter(function(item){return changedPaths.has(item.repositoryPath)&&(item.stagedFiles.length>0||item.unstagedFiles.length>0)});
  }
  function pushedDescendants(card){
    const result=[];
    function collect(parent){
      const directPaths=new Set(parent.latestCommitSubmodulePaths||[]);
      currentCards.filter(function(item){return item.repositoryParentPath===parent.repositoryPath&&item.hasUnpushedCommits}).forEach(function(child){
        // 只有当前提交包含的 gitlink 才能继续递归匹配嵌套子模块。
        const relative=child.repositoryPath.startsWith(parent.repositoryPath)?child.repositoryPath.slice(parent.repositoryPath.length).replace(/^[/\\\\]+/,''):'';
        if(directPaths.has(relative)){result.push(child);collect(child)}
      });
    }
    collect(card);return result;
  }
  function descendantLabel(submodule,card){
    const start=submodule.repositoryAncestry.findIndex(function(ancestor){return ancestor.path===card.repositoryPath});
    const label=submodule.repositoryAncestry.slice(start+1).map(function(ancestor){return ancestor.label}).concat(submodule.repositoryLabel).join('/');
    return label;
  }
  function updateInlineSubmoduleSelector(selector,card,submodules,selectionField,title){
    selector.hidden=false;
    selector.replaceChildren();
    const selected=new Set(card[selectionField]||[]);
    const publishSelection=function(){
      vscode.postMessage({type:'updateCardState',repositoryPath:card.repositoryPath,patch:{[selectionField]:Array.from(selected)}});
    };
    const box=document.createElement('div');box.className='submodule-inline-box';
    selector.appendChild(box);
    const heading=document.createElement('div');heading.className='submodule-inline-title';heading.textContent=title;box.appendChild(heading);
    const options=document.createElement('div');options.className='submodule-inline-options';box.appendChild(options);
    const allLabel=document.createElement('label');allLabel.className='submodule-inline-option submodule-inline-all';
    allLabel.innerHTML='<input type="checkbox"><span>全选</span>';options.appendChild(allLabel);
    const allInput=allLabel.querySelector('input');
    const updateAll=function(){const inputs=Array.from(options.querySelectorAll('.submodule-inline-item'));allInput.checked=inputs.length>0&&inputs.every(function(input){return input.checked});allInput.indeterminate=!allInput.checked&&inputs.some(function(input){return input.checked})};
    const inputs=submodules.map(function(submodule){
      const label=document.createElement('label');label.className='submodule-inline-option';
      const input=document.createElement('input');input.type='checkbox';input.className='submodule-inline-item';input.checked=selected.has(submodule.repositoryPath);input.dataset.path=submodule.repositoryPath;
      const repository=document.createElement('button');repository.type='button';repository.className='submodule-inline-repository';repository.textContent=descendantLabel(submodule,card);repository.title='跳转到 '+submodule.repositoryLabel+' 的提交卡片';repository.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();vscode.postMessage({type:'focusRepository',repositoryPath:submodule.repositoryPath})});
      label.appendChild(input);label.appendChild(repository);
      if(title==='同时提交子模块'){
        const staged=document.createElement('span');staged.className='repository-status-badge';staged.textContent=submodule.stagedFiles.length?'Staged '+submodule.stagedFiles.length:'';staged.hidden=submodule.stagedFiles.length===0;
        const unstaged=document.createElement('span');unstaged.className='repository-status-badge';unstaged.textContent=submodule.unstagedFiles.length?'Unstaged '+submodule.unstagedFiles.length:'';unstaged.hidden=submodule.unstagedFiles.length===0;
        label.appendChild(unstaged);label.appendChild(staged);
      }else{
        const commits=document.createElement('span');commits.className='repository-status-badge';commits.textContent='Commits '+submodule.unpushedCommitCount;label.appendChild(commits);
        const target=document.createElement('button');target.type='button';target.className='submodule-push-target';target.textContent=submodule.pushTargetLabel||'选择分支';target.title='选择 '+submodule.repositoryLabel+' 的推送分支';target.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();vscode.postMessage({type:'pickPushBranch',repositoryPath:submodule.repositoryPath})});label.appendChild(target);
      }
      options.appendChild(label);
      input.addEventListener('change',function(){if(input.checked)selected.add(submodule.repositoryPath);else selected.delete(submodule.repositoryPath);updateAll();publishSelection()});
      return input;
    });
    allInput.addEventListener('change',function(){inputs.forEach(function(input){input.checked=allInput.checked;if(input.checked)selected.add(input.dataset.path);else selected.delete(input.dataset.path)});updateAll();publishSelection()});
    updateAll();
  }
  function updateCommitSelector(el,card){
    const selector=el.querySelector('.commit-submodule-selector');
    const submodules=card.amend?[]:changedGitlinkDescendants(card);
    selector.hidden=submodules.length===0;
    if(submodules.length===0)return;
    updateInlineSubmoduleSelector(selector,card,submodules,'selectedCommitSubmoduleRepositoryPaths','同时提交子模块');
  }
  function updatePushSelector(el,card){
    const group=el.querySelector('.submodule-group');
    const submodules=card.repositoryHasSubmodules?pushedDescendants(card):[];
    group.hidden=submodules.length===0;
    if(submodules.length===0)return;
    const selector=group.querySelector('.push-submodule-selector');
    updateInlineSubmoduleSelector(selector,card,submodules,'selectedPushSubmoduleRepositoryPaths','同时推送子模块');
  }

  function actionButton(action,section,path,icon,title){
    const button=document.createElement('button');
    button.className='icon-btn';
    button.dataset.action=action;
    button.dataset.section=section;
    button.dataset.path=path;
    button.title=title;
    const iconElement=document.createElement('span');
    iconElement.className='codicon codicon-'+icon;
    button.appendChild(iconElement);
    return button;
  }
  function fileParts(file){
    const lastSlash=file.path.lastIndexOf('/');
    return {
      folder:lastSlash>=0?file.path.slice(0,lastSlash):'',
      name:lastSlash>=0?file.path.slice(lastSlash+1):file.path,
    };
  }

  function fileRowHtml(file,section,treeIndent){
    const parts=fileParts(file);
    const row=document.createElement('div');
    row.className='file-row '+(file.isUntracked?'untracked':section);
    row.dataset.path=file.path;
    row.dataset.section=section;
    if(treeIndent)row.style.paddingLeft='30px';
    const status=document.createElement('span');
    status.className='status';
    status.textContent=statusLabel(file);
    const gitlinkLabel=isGitlinkFile(file)?document.createElement('span'):null;
    if(gitlinkLabel){gitlinkLabel.className='gitlink-label';gitlinkLabel.textContent='Repo';gitlinkLabel.title='Submodule repository';}
    const pathElement=document.createElement('span');
    pathElement.className='path';
    pathElement.title=file.path;
    const nameElement=document.createElement('span');
    nameElement.className='file-name';
    nameElement.textContent=parts.name;
    pathElement.appendChild(nameElement);
    if(displayMode==='flat'&&parts.folder){
      pathElement.appendChild(document.createTextNode(' '));
      const folderElement=document.createElement('span');
      folderElement.className='file-folder';
      folderElement.textContent=parts.folder+'/';
      pathElement.appendChild(folderElement);
    }
    const actions=document.createElement('span');
    actions.className='row-actions';
    if(section==='staged'){
      actions.appendChild(actionButton('unstage',section,file.path,'remove','取消暂存'));
    }else if(section==='unstaged'){
      actions.appendChild(actionButton('discard',section,file.path,'discard','放弃更改'));
      actions.appendChild(actionButton('stage',section,file.path,'add','暂存'));
    }
    if(gitlinkLabel)row.appendChild(gitlinkLabel);
    row.appendChild(status);
    row.appendChild(pathElement);
    row.appendChild(actions);
    return row;
  }

  function renderFileList(container,files,section,repositoryPath){
    container.replaceChildren();
    if(!files.length){
      const empty=document.createElement('div');
      empty.className='empty';
      empty.textContent=section==='staged'?'没有已暂存的更改':(section==='unstaged'?'没有未暂存的更改':'没有已提交的更改');
      container.appendChild(empty);
      return;
    }
    const ordered=files;
    if(displayMode==='flat'){
      ordered.forEach(function(file){container.appendChild(fileRowHtml(file,section,false))});
      return;
    }
    const byFolder=new Map();
    ordered.forEach(function(file){
      const folder=fileParts(file).folder;
      const group=byFolder.get(folder)||[];
      group.push(file);
      byFolder.set(folder,group);
    });
    byFolder.forEach(function(folderFiles,folder){
      const folderKey=repositoryPath+':'+section+':'+folder;
      if(folder){
        const expanded=!collapsedFolders.has(folderKey);
        const folderRow=document.createElement('div');
        folderRow.className='folder-row';
        folderRow.innerHTML='<span class="codicon codicon-chevron-'+(expanded?'down':'right')+'"></span><span class="codicon codicon-folder'+(expanded?'-opened':'')+'"></span><span class="path"></span>';
        folderRow.querySelector('.path').textContent=folder;
        folderRow.title=folder;
        folderRow.addEventListener('click',function(){
          if(expanded)collapsedFolders.add(folderKey);else collapsedFolders.delete(folderKey);
          renderFileList(container,files,section,repositoryPath);
          bindRowActions(container,repositoryPath,container.closest('.card')._card);
        });
        container.appendChild(folderRow);
        if(!expanded)return;
      }
      folderFiles.forEach(function(file){container.appendChild(fileRowHtml(file,section,Boolean(folder)))});
    });
  }

  function resizeMessageInput(input){input.style.height='auto';input.style.height=input.scrollHeight+'px'}

  function buildCard(repo){
    const el=document.createElement('div');
    el.className='card';
    el.dataset.repo=repo;
    el.innerHTML=
      '<div class="card-header"><span class="codicon codicon-chevron-down card-chevron"></span><span class="repository-icon card-repository-icon" aria-hidden="true"></span><span class="repo-label"></span><span class="repository-ancestry" hidden></span><span class="repository-status-badge untracked-count"></span><span class="repository-status-badge unstaged-header-count"></span><span class="repository-status-badge staged-header-count"></span><span class="card-empty-tag"></span></div>'+
      '<div class="card-body">'+
        '<div class="message-box">'+
          '<textarea class="message-input" rows="3" placeholder="输入提交信息…" spellcheck="false"></textarea>'+
          '<button class="history-btn message-history-btn" type="button" title="历史提交信息"><span class="codicon codicon-history"></span></button>'+
        '</div>'+
        '<div class="section unstaged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down unstaged-chevron"></span><span>Unstaged Changes</span><span class="section-count-badge unstaged-count" hidden></span></span><span class="section-actions unstaged-actions"><button class="icon-btn discard-all" data-action="discard" data-section="unstaged" title="还原所有文件"><span class="codicon codicon-discard"></span></button><button class="icon-btn stage-all" data-action="stage" data-section="unstaged" title="暂存所有文件"><span class="codicon codicon-add"></span></button></span></div><div class="unstaged-list"></div></div>'+
        '<div class="section staged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down staged-chevron"></span><span>Staged Changes</span><span class="section-count-badge staged-count" hidden></span></span><span class="section-actions staged-actions"><button class="icon-btn display-mode-btn" title="切换树状/平铺显示"><span class="codicon codicon-list-tree"></span></button><button class="icon-btn staged-all" data-action="unstage" data-section="staged" title="取消暂存所有文件"><span class="codicon codicon-remove"></span></button></span></div><div class="staged-list"></div></div>'+
        '<div class="section committed" hidden><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down committed-chevron"></span><span>Committed Changes</span><span class="section-count-badge committed-count" hidden></span></span></div><div class="committed-list"></div></div>'+
        '<div class="actions">'+
          '<span class="hint"></span>'+
          '<div class="action-groups">'+
            '<span class="action-group commit-group">'+
              '<label class="commit-option"><input class="amend-checkbox" type="checkbox"><span>Amend</span></label>'+
              '<span class="commit-submodule-selector submodule-selector"></span>'+
              '<button class="commit-btn">Commit</button>'+
            '</span>'+
            '<span class="action-group submodule-group">'+
              '<button class="push-btn"><span>Push</span><span class="push-target-label"></span></button>'+
              '<label class="pull-option"><input class="pull-before-push-checkbox" type="checkbox" checked><span>Pull</span></label>'+
              '<span class="submodule-selector push-submodule-selector"></span>'+
            '</span>'+
          '</div>'+
        '</div>'+
      '</div>';
    // 空仓库卡片默认折叠；三个变更区域默认展开。
    const state={unstagedOpen:true,stagedOpen:true,committedOpen:true};
    const messageInput=el.querySelector('.message-input');
    const commitBtn=el.querySelector('.commit-btn');
    const pushBtn=el.querySelector('.push-btn');
    const pullBeforePushCheckbox=el.querySelector('.pull-before-push-checkbox');
    const amendCheckbox=el.querySelector('.amend-checkbox');
    const historyBtn=el.querySelector('.history-btn');
    historyBtn.type='button';
    historyBtn.classList.add('message-history-btn');
    const hint=el.querySelector('.hint');
    const unstagedTitle=el.querySelector('.section.unstaged .section-title');
    const unstagedList=el.querySelector('.unstaged-list');
    const unstagedChevron=el.querySelector('.unstaged-chevron');
    const stagedTitle=el.querySelector('.section.staged .section-title');
    const stagedList=el.querySelector('.staged-list');
    const stagedChevron=el.querySelector('.staged-chevron');
    const committedTitle=el.querySelector('.section.committed .section-title');
    const committedList=el.querySelector('.committed-list');
    const committedChevron=el.querySelector('.committed-chevron');
    const cardHeader=el.querySelector('.card-header');
    const cardChevron=el.querySelector('.card-chevron');
    const cardBody=el.querySelector('.card-body');

    el.addEventListener('click',function(){selectCard(repo)});
    // 仅无任何未提交文件的仓库可折叠; 有变更的仓库强制展开、不可折叠。
    cardHeader.addEventListener('click',function(){
      if(!el._collapsible)return;
      state.cardCollapsed=!state.cardCollapsed;
      cardBody.hidden=state.cardCollapsed;
      el.classList.toggle('collapsed',state.cardCollapsed);
      cardChevron.className='codicon codicon-chevron-'+(state.cardCollapsed?'right':'down')+' card-chevron';
    });

    amendCheckbox.addEventListener('change',function(){vscode.postMessage({type:'toggleAmend',repositoryPath:repo,message:messageInput.value})});
    pushBtn.addEventListener('click',function(){
      vscode.postMessage({type:'gitSync',action:'push',repositoryPaths:[...(el._card.selectedPushSubmoduleRepositoryPaths||[]),repo],pullBeforePush:pullBeforePushCheckbox.checked});
    });
    historyBtn.addEventListener('click',function(){vscode.postMessage({type:'history',repositoryPath:repo})});
    el.querySelector('.display-mode-btn').addEventListener('click',function(event){
      event.stopPropagation();
      vscode.postMessage({type:'toggleDisplayMode'});
    });
    el.querySelectorAll('.section-actions .icon-btn[data-action]').forEach(function(button){
      button.addEventListener('click',function(event){
        event.stopPropagation();
        const files=button.dataset.section==='staged'?el._card.stagedFiles:el._card.unstagedFiles;
        vscode.postMessage({
          type:'workingTreeAction',
          repositoryPath:repo,
          action:button.dataset.action,
          section:button.dataset.section,
          paths:files.map(function(file){return file.path}),
          untrackedPaths:files.filter(function(file){return file.isUntracked}).map(function(file){return file.path}),
        });
      });
    });
    commitBtn.addEventListener('click',function(){
      const message=el._card.message.trim();
      if(!message){hint.textContent='提交信息不能为空';messageInput.focus();return}
      vscode.postMessage({type:'commit',repositoryPath:repo,repositoryPaths:[...(el._card.selectedCommitSubmoduleRepositoryPaths||[]),repo],message:el._card.message,amend:el._amend===true});
    });
    messageInput.addEventListener('input',function(){hint.textContent='';resizeMessageInput(messageInput);vscode.postMessage({type:'updateCardState',repositoryPath:repo,patch:{message:messageInput.value}})});
    pullBeforePushCheckbox.addEventListener('change',function(){vscode.postMessage({type:'updateCardState',repositoryPath:repo,patch:{pullBeforePush:pullBeforePushCheckbox.checked}})});
    resizeMessageInput(messageInput);
    messageInput.addEventListener('keydown',function(event){
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();commitBtn.click()}
    });
    function bindSection(title,list,chevron,key){
      title.addEventListener('click',function(event){
        event.stopPropagation();
        state[key]=!state[key];
        list.hidden=!state[key];
        chevron.className='codicon codicon-chevron-'+(state[key]?'down':'right')+' '+key.replace('Open','')+'-chevron';
      });
    }
    bindSection(unstagedTitle,unstagedList,unstagedChevron,'unstagedOpen');
    bindSection(stagedTitle,stagedList,stagedChevron,'stagedOpen');
    bindSection(committedTitle,committedList,committedChevron,'committedOpen');

    state.cardCollapsed=false;
    el._state=state;
    el._refs={messageInput,commitBtn,pushBtn,amendCheckbox,hint,unstagedList,stagedList,committedList,unstagedChevron,stagedChevron,committedChevron,cardChevron,cardBody,cardHeader};
    return el;
  }

  function bindRowActions(container,repo,card){
    container.querySelectorAll('.file-row').forEach(function(row){
      row.addEventListener('click',function(){
        vscode.postMessage({type:'selectFile',repositoryPath:repo,section:row.dataset.section,path:row.dataset.path});
      });
    });
    container.querySelectorAll('.icon-btn').forEach(function(btn){
      btn.addEventListener('click',function(event){
        event.stopPropagation();
        const filePath=btn.dataset.path;
        const file=card[btn.dataset.section==='staged'?'stagedFiles':'unstagedFiles'].find(function(item){return item.path===filePath});
        vscode.postMessage({
          type:'workingTreeAction',
          repositoryPath:repo,
          action:btn.dataset.action,
          section:btn.dataset.section,
          paths:[filePath],
          untrackedPaths:file&&file.isUntracked?[filePath]:[],
        });
      });
    });
  }

  function updateCard(el,card){
    el._card=card;
    el._amend=card.amend;
    const repositoryIcon=el.querySelector('.card-repository-icon');
    repositoryIcon.classList.toggle('has-submodules',card.repositoryHasSubmodules);
    repositoryIcon.innerHTML=card.repositoryHasSubmodules
      ? '<svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/><rect x="5" y="7.5" width="6" height="3.5" rx="0.5"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/></svg>';
    el.querySelector('.repo-label').textContent=card.repositoryLabel;
    const ancestry=el.querySelector('.repository-ancestry');
    ancestry.replaceChildren();
    card.repositoryAncestry.forEach(function(repository,index){
      if(index===0){
        const marker=document.createElement('span');
        marker.className='repository-ancestry-marker';
        marker.textContent='⌘';
        ancestry.appendChild(marker);
      }
      if(index>0){
        const separator=document.createElement('span');
        separator.className='repository-ancestry-separator';
        separator.textContent='/';
        ancestry.appendChild(separator);
      }
      const link=document.createElement('button');
      link.type='button';
      link.className='repository-ancestry-link';
      link.textContent=repository.label;
      link.title='跳转到 '+repository.label+' 的提交卡片';
      link.addEventListener('click',function(event){
        event.stopPropagation();
        vscode.postMessage({type:'focusRepository',repositoryPath:repository.path});
      });
      ancestry.appendChild(link);
    });
    if(card.repositoryAncestry.length){
      const trailingSeparator=document.createElement('span');
      trailingSeparator.className='repository-ancestry-separator';
      trailingSeparator.textContent='/';
      ancestry.appendChild(trailingSeparator);
    }
    ancestry.hidden=card.repositoryAncestry.length===0;
    const refs=el._refs;
    el.classList.toggle('selected-card',el.dataset.repo===selectedRepositoryPath);
    const isEmpty=card.stagedFiles.length===0&&card.unstagedFiles.length===0;
    refs.amendCheckbox.checked=card.amend;
    refs.amendCheckbox.disabled=false;
    if(refs.messageInput.value!==card.message){refs.messageInput.value=card.message;resizeMessageInput(refs.messageInput)}
    el.querySelector('.pull-before-push-checkbox').checked=card.pullBeforePush;
    refs.commitBtn.textContent=card.amend?'Amend':'Commit';
    const disableCommit=card.committing;
    refs.commitBtn.disabled=disableCommit;
    refs.pushBtn.disabled=false;
    const pushTargetLabel=el.querySelector('.push-target-label');
    pushTargetLabel.textContent=card.pushTargetLabel??'';
    pushTargetLabel.hidden=!card.pushTargetLabel;
    refs.hint.textContent=card.committing?'正在提交…':'';
    el._collapsible=isEmpty;
    el.querySelector('.card-empty-tag').textContent=isEmpty?'无更改':'';
    el.classList.toggle('collapsible-card',isEmpty);
    // 首次为空或由有变更转为空时默认折叠；持续为空时保留用户手动展开状态。
    if(!isEmpty){
      el._state.cardCollapsed=false;
    }else if(el._state.wasEmpty!==true){
      el._state.cardCollapsed=true;
    }
    el._state.wasEmpty=isEmpty;
    refs.cardBody.hidden=el._state.cardCollapsed;
    el.classList.toggle('collapsed',el._state.cardCollapsed);
    refs.cardChevron.hidden=!isEmpty;
    refs.cardChevron.className='codicon codicon-chevron-'+(el._state.cardCollapsed?'right':'down')+' card-chevron';
    const untrackedCount=card.unstagedFiles.filter(file=>file.isUntracked).length;
    const unstagedHeaderCount=card.unstagedFiles.length-untrackedCount;
    const updateRepositoryStatusBadge=function(selector,label,count){
      const badge=el.querySelector(selector);
      badge.textContent=count?label+' '+count:'';
      badge.hidden=count===0;
    };
    updateRepositoryStatusBadge('.untracked-count','Untracked',untrackedCount);
    updateRepositoryStatusBadge('.unstaged-header-count','Unstaged',unstagedHeaderCount);
    updateRepositoryStatusBadge('.staged-header-count','Staged',card.stagedFiles.length);
    const stagedList=el.querySelector('.staged-list');
    const committedSection=el.querySelector('.section.committed');
    const committedList=el.querySelector('.committed-list');
    const committedCount=el.querySelector('.committed-count');
    committedSection.hidden=!card.amend;
    if(card.amend){
      committedCount.textContent=card.committedFiles.length?String(card.committedFiles.length):'';
      committedCount.hidden=card.committedFiles.length===0;
      if(card.committedFilesLoading){
        committedList.innerHTML='<div class="empty">正在加载当前提交的文件…</div>';
      }else{
        renderFileList(committedList,card.committedFiles,'committed',el.dataset.repo);
      }
      committedList.hidden=!el._state.committedOpen;
      refs.committedChevron.className='codicon codicon-chevron-'+(el._state.committedOpen?'down':'right')+' committed-chevron';
    }
    const unstagedList=el.querySelector('.unstaged-list');
    const stagedCount=el.querySelector('.staged-count');
    stagedCount.textContent=card.stagedFiles.length?String(card.stagedFiles.length):'';
    stagedCount.hidden=card.stagedFiles.length===0;
    el.querySelector('.staged-all').disabled=card.stagedFiles.length===0;
    const unstagedCount=el.querySelector('.unstaged-count');
    unstagedCount.textContent=card.unstagedFiles.length?String(card.unstagedFiles.length):'';
    unstagedCount.hidden=card.unstagedFiles.length===0;
    el.querySelector('.discard-all').disabled=card.unstagedFiles.length===0;
    el.querySelector('.stage-all').disabled=card.unstagedFiles.length===0;
    const displayModeButton=el.querySelector('.display-mode-btn');
    displayModeButton.title='显示方式（当前：'+(displayMode==='tree'?'树状':'平铺')+'）';
    displayModeButton.querySelector('.codicon').className='codicon codicon-'+(displayMode==='tree'?'list-flat':'list-tree');
    renderFileList(stagedList,card.stagedFiles,'staged',el.dataset.repo);
    renderFileList(unstagedList,card.unstagedFiles,'unstaged',el.dataset.repo);
    stagedList.hidden=!el._state.stagedOpen;
    unstagedList.hidden=!el._state.unstagedOpen;
    refs.stagedChevron.className='codicon codicon-chevron-'+(el._state.stagedOpen?'down':'right')+' staged-chevron';
    refs.unstagedChevron.className='codicon codicon-chevron-'+(el._state.unstagedOpen?'down':'right')+' unstaged-chevron';
    updateCommitSelector(el,card);
    updatePushSelector(el,card);
    bindRowActions(stagedList,el.dataset.repo,card);
    bindRowActions(unstagedList,el.dataset.repo,card);
  }

  function captureViewportAnchor(){
    for(const el of cardEls.values()){
      const rect=el.getBoundingClientRect();
      if(rect.bottom>0)return {repositoryPath:el.dataset.repo||'',offset:rect.top};
    }
    return null;
  }

  function restoreViewportAnchor(anchor){
    if(!anchor)return;
    const el=cardEls.get(anchor.repositoryPath);
    if(!el)return;
    const delta=el.getBoundingClientRect().top-anchor.offset;
    if(Math.abs(delta)>=0.5)window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});
  }

  function render(cards){
    const viewportAnchor=captureViewportAnchor();
    // 先更新 currentCards，updatePushSelector 依赖它查找可推送的子模块。
    currentCards=cards;
    if(!cards.length){
      app.innerHTML='<div class="no-repos">没有可提交的仓库</div>';
      cardEls.clear();
      vscode.postMessage({type:'rendered',cardCount:0});
      return;
    }
    const seen=new Set();
    let previous=null;
    cards.forEach(function(card){
      seen.add(card.repositoryPath);
      let el=cardEls.get(card.repositoryPath);
      if(!el){el=buildCard(card.repositoryPath);cardEls.set(card.repositoryPath,el)}
      // 先更新 detached 卡片、再插入 app；更新异常会导致卡片未挂载，必须保证 updateCard 不抛错。
      updateCard(el,card);
      // 保持卡片顺序与快照一致, 复用已存在 DOM。
      if(previous){if(previous.nextSibling!==el)app.insertBefore(el,previous.nextSibling)}
      else if(app.firstChild!==el)app.insertBefore(el,app.firstChild);
      previous=el;
    });
    // 移除快照中已不存在的仓库卡片。
    cardEls.forEach(function(el,repo){if(!seen.has(repo)){el.remove();cardEls.delete(repo)}});
    restoreViewportAnchor(viewportAnchor);
    vscode.postMessage({type:'rendered',cardCount:cards.length});
  }

  window.addEventListener('message',function(event){
    const message=event.data;
    if(!message)return;
    if(message.type==='snapshot'){displayMode=message.displayMode;render(message.cards||[])}
    else if(message.type==='setMessage'){
      const el=cardEls.get(message.repositoryPath);
      if(el){el._refs.messageInput.value=message.message||'';resizeMessageInput(el._refs.messageInput);el._refs.hint.textContent='';el._refs.messageInput.focus()}
    }else if(message.type==='focus'){
      const el=cardEls.get(message.repositoryPath);
      if(el){selectCard(message.repositoryPath);el.scrollIntoView({behavior:'auto',block:'start'});el._refs.messageInput.focus()}
    }
  });

  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
    }
}
