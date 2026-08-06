import * as vscode from 'vscode';
import { ChangeSetMode, CommitFile, GitBranchOption, GitCommit, GitRepositoryOption, getCommitFiles, getWorkingTreeChanges, buildGraph, getCurrentGitBranch, getGitBranches, getGitCommits, getGitRepositories, runGitSync } from './gitLogProvider';
import { CustomDiffPanel } from './customDiffPanel';

// Webview 视图提供器: 渲染 gitk 风格的提交图 (div flex 布局, 避免 table 高度塌陷)
export class GitkViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vscode-gitk.panelView';
    private view?: vscode.WebviewView;
    private commits: GitCommit[] = [];
    private isLoading = true;
    private isFocused = false;
    private refreshInFlight?: Promise<void>;
    private refreshGeneration = 0;
    private readonly onDidChangeDiffAvailabilityEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDiffAvailability = this.onDidChangeDiffAvailabilityEmitter.event;
    private files: CommitFile[] = [];
    private currentHash?: string;
    private currentChangeSet: ChangeSetMode = 'commit';
    private stagedFiles: CommitFile[] = [];
    private changeFiles: CommitFile[] = [];
    private displayMode: 'tree' | 'flat' = 'tree';
    private selectedPath?: string;
    private repositories: GitRepositoryOption[] = [];
    private branches: GitBranchOption[] = [];
    private selectedRepository?: string;
    private selectedBranch?: string;
    private readonly customDiffPanel: CustomDiffPanel;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.customDiffPanel = new CustomDiffPanel(context, path => this.syncFileHighlightFromPath(path));
        context.subscriptions.push(this.onDidChangeDiffAvailabilityEmitter, this.customDiffPanel);
    }

    canShowMultiDiff(): boolean {
        return !this.isLoading && this.view?.visible === true && !!this.currentHash;
    }

    isGitkLoading(): boolean {
        return this.isLoading;
    }

    async selectCommit(hash: string): Promise<void> {
        this.currentChangeSet = 'commit';
        this.view?.webview.postMessage({ type: 'selectedCommit', hash });
        await this.setCommitFiles(hash);
    }

    private async selectWorkingTreeChanges(mode: Extract<ChangeSetMode, 'staged' | 'changes'>): Promise<void> {
        this.currentChangeSet = mode;
        this.currentHash = mode;
        this.selectedPath = undefined;
        this.files = mode === 'staged' ? this.stagedFiles : this.changeFiles;
        this.view?.webview.postMessage({ type: 'selectedCommit', hash: mode });
        this.renderFiles();
        if (this.files.length > 0 && this.canShowMultiDiff()) {
            await this.openDiff();
        }
    }

    private setLoading(value: boolean): void {
        if (this.isLoading !== value) {
            this.isLoading = value;
            this.onDidChangeDiffAvailabilityEmitter.fire();
        }
    }

    private setFocused(value: boolean): void {
        if (this.isFocused === value) { return; }
        this.isFocused = value;
        this.onDidChangeDiffAvailabilityEmitter.fire();
    }

    private updateMultiDiffVisibility(): void {
        if (!this.view?.visible) {
            this.customDiffPanel.hide();
        } else if (!this.isLoading && this.currentHash && this.files.length > 0) {
            void this.openDiff(this.selectedPath);
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };
        view.webview.html = this.getHtml();
        view.webview.onDidReceiveMessage(msg => this.onMessage(msg));
        view.onDidChangeVisibility(() => this.updateMultiDiffVisibility());
        // 延迟刷新, 等 Git 扩展扫描完仓库
        this.refreshWithRetry();
    }

    // 刷新: 带重试, 解决 Git 扩展异步扫描延迟问题
    private retryCount = 0;
    private readonly maxRetry = 5;
    async refreshWithRetry(): Promise<void> {
        const generation = ++this.refreshGeneration;
        await this.refresh();
        if (generation === this.refreshGeneration && this.commits.length === 0 && this.retryCount < this.maxRetry) {
            this.retryCount++;
            setTimeout(() => {
                if (generation === this.refreshGeneration) {
                    this.refreshWithRetry();
                }
            }, 1500);
        }
    }

    // 刷新: 重新读取 git log 并更新 webview
    async refresh(): Promise<void> {
        if (this.refreshInFlight) { return this.refreshInFlight; }
        this.refreshInFlight = this.refreshInternal();
        try {
            await this.refreshInFlight;
        } finally {
            this.refreshInFlight = undefined;
        }
    }

    private async refreshInternal(): Promise<void> {
        if (!this.view) { return; }
        this.setLoading(true);
        await this.refreshSelectors();
        const rootUri = this.getRepoRootUri();
        if (!rootUri) {
            this.view.webview.postMessage({ type: 'error', message: '未找到 Git 仓库' });
            return;
        }
        if (this.commits.length > 0) {
            this.view.webview.postMessage({ type: 'commits', commits: this.commits });
        }
        try {
            const [raw, workingTreeChanges] = await Promise.all([
                getGitCommits(rootUri, 500, this.selectedBranch),
                getWorkingTreeChanges(rootUri),
            ]);
            if (raw.length === 0) {
                throw new Error('Git 仓库扫描中...');
            }
            this.commits = buildGraph(raw);
            this.stagedFiles = workingTreeChanges.staged;
            this.changeFiles = workingTreeChanges.changes;
            this.retryCount = 0;
            const selectedWorkingTreeMode = this.currentChangeSet !== 'commit'
                && (this.currentChangeSet === 'staged' ? this.stagedFiles : this.changeFiles).length > 0
                ? this.currentChangeSet
                : undefined;
            const selectedCommit = this.commits.some(commit => commit.hash === this.currentHash)
                ? this.currentHash
                : this.commits[0]?.hash;
            this.view.webview.postMessage({
                type: 'commits',
                commits: this.commits,
                stagedCount: this.stagedFiles.length,
                changesCount: this.changeFiles.length,
            });
            this.setLoading(false);
            if (selectedWorkingTreeMode) {
                await this.selectWorkingTreeChanges(selectedWorkingTreeMode);
            } else if (selectedCommit) {
                await this.selectCommit(selectedCommit);
            }
        } catch (e: any) {
            this.view.webview.postMessage({ type: 'loading', message: '加载中, 请稍候...' });
        }
    }

    private async refreshSelectors(): Promise<void> {
        this.repositories = await getGitRepositories();
        if (!this.selectedRepository || !this.repositories.some(repo => repo.path === this.selectedRepository)) {
            this.selectedRepository = this.repositories[0]?.path;
        }
        const rootUri = this.getRepoRootUri();
        const [branches, currentBranch] = rootUri
            ? await Promise.all([getGitBranches(rootUri), getCurrentGitBranch(rootUri)])
            : [[], undefined];
        this.branches = branches;
        if (!this.selectedBranch || !this.branches.some(branch => branch.name === this.selectedBranch)) {
            this.selectedBranch = currentBranch && this.branches.some(branch => branch.name === currentBranch)
                ? currentBranch
                : undefined;
        }
        this.view?.webview.postMessage({
            type: 'selectors',
            repositories: this.repositories,
            branches: this.branches,
            selectedRepository: this.selectedRepository,
            selectedBranch: this.selectedBranch,
        });
    }

    private getRepoRootUri(): vscode.Uri | undefined {
        if (this.selectedRepository) { return vscode.Uri.parse(this.selectedRepository); }
        const folders = vscode.workspace.workspaceFolders;
        return folders?.[0]?.uri;
    }

    private onMessage(msg: any): void {
        switch (msg.type) {
            case 'focus':
                this.setFocused(true);
                break;
            case 'blur':
                this.setFocused(false);
                break;
            case 'refresh':
                this.retryCount = 0;
                this.refreshGeneration++;
                this.refreshWithRetry();
                break;
            case 'selectRepository':
                if (typeof msg.path === 'string' && this.repositories.some(repo => repo.path === msg.path)) {
                    this.selectedRepository = msg.path;
                    this.selectedBranch = undefined;
                    this.commits = [];
                    this.files = [];
                    this.currentHash = undefined;
                    this.customDiffPanel.hide();
                    this.retryCount = 0;
                    this.refreshGeneration++;
                    void this.refreshWithRetry();
                }
                break;
            case 'selectBranch':
                this.selectedBranch = typeof msg.name === 'string' && msg.name ? msg.name : undefined;
                this.commits = [];
                this.files = [];
                this.currentHash = undefined;
                this.customDiffPanel.hide();
                this.retryCount = 0;
                this.refreshGeneration++;
                void this.refreshWithRetry();
                break;
            case 'gitSync':
                if (msg.action === 'fetch' || msg.action === 'pull' || msg.action === 'push') {
                    this.syncRepository(msg.action);
                }
                break;
            case 'selectCommit':
                if (msg.hash === 'staged' || msg.hash === 'changes') {
                    this.selectWorkingTreeChanges(msg.hash);
                } else if (typeof msg.hash === 'string') {
                    this.selectCommit(msg.hash);
                }
                break;
            case 'selectFile':
                this.openDiff(msg.path);
                break;
            case 'toggleFilesMode':
                this.displayMode = this.displayMode === 'tree' ? 'flat' : 'tree';
                this.renderFiles();
                break;
        }
    }

    private async syncRepository(action: 'fetch' | 'pull' | 'push'): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        try {
            await runGitSync(rootUri, action);
            vscode.window.showInformationMessage(`Git ${action} 完成`);
            this.retryCount = 0;
            this.refreshGeneration++;
            await this.refreshWithRetry();
        } catch (error) {
            vscode.window.showErrorMessage(`Git ${action} 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async setCommitFiles(hash: string): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
            this.currentHash = hash;
            this.currentChangeSet = 'commit';
            this.selectedPath = undefined;
        this.files = [];
        this.view?.webview.postMessage({ type: 'filesLoading' });
        try {
            const files = await getCommitFiles(rootUri, hash);
            if (this.currentHash !== hash) { return; }
            this.files = files;
            this.renderFiles();
            if (files.length > 0 && this.canShowMultiDiff()) {
                await this.openDiff();
            }
        } catch (error) {
            if (this.currentHash === hash) {
                this.view?.webview.postMessage({ type: 'filesError', message: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    private renderFiles(): void {
        this.view?.webview.postMessage({ type: 'files', files: this.files, mode: this.displayMode, selectedPath: this.selectedPath });
    }

    private async openDiff(filePath?: string): Promise<void> {
        if (this.isLoading || !this.currentHash) {
            this.customDiffPanel.hide();
            return;
        }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        if (filePath) { this.selectedPath = filePath; this.renderFiles(); }
        await this.customDiffPanel.show(rootUri, this.currentHash, this.files, filePath, this.currentChangeSet);
    }

    private syncFileHighlightFromPath(filePath: string): void {
        if (this.files.some(file => file.path === filePath)) {
            this.selectedPath = filePath;
            this.renderFiles();
        }
    }

    // 生成 webview HTML (div flex 布局, 替代 table)
    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gitk</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: var(--vscode-editor-font-family, sans-serif); font-size: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); display: flex; flex-direction: column; height: 100%; }
  #header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; min-width: 0; }
  #header button { border: none; cursor: pointer; border-radius: 2px; }
  .dropdown { position: relative; flex: 0 1 auto; min-width: 0; }
  #repositoryDropdown { width: min(42vw, 220px); }
  #branchDropdown { width: min(36vw, 180px); }
  .dropdown-current { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
  .dropdown-current:hover:not(:disabled), .dropdown.open .dropdown-current { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .dropdown-current:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-current:disabled { cursor: default; opacity: .6; }
  .dropdown-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-chevron { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .dropdown.open .dropdown-chevron { transform: rotate(180deg); }
  .dropdown-menu { position: absolute; top: calc(100% + 3px); left: 0; z-index: 20; display: none; flex-direction: column; width: max(100%, 190px); padding: 5px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  .dropdown.open .dropdown-menu { display: flex; }
  .dropdown-filter { width: 100%; height: 25px; flex: 0 0 auto; margin-bottom: 4px; padding: 0 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; font-size: 11px; }
  .dropdown-filter:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-options { min-height: 0; flex: 1 1 auto; overflow-y: auto; }
  .dropdown-option, .dropdown-group { width: 100%; min-height: 24px; padding: 4px 7px; overflow: hidden; border: 0; border-radius: 3px; font: inherit; font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-option { color: inherit; background: transparent; cursor: pointer; }
  .dropdown-option:hover, .dropdown-option:focus-visible { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); outline: none; }
  .dropdown-option.selected::before { content: '✓'; display: inline-block; width: 14px; color: var(--vscode-menu-selectionForeground, var(--vscode-textLink-foreground)); }
  .dropdown-group { padding-bottom: 1px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; cursor: default; }
  .dropdown-empty { padding: 8px 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #toolbarActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .toolbar-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; }
  .toolbar-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  #header .count { opacity: 0.7; font-size: 11px; white-space: nowrap; }
  #workspace { display: grid; grid-template-columns: minmax(180px, 1fr) 5px minmax(180px, 1fr); flex: 1; min-height: 0; }
  #graph { min-width: 0; min-height: 0; overflow: auto; }
  #panelResizeHandle { cursor: col-resize; background: var(--vscode-panel-border); }
  #panelResizeHandle:hover, #panelResizeHandle.resizing { background: var(--vscode-focusBorder); }
  #filesSection { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  #filesHeader { height: 30px; padding: 0 10px; display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; font-weight: 600; }
  #filesHeader button { color: var(--vscode-textLink-foreground); background: transparent; border: 0; cursor: pointer; font-size: 11px; }
  #filesList { min-height: 0; flex: 1 1 auto; overflow: auto; }
  .file-item, .folder-item { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 10px; }
  .file-item { cursor: pointer; }
  .folder-item { cursor: pointer; font-weight: 600; }
  .file-item:hover, .folder-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .tree-chevron { width: 12px; text-align: center; color: var(--vscode-icon-foreground); }
  .tree-folder-icon { width: 12px; color: var(--vscode-icon-foreground); }
  .file-status { width: 12px; text-align: center; font-weight: 700; }
  .file-status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .file-status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .file-path { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .file-folder { opacity: 0.55; }
  #filesEmpty { padding: 8px 10px; color: var(--vscode-descriptionForeground); }
  .commit-header, .commit-row { display: grid; grid-template-columns: var(--graph-width) var(--hash-width) var(--message-width) var(--author-width) var(--date-width); align-items: center; min-width: max-content; }
  .commit-header { position: sticky; top: 0; z-index: 1; height: 26px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
  .commit-row { min-height: 26px; height: auto; cursor: pointer; border-bottom: 1px solid transparent; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.expanded { align-items: start; }
  .commit-row.expanded .col-graph { grid-row: span 2; }
  .commit-description { display: none; grid-column: 2 / -1; padding: 0 5px 7px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); line-height: 17px; cursor: text; }
  .commit-row.expanded .commit-description { display: block; }
  .commit-description:empty { display: none; }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground, #094771); }
  .commit-row.working-tree { background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 82%, var(--vscode-textLink-foreground)); }
  .commit-row.working-tree:hover { background: var(--vscode-list-hoverBackground); }
  .working-tree-label { color: var(--vscode-textLink-foreground); font-weight: 600; }
  .working-tree-count { color: var(--vscode-descriptionForeground); }
  .commit-header > div { position: relative; min-width: 0; padding: 5px 14px 5px 0; overflow: hidden; white-space: nowrap; text-align: left; }
  .commit-header .resize-handle { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
  .commit-header .resize-handle:hover { background: var(--vscode-focusBorder); }
  .col-graph, .col-hash, .col-message, .col-author, .col-date { min-width: 0; overflow: hidden; white-space: nowrap; padding: 0 5px; text-align: left; }
  .col-graph { display: flex; align-self: stretch; align-items: flex-start; justify-content: flex-start; padding-left: 0; overflow: visible; }
  .graph-svg { flex: 0 0 auto; }
  .graph-refs { display: flex; align-items: center; align-self: flex-start; min-width: 0; min-height: 26px; gap: 3px; overflow: hidden; white-space: nowrap; }
  .graph-refs:empty::after { content: '—'; color: var(--vscode-descriptionForeground); opacity: .55; }
  .col-message { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; line-height: 16px; }
  .col-hash { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85; color: var(--vscode-descriptionForeground, inherit); }
  .col-message, .col-author, .col-date { text-overflow: ellipsis; }
  .col-message { color: var(--vscode-foreground, inherit); }
  .col-author { opacity: 0.75; }
  .col-date { opacity: 0.65; font-variant-numeric: tabular-nums; }
  .ref-label { display: inline-block; max-width: 16ch; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border: 1px solid color-mix(in srgb, var(--vscode-badge-background) 74%, var(--vscode-foreground)); border-radius: 3px; padding: 1px 5px; font-size: 10px; line-height: 16px; }
  .ref-head { color: var(--vscode-editor-background); background: var(--vscode-testing-iconPassed, #89d185); border-color: var(--vscode-testing-iconPassed, #89d185); }
  .ref-branch { color: var(--vscode-editor-background); background: var(--vscode-textLink-foreground, #3794ff); border-color: var(--vscode-textLink-foreground, #3794ff); }
  .ref-tag { color: var(--vscode-editor-background); background: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); border-color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
  .ref-remote { color: var(--vscode-editor-background); background: var(--vscode-charts-purple, #b180d7); border-color: var(--vscode-charts-purple, #b180d7); }
  svg { display: block; }
  .dot { stroke: var(--vscode-editor-background); stroke-width: 1; }
  #loading { padding: 20px; text-align: center; opacity: 0.6; }
</style>
</head>
<body>
  <div id="header">
    <div class="dropdown" id="repositoryDropdown">
      <button class="dropdown-current" type="button" title="切换仓库或子仓库" aria-expanded="false" disabled><span class="dropdown-label">加载仓库...</span><span class="dropdown-chevron">⌄</span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选仓库" aria-label="筛选仓库"><div class="dropdown-options"></div></div>
    </div>
    <div class="dropdown" id="branchDropdown">
      <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label">加载分支...</span><span class="dropdown-chevron">⌄</span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选分支" aria-label="筛选分支"><div class="dropdown-options"></div></div>
    </div>
    <span class="count" id="countLabel"></span>
    <div id="toolbarActions">
      <button class="toolbar-icon" id="fetchBtn" title="获取" aria-label="获取"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 0 1 9-3M12 2v3H9M8 5v7M5.5 9.5 8 12l2.5-2.5"/></svg></button>
      <button class="toolbar-icon" id="pullBtn" title="拉取" aria-label="拉取"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v8m0 0-2-2m2 2 2-2M12 13V5m0 0-2 2m2-2 2 2M4 5h5a3 3 0 0 1 3 3"/></svg></button>
      <button class="toolbar-icon" id="pushBtn" title="推送" aria-label="推送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 13V5m0 0-2 2m2-2 2 2M12 3v8m0 0-2-2m2 2 2-2M12 11H7a3 3 0 0 1-3-3"/></svg></button>
      <button class="toolbar-icon" id="refreshBtn" title="刷新提交" aria-label="刷新提交"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6A5 5 0 1 0 13 10M13 2v4H9"/></svg></button>
    </div>
  </div>
  <main id="workspace">
    <div id="graph">
      <div id="loading">加载中...</div>
      <div id="commitList" style="display:none;"></div>
    </div>
    <div id="panelResizeHandle" role="separator" aria-label="调整提交图与变更文件宽度" aria-orientation="vertical"></div>
    <section id="filesSection">
      <div id="filesHeader"><span>Changed Files</span><button id="filesModeBtn" title="切换树状/平铺显示">树状</button></div>
      <div id="filesList"><div id="filesEmpty">选择一个提交以查看变更文件</div></div>
    </section>
  </main>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  let commits = [];
  let stagedCount = 0;
  let changesCount = 0;
  let files = [];
  let filesMode = 'tree';
  let selectedPath = '';
  const collapsedFolders = new Set();
  const columnWidths = {};
  let resizing = null;
  let panelResizing = null;

    const ROW_H = 26;
    const LANE_W = 20;
    const expandedCommits = new Set();
  const DOT_R = 5;
  let graphViewportWidth = 0;

  window.addEventListener('focus', function() { vscode.postMessage({ type: 'focus' }); });
  window.addEventListener('blur', function() { vscode.postMessage({ type: 'blur' }); });
  document.addEventListener('visibilitychange', function() { vscode.postMessage({ type: document.visibilityState === 'visible' ? 'focus' : 'blur' }); });

  let resizeFrame = 0;
  window.addEventListener('resize', function() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(function() {
      resizeFrame = 0;
      updateOpenDropdownHeights();
      const graph = document.getElementById('graph');
      if (commits.length > 0 && graph && graph.clientWidth !== graphViewportWidth) {
        render();
      }
    });
  });

  function setRepositoryLoading() {
    closeDropdowns();
    repositoryDropdown.current.disabled = true;
    repositoryDropdown.label.textContent = '加载仓库...';
    repositoryDropdown.options.innerHTML = '';
    branchDropdown.current.disabled = true;
    branchDropdown.label.textContent = '加载分支...';
    branchDropdown.options.innerHTML = '';
  }
  document.getElementById('refreshBtn').addEventListener('click', function() {
    setRepositoryLoading();
    document.getElementById('loading').style.display = 'block';
    document.getElementById('loading').textContent = '刷新中...';
    document.getElementById('commitList').style.display = 'none';
    vscode.postMessage({ type: 'refresh' });
  });
  ['fetch', 'pull', 'push'].forEach(function(action) {
    document.getElementById(action + 'Btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'gitSync', action: action });
    });
  });
  document.getElementById('filesModeBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'toggleFilesMode' });
  });
  function createDropdown(id, onSelect) {
    const root = document.getElementById(id);
    const current = root.querySelector('.dropdown-current');
    const label = root.querySelector('.dropdown-label');
    const filter = root.querySelector('.dropdown-filter');
    const options = root.querySelector('.dropdown-options');
    const menu = root.querySelector('.dropdown-menu');
    const dropdown = { root: root, current: current, label: label, menu: menu, filter: filter, options: options, onSelect: onSelect };
    current.addEventListener('click', function() {
      if (current.disabled) return;
      const opening = !root.classList.contains('open');
      closeDropdowns();
      if (opening) {
        root.classList.add('open');
        updateDropdownHeight(dropdown);
        current.setAttribute('aria-expanded', 'true');
        filter.value = '';
        filter.dispatchEvent(new Event('input'));
        filter.focus();
      }
    });
    filter.addEventListener('input', function() {
      const query = filter.value.trim().toLocaleLowerCase();
      let visibleOptions = 0;
      options.querySelectorAll('.dropdown-option').forEach(function(option) {
        const visible = !query || option.textContent.toLocaleLowerCase().includes(query);
        option.hidden = !visible;
        if (visible) visibleOptions++;
      });
      let empty = options.querySelector('.dropdown-empty');
      if (!visibleOptions) {
        if (!empty) { empty = document.createElement('div'); empty.className = 'dropdown-empty'; empty.textContent = '未找到结果'; options.appendChild(empty); }
      } else if (empty) {
        empty.remove();
      }
    });
    return dropdown;
  }

  function updateDropdownHeight(dropdown) {
    const panelHeight = Math.max(document.documentElement.clientHeight, document.body.clientHeight);
    dropdown.menu.style.maxHeight = Math.floor(panelHeight / 2) + 'px';
  }

  function updateOpenDropdownHeights() {
    [repositoryDropdown, branchDropdown].forEach(function(dropdown) {
      if (dropdown && dropdown.root.classList.contains('open')) updateDropdownHeight(dropdown);
    });
  }

  function closeDropdown(dropdown) {
    dropdown.root.classList.remove('open');
    dropdown.current.setAttribute('aria-expanded', 'false');
  }

  function closeDropdowns() {
    if (repositoryDropdown) closeDropdown(repositoryDropdown);
    if (branchDropdown) closeDropdown(branchDropdown);
  }

  const repositoryDropdown = createDropdown('repositoryDropdown', function(path) {
    setRepositoryLoading();
    vscode.postMessage({ type: 'selectRepository', path: path });
  });
  const branchDropdown = createDropdown('branchDropdown', function(name) {
    closeDropdown(branchDropdown);
    vscode.postMessage({ type: 'selectBranch', name: name });
  });

  document.addEventListener('click', function(event) {
    if (!event.target.closest('.dropdown')) closeDropdowns();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeDropdowns();
  });
  document.getElementById('panelResizeHandle').addEventListener('mousedown', function(event) {
    const workspace = document.getElementById('workspace');
    if (!workspace) return;
    panelResizing = { startX: event.clientX, leftWidth: document.getElementById('graph').getBoundingClientRect().width, totalWidth: workspace.getBoundingClientRect().width };
    document.getElementById('panelResizeHandle').classList.add('resizing');
    event.preventDefault();
  });

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'selectors') {
      renderSelectors(msg);
    } else if (msg.type === 'commits') {
      commits = msg.commits;
      stagedCount = Number(msg.stagedCount) || 0;
      changesCount = Number(msg.changesCount) || 0;
      render();
    } else if (msg.type === 'filesLoading') {
      document.getElementById('filesList').innerHTML = '<div id="filesEmpty">加载变更文件...</div>';
    } else if (msg.type === 'filesError') {
      document.getElementById('filesList').innerHTML = '<div id="filesEmpty">无法加载变更文件: ' + escapeHtml(msg.message || '') + '</div>';
    } else if (msg.type === 'files') {
      files = msg.files || [];
      filesMode = msg.mode || 'tree';
      selectedPath = msg.selectedPath || '';
      renderFiles();
    } else if (msg.type === 'selectedCommit') {
      selectedPath = '';
    } else if (msg.type === 'loading') {
      document.getElementById('loading').textContent = msg.message || '加载中...';
      document.getElementById('loading').style.display = 'block';
      document.getElementById('commitList').style.display = 'none';
    } else if (msg.type === 'error') {
      document.getElementById('loading').textContent = '错误: ' + msg.message;
      document.getElementById('loading').style.display = 'block';
      document.getElementById('commitList').style.display = 'none';
    }
  });

  function renderDropdownOptions(dropdown, entries, selectedValue) {
    const options = entries.filter(function(entry) { return !entry.group; });
    const selected = options.find(function(entry) { return entry.value === selectedValue; });
    dropdown.current.disabled = options.length === 0;
    dropdown.label.textContent = selected ? selected.label : '未找到选项';
    dropdown.options.innerHTML = '';
    entries.forEach(function(entry) {
      if (entry.group) {
        const group = document.createElement('div');
        group.className = 'dropdown-group';
        group.textContent = entry.group;
        dropdown.options.appendChild(group);
        return;
      }
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'dropdown-option' + (entry.value === selectedValue ? ' selected' : '');
      option.textContent = entry.label;
      option.title = entry.title || entry.label;
      option.addEventListener('click', function() { dropdown.onSelect(entry.value); });
      dropdown.options.appendChild(option);
    });
  }

  function renderSelectors(msg) {
    const repositories = msg.repositories || [];
    renderDropdownOptions(repositoryDropdown, repositories.map(function(repo) {
      return { value: repo.path, label: (repo.description === 'repo' ? '◆ ' : '') + repo.label, title: repo.path };
    }), msg.selectedRepository);
    const branches = msg.branches || [];
    const localBranches = branches.filter(function(branch) { return branch.description !== '远程分支'; });
    const remoteBranches = branches.filter(function(branch) { return branch.description === '远程分支'; });
    const branchEntries = [];
    if (localBranches.length) {
      branchEntries.push({ group: '本地分支' });
      localBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    if (remoteBranches.length) {
      branchEntries.push({ group: '远程分支' });
      remoteBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    renderDropdownOptions(branchDropdown, branchEntries, msg.selectedBranch);
  }

  function revealSelectedFile() {
    if (!selectedPath) return;
    const list = document.getElementById('filesList');
    const item = list.querySelector('.file-item.selected');
    if (!item) return;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
    else if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
  }

  function renderFiles() {
    const list = document.getElementById('filesList');
    const modeButton = document.getElementById('filesModeBtn');
    modeButton.textContent = filesMode === 'tree' ? '树状' : '平铺';
    if (!files.length) {
      list.innerHTML = '<div id="filesEmpty">此提交没有变更文件</div>';
      return;
    }
    const ordered = files.slice().sort(function(a, b) { return filesMode === 'tree' ? a.path.localeCompare(b.path) : 0; });
    let html = '';
    if (filesMode === 'tree') {
      const filesByFolder = new Map();
      ordered.forEach(function(file) {
        const lastSlash = file.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash) : '';
        const group = filesByFolder.get(folder) || [];
        group.push(file);
        filesByFolder.set(folder, group);
      });
      filesByFolder.forEach(function(folderFiles, folder) {
        if (folder) {
          const expanded = !collapsedFolders.has(folder);
          html += '<div class="folder-item" data-folder="' + escapeAttr(folder) + '" title="' + escapeAttr(folder) + '">';
          html += '<span class="tree-chevron">' + (expanded ? '⌄' : '›') + '</span><span class="tree-folder-icon">▰</span><span class="file-path">' + escapeHtml(folder) + '</span></div>';
          if (!expanded) return;
        }
        folderFiles.forEach(function(file) {
          const lastSlash = file.path.lastIndexOf('/');
          const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
          html += '<div class="file-item' + (file.path === selectedPath ? ' selected' : '') + '" data-path="' + escapeAttr(file.path) + '" style="padding-left:' + (folder ? 30 : 10) + 'px" title="' + escapeAttr(file.path) + '">';
          html += '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span><span class="file-path">' + escapeHtml(name) + '</span></div>';
        });
      });
    } else {
      for (const file of ordered) {
        const lastSlash = file.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
        const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
        html += '<div class="file-item' + (file.path === selectedPath ? ' selected' : '') + '" data-path="' + escapeAttr(file.path) + '" title="' + escapeAttr(file.path) + '">';
        html += '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>';
        html += '<span class="file-path"><span class="file-folder">' + escapeHtml(folder) + '</span>' + escapeHtml(name) + '</span></div>';
      }
    }
    list.innerHTML = html;
    revealSelectedFile();
    list.querySelectorAll('.folder-item').forEach(function(item) {
      item.addEventListener('click', function() {
        const folder = item.getAttribute('data-folder');
        if (!folder) return;
        if (collapsedFolders.has(folder)) collapsedFolders.delete(folder); else collapsedFolders.add(folder);
        renderFiles();
      });
    });
    list.querySelectorAll('.file-item').forEach(function(item) {
      item.addEventListener('click', function() {
        const path = item.getAttribute('data-path');
        if (path) vscode.postMessage({ type: 'selectFile', path: path });
      });
    });
  }

  function refClass(ref) {
    if (ref === 'HEAD') return 'ref-head';
    if (ref.includes('/')) return 'ref-remote';
    if (ref.startsWith('tag: ')) return 'ref-tag';
    return 'ref-branch';
  }

  function render() {
    const list = document.getElementById('commitList');
    const loading = document.getElementById('loading');
    if (commits.length === 0) {
      loading.textContent = '无提交记录';
      loading.style.display = 'block';
      list.style.display = 'none';
      return;
    }
    loading.style.display = 'none';
    list.style.display = 'block';

    let maxLane = 0;
    for (const c of commits) {
      if (c.lane > maxLane) maxLane = c.lane;
      if (c.lanes) for (const l of c.lanes) {
        if (l.fromLane > maxLane) maxLane = l.fromLane;
        if (l.toLane > maxLane) maxLane = l.toLane;
      }
    }
    const naturalGraphW = (maxLane + 1) * LANE_W + 10;
    const graph = document.getElementById('graph');
    graphViewportWidth = graph ? graph.clientWidth : 0;
    const graphW = naturalGraphW;

    const refsW = columnWidth(commits.map(function(c) { return (c.refs || []).join(' '); }), 1) + 6 + 'ch';
    const graphColumnW = 'calc(' + graphW + 'px + ' + refsW + ')';
    let html = '<div class="commit-header">';
    html += headerCell('分支图 / 引用', 'graph');
    html += headerCell('Commit ID', 'hash');
    html += headerCell('描述', 'message');
    html += headerCell('作者', 'author');
    html += headerCell('时间', 'date');
    html += '</div>';
    function workingTreeRow(hash, label, count) {
      return '<div class="commit-row working-tree" data-hash="' + hash + '">' +
        '<div class="col-graph"></div><div class="col-hash">—</div>' +
        '<div class="col-message working-tree-label">' + label + '</div>' +
        '<div class="col-author working-tree-count">' + count + ' 个文件</div><div class="col-date"></div></div>';
    }
    if (changesCount > 0) html += workingTreeRow('changes', 'Changes', changesCount);
    if (stagedCount > 0) html += workingTreeRow('staged', 'Staged Changes', stagedCount);
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const expanded = c.body && c.body.trim() && expandedCommits.has(c.hash);
      html += '<div class="commit-row' + (expanded ? ' expanded' : '') + '" data-hash="' + escapeAttr(c.hash) + '" data-row="' + i + '" data-has-description="' + (c.body && c.body.trim() ? 'true' : 'false') + '">';
      let refHtml = '';
      if (c.refs && c.refs.length) {
        for (const r of c.refs) {
          refHtml += '<span class="ref-label ' + refClass(r) + '" title="' + escapeAttr(r) + '">' + escapeHtml(r) + '</span>';
        }
      }
      html += '<div class="col-graph"><svg class="graph-svg" width="' + graphW + '" height="' + ROW_H + '" viewBox="0 0 ' + naturalGraphW + ' ' + ROW_H + '" preserveAspectRatio="none"></svg><div class="graph-refs">' + refHtml + '</div></div>';
      html += '<div class="col-hash">' + escapeHtml(c.shortHash) + '</div>';
      html += '<div class="col-message" title="' + escapeAttr(c.message) + '">' + escapeHtml(c.message) + '</div>';
      const authorPreview = c.authorEmail ? c.author + ' <' + c.authorEmail + '>' : c.author;
      html += '<div class="col-author" title="' + escapeAttr(authorPreview) + '">' + escapeHtml(authorPreview) + '</div>';
      html += '<div class="col-date" title="' + escapeAttr(c.authorDateLabel) + '">' + escapeHtml(c.authorDateLabel) + '</div>';
      html += '<div class="commit-description">' + escapeHtml(c.body || '') + '</div>';
      html += '</div>';
    }
    setColumnWidth(list, 'graph', graphColumnW, true);
    setColumnWidth(list, 'hash', columnWidth(commits.map(c => c.shortHash), 1) + 6 + 'ch', true);
    setColumnWidth(list, 'message', columnWidth(commits.map(c => c.message), 1) + 6 + 'ch', true);
    setColumnWidth(list, 'author', columnWidth(commits.map(c => c.authorEmail ? c.author + ' <' + c.authorEmail + '>' : c.author), 1) + 6 + 'ch', true);
    setColumnWidth(list, 'date', columnWidth(commits.map(c => c.authorDateLabel), 1) + 6 + 'ch', true);
    list.innerHTML = html;

    const rows = list.querySelectorAll('.commit-row');
    rows.forEach(function(row) {
      const svg = row.querySelector('svg');
      if (svg) {
        svg.setAttribute('height', String(ROW_H));
        svg.setAttribute('viewBox', '0 0 ' + naturalGraphW + ' ' + ROW_H);
        drawSvg(svg, Number(row.getAttribute('data-row')), graphW, ROW_H, LANE_W, DOT_R);
      }
      row.addEventListener('click', function() {
        const hash = row.getAttribute('data-hash');
        if (hash && row.dataset.hasDescription === 'true') {
          const willExpand = !expandedCommits.has(hash);
          expandedCommits.clear();
          if (willExpand) expandedCommits.add(hash);
          if (hash) vscode.postMessage({ type: 'selectCommit', hash: hash });
          render();
          return;
        }
        rows.forEach(function(r) { r.classList.remove('selected'); });
        row.classList.add('selected');
        if (hash) vscode.postMessage({ type: 'selectCommit', hash: hash });
      });
    });

    document.getElementById('countLabel').textContent = commits.length + ' 条提交';
  }

  function drawSvg(svg, idx, graphW, rowH, laneW, dotR) {
    const c = commits[idx];
    const expanded = expandedCommits.has(c.hash);
    const svgH = expanded ? svg.closest('.commit-row').getBoundingClientRect().height : rowH;
    const y = rowH / 2;
    const detailsBottom = Math.max(rowH, svgH - 1);
    svg.setAttribute('height', String(svgH));
    svg.setAttribute('viewBox', '0 0 ' + graphW + ' ' + svgH);
    let content = '';

    if (c.lanes) {
      for (const l of c.lanes) {
        if (l.isCommit) { continue; }
        const x1 = l.fromLane * laneW + laneW / 2 + 5;
        const x2 = l.toLane * laneW + laneW / 2 + 5;
        if (x1 === x2) {
          content += '<line x1="' + x1 + '" y1="0" x2="' + x2 + '" y2="' + detailsBottom + '" stroke="' + l.color + '" stroke-width="1.5"/>';
        } else {
          content += '<path d="M' + x1 + ',' + detailsBottom + ' C' + x1 + ',' + (detailsBottom * 0.5) + ' ' + x2 + ',' + (detailsBottom * 0.5) + ' ' + x2 + ',0" fill="none" stroke="' + l.color + '" stroke-width="1.5"/>';
        }
      }
    }

    if (c.lane !== undefined) {
      const cx = c.lane * laneW + laneW / 2 + 5;
      const commitColor = c.lanes && c.lanes.length > 0 ? c.lanes[0].color : '#888';
      const isHead = c.refs && c.refs.some(function(r) { return r === 'HEAD'; });
      const r = isHead ? dotR + 2 : dotR;
      content += '<circle class="dot" cx="' + cx + '" cy="' + y + '" r="' + r + '" fill="' + commitColor + '"/>';
      if (isHead) {
        content += '<circle class="dot" cx="' + cx + '" cy="' + y + '" r="' + (r + 3) + '" fill="none" stroke="' + commitColor + '" stroke-width="1.5"/>';
      }
    }

    svg.innerHTML = content;
  }

  function headerCell(label, key) {
    return '<div data-column="' + key + '">' + label + '<span class="resize-handle" data-column="' + key + '"></span></div>';
  }

  function setColumnWidth(list, key, width, force) {
    if (force || columnWidths[key] === undefined) {
      columnWidths[key] = width;
    }
    list.style.setProperty('--' + key + '-width', columnWidths[key]);
  }

  function applyColumnWidths() {
    const list = document.getElementById('commitList');
    if (!list) return;
    for (const key in columnWidths) {
      list.style.setProperty('--' + key + '-width', columnWidths[key]);
    }
  }

  document.addEventListener('mousedown', function(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('resize-handle')) return;
    const key = target.getAttribute('data-column');
    if (!key) return;
    const header = target.parentElement;
    if (!header) return;
    resizing = { key: key, startX: event.clientX, startWidth: header.getBoundingClientRect().width };
    event.preventDefault();
  });

  document.addEventListener('mousemove', function(event) {
    if (resizing) {
      const minimumWidth = resizing.key === 'date' ? 19 * 8 : 40;
      const width = Math.max(minimumWidth, resizing.startWidth + event.clientX - resizing.startX);
      columnWidths[resizing.key] = width + 'px';
      applyColumnWidths();
      if (resizing.key === 'date') {
        const graph = document.getElementById('graph');
        if (graph) graph.scrollLeft = graph.scrollWidth;
      }
    }
    if (panelResizing) {
      const workspace = document.getElementById('workspace');
      if (!workspace) return;
      const availableWidth = panelResizing.totalWidth - 5;
      const leftWidth = Math.max(180, Math.min(availableWidth - 180, panelResizing.leftWidth + event.clientX - panelResizing.startX));
      workspace.style.gridTemplateColumns = leftWidth + 'px 5px minmax(180px, 1fr)';
    }
  });

  document.addEventListener('mouseup', function() {
    resizing = null;
    if (panelResizing) {
      panelResizing = null;
      document.getElementById('panelResizeHandle').classList.remove('resizing');
    }
  });

  function truncateMessage(s, maxLength) {
    const value = s == null ? '' : String(s);
    if (value.length <= maxLength) return value;
    return value.slice(0, Math.max(0, maxLength - 3)) + '...';
  }

  function sixCharacterGap() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
    probe.textContent = '000000';
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }

  function columnWidth(values, minimum, maximum) {
    let width = minimum;
    for (const value of values) {
      width = Math.max(width, String(value == null ? '' : value).length);
    }
    return maximum === undefined ? width : Math.min(width, maximum);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
</script>
</body>
</html>`;
    }
}
