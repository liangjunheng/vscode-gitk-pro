import * as path from 'path';
import * as vscode from 'vscode';
import { type ChangeSetMode, type ChangedFile, type GitBranchOption, CommitFile, CommitMetadata, DiffPayload, type GitkIntent, type GitRepositoryOption, type GitlinkCommit, WorkingTreeChanges, isWorkingTreeHash } from '../types';
import { getCommitFiles, getGitAheadCount, getGitlinkPathsInCommit, getPushBranches, type PushBranchOption, runGitCommand, runGitReadCommand, readCurrentCommitMessage } from '../git/gitLogProvider';
import { MultiDiffPanel } from './multiDiffPanel';
import { CommitPanel, type CommitPanelSnapshot, type CommitCard, type CommitCardStatePatch } from './commitPanel';
import { CommitPanelViewTitleController } from './commitPanelViewTitleController';
import { renderGitkWebviewHtml } from './gitkWebviewDocument';
import { commitWithMessage } from '../git/gitCommitService';
import { DiffReader } from '../git/diffReader';
import { GitCommitEditMsgEditor } from './gitCommitEditMsgEditor';
import { GitActionRunner } from '../services/gitActions';
import { RepoSubmoduleWatcher } from '../git/gitRepoSubmoduleWatcher';
import { GitRepoController } from '../git/gitRepoController';
import { RepoHeadBranchWatcher } from '../git/eachRepoHeadBranchWatcher';
import { UncommittedFilesWatcher } from '../git/uncommittedFilesWatcher';
import { SelectedRepoTotalBranchWatcher } from '../git/selectedRepoTotalBranchWatcher';
import { GitBranchesController } from '../git/gitBranchesController';
import { GitCommitController } from '../git/gitCommitController';
import { store, type StoreEffect } from '../state/store';


// 归一化行尾, 消除 core.autocrlf 造成的 CRLF/LF 差异后再比较文本内容。
function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

// Webview 视图提供器: 渲染 gitk 风格的提交图 (div flex 布局, 避免 table 高度塌陷)
export class GitkViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vscode-gitk.panelView';
    private view?: vscode.WebviewView;
    // 异步控制 / 内部状态 (不存入 Store)
    private refreshAbortController?: AbortController;
    private commitFilesAbortController?: AbortController;
    private commitPanelDiffAbortController?: AbortController;
    private commitFilesGeneration = 0;
    // 等待 Diff 渲染完成后再显示 Changed Files 列表的代次标记。
    private pendingFilesRevealGeneration?: number;
    private refreshGeneration = 0;
    private viewGeneration = 0;
    private initializingViewGeneration = 0;
    private viewDisposables: vscode.Disposable[] = [];
    private readonly onDidChangeDiffAvailabilityEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDiffAvailability = this.onDidChangeDiffAvailabilityEmitter.event;
    private readonly onDidChangeWorkingTreeSummaryEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeWorkingTreeSummary = this.onDidChangeWorkingTreeSummaryEmitter.event;
    private readonly onDidChangeRepositoryStateEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeRepositoryState = this.onDidChangeRepositoryStateEmitter.event;
    get hasRepositories(): boolean { return this.repositories.length > 0; }
    private lastLoadingProgress?: { phase: string; message: string; current: number; total: number };
    private storeUnsubscribe?: () => void;
    private pushStatePending = false;
    private gitWatchDisposables: vscode.Disposable[] = [];
    private readonly multiDiffPanel: MultiDiffPanel;
    private requestedDiffReveal?: { readonly hash: string; readonly repositoryPath?: string };
    private restoreDiffPanelOnViewVisible = false;
    private openDiffOnInitialVisible = false;
    private readonly commitPanel: CommitPanel;
    private readonly commitPanelViewTitleController: CommitPanelViewTitleController;
    // 每仓库独立的 amend / committing 状态 (多卡片各自提交)。
    private readonly commitAmendByRepo = new Map<string, boolean>();
    private readonly commitMessageBeforeAmendByRepo = new Map<string, string>();
    private readonly amendCommittedFilesByHead = new Map<string, readonly CommitFile[]>();
    private readonly amendCommittedFilesLoading = new Set<string>();
    private readonly unpushedCommitCountByRepository = new Map<string, number>();
    private readonly unpushedStateLoadedByHead = new Set<string>();
    private readonly unpushedStateLoadingByHead = new Set<string>();
    private readonly commitGitlinkPathsByHead = new Map<string, readonly string[]>();
    private readonly commitCommittingByRepo = new Set<string>();
    private readonly commitMessageByRepo = new Map<string, string>();
    private readonly initializedCommitMessagesByRepo = new Set<string>();
    private readonly selectedCommitSubmodulesByRepo = new Map<string, readonly string[]>();
    private readonly selectedPushSubmodulesByRepo = new Map<string, readonly string[]>();
    private readonly pullBeforePushByRepo = new Map<string, boolean>();
    private readonly pushBranchByRepository = new Map<string, Awaited<ReturnType<typeof getPushBranches>>[number]>();
    private readonly lastPushedBranchByRepository = new Map<string, Awaited<ReturnType<typeof getPushBranches>>[number]>();
    private readonly diffReader: DiffReader;
    private readonly workingTreeDiffCache = new Map<string, readonly DiffPayload[]>();
    private readonly gitActions: GitActionRunner;
    // 仓库 / 分支 / 提交状态的唯一写入者，Provider 只读不写。
    private readonly repoSubmoduleWatcher = new RepoSubmoduleWatcher();
    private readonly repoController = new GitRepoController(this.repoSubmoduleWatcher);
    private readonly repoHeadBranchWatcher = new RepoHeadBranchWatcher(this.repoController);
    private readonly selectedRepoTotalBranchWatcher = new SelectedRepoTotalBranchWatcher(
        this.repoController,
        this.repoHeadBranchWatcher,
    );
    private readonly branchesController: GitBranchesController;
    private readonly uncommittedFilesWatcher: UncommittedFilesWatcher;
    private readonly commitController: GitCommitController;
    private readonly selectedRepoSubscription: vscode.Disposable;
    private readonly reposLoadingSubscription: vscode.Disposable;
    private readonly selectedBranchesSubscription: vscode.Disposable;
    // selectedBranches getter 每仓库只能表示一个分支；完整多选以事件快照为准。
    private selectedBranchesMap = new Map<GitRepositoryOption, GitBranchOption[]>();
    // 弹窗总列表快照只由对应 controller 的 total-list 回调写入，视图重建时仅重放。
    private totalRepoListSnapshot: readonly GitRepositoryOption[] = [];
    private totalBranchesListSnapshot: readonly GitBranchOption[] = [];
    private selectedRepoDisplaySnapshot?: { label: string; path: string; hasSubmodules: boolean; isSubmodule: boolean };
    /** 仓库是否有未提交文件的轻量存在性结果，由存在性事件维护，用于徽标先于完整清单显示。 */
    private readonly uncommittedPresence = new Map<string, boolean>();
    private selectedBranchDisplaySnapshot: { label: string; title: string; names: string[]; kind?: GitBranchOption['kind'] } = {
        label: '未选择分支',
        title: '未选择分支',
        names: [],
        kind: undefined,
    };
    private hasStartedRepositoryScan = false;
    // 仓库相关 UI loading 快照只由 onReposLoadingChanged 写入。
    private reposLoadingSnapshot = false;
    // 分支相关 UI loading 快照只由 onBranchesLoadingChanged 写入。
    private branchesLoadingSnapshot = false;
    private readonly workingTreeActionQueue: Array<{
        action: 'stage' | 'unstage' | 'discard';
        section: 'staged' | 'unstaged';
        paths: string[];
        untrackedPaths: ReadonlySet<string>;
        discardUntrackedToTrash: boolean;
        rootUri: vscode.Uri;
        gitlinkPaths: ReadonlySet<string>;
        affectedSubmoduleRepositoryPaths: readonly string[];
    }> = [];
    private processingWorkingTreeActions = false;
    private pendingWorkingTreeDiffPaths?: ReadonlySet<string>;
    // 主动 Git 操作期间，由操作事务统一等待当前虚拟提交的界面投影，避免 watcher 重复发起异步刷新。
    private readonly workingTreeUiMutations = new Set<string>();
    private readonly deferredWorkingTreeChanges = new Map<string, {
        changes: { staged: ChangedFile[]; changes: ChangedFile[] };
        affectedPaths?: readonly string[];
    }>();

    // 提交维度只读自控制器，Provider 不得回写、不做任何提交判定。
    private get commits(): readonly CommitMetadata[] { return this.commitController.searchedCommitList; }
    private get isLoading(): boolean { return store.getState().isLoading; }
    private set isLoading(value: boolean) { store.setState({ isLoading: value }); }
    private get loadingMessage(): string | undefined { return store.getState().loadingMessage; }
    private set loadingMessage(value: string | undefined) { store.setState({ loadingMessage: value }); }
    private get files(): ChangedFile[] { return store.getState().files; }
    private set files(value: ChangedFile[]) { store.setState({ files: value }); }
    private get filesLoading(): boolean { return store.getState().filesLoading; }
    private set filesLoading(value: boolean) { store.setState({ filesLoading: value }); }
    private get currentHash(): string | undefined { return store.getState().currentHash; }
    private get currentChangeSet(): ChangeSetMode { return store.getState().currentChangeSet; }
    private set currentChangeSet(value: ChangeSetMode) { store.setState({ currentChangeSet: value }); }
    private get displayMode(): 'tree' | 'flat' { return store.getState().displayMode; }
    private set displayMode(value: 'tree' | 'flat') { store.setState({ displayMode: value }); }
    private get selectedPath(): string | undefined { return store.getState().selectedPath; }
    private set selectedPath(value: string | undefined) { store.setState({ selectedPath: value }); }
    // 仓库与分支维度同样只读自各自的控制器。
    private get repositories(): readonly GitRepositoryOption[] { return this.repoController.totalRepoList; }
    private get branches(): readonly GitBranchOption[] { return this.branchesController.getBranches(); }
    private get selectedRepositoryPaths(): string[] { return this.repoController.selectedRepoList.map(repository => repository.path); }
    private get hasRepositorySelection(): boolean { return this.repoController.selectedRepoList.length > 0; }
    private get selectedBranches(): string[] {
        return [...this.selectedBranchesMap.values()].flat().map(branch => branch.name);
    }
    private get currentRepositoryPath(): string | undefined { return store.getState().currentRepositoryPath; }
    private updateViewVisible(): void {
        store.setState({ isViewVisible: this.view?.visible === true });
    }

    // 数据驱动: Store 变更 → 推送状态快照到 Webview
    private schedulePushState(): void {
        if (this.pushStatePending) { return; }
        this.pushStatePending = true;
        queueMicrotask(() => {
            this.pushStatePending = false;
            this.pushStateToWebview();
        });
    }

    private pushStateToWebview(): void {
        if (!this.view) { return; }
        const s = store.getState();
        const files = s.files;
        this.commitPanelViewTitleController.update(s.commitRepositories);
        // 提交列表 loading 只由 GitCommitController 的加载事件驱动。
        const commitListLoading = this.commitController.isLoading;
        // 与 loadingProgress 共用同一文案来源, 避免搜索时快照里仍是"加载提交历史"。
        const commitListLoadingMessage = commitListLoading ? this.commitLoadingMessage : undefined;
        // 工作区虚拟行合并为一行(Uncommitted Changes), 同时承载 staged 与 unstaged/untracked 两类文件,
        //   空分组置灰(enabled=false)而非隐藏。
        // 与 Commit editor 共用当前 HEAD 的 watcher 缓存，不能读取 Controller 的副本，否则两处会出现状态不同步。
        // 搜索非空时, 虚拟行不是真实 commit 不经 searchCommits 过滤, 按 label 是否命中关键词决定是否产出; 未命中则不出现。
        const currentBranch = this.commitController.selectedBranches.find(branch => branch.kind === 'current');
        const workingTree = currentBranch
            ? this.uncommittedFilesWatcher.getCachedUncommittedFilesByHeadBranch(currentBranch) ?? new WorkingTreeChanges()
            : new WorkingTreeChanges();
        const workingTreeRepositoryPath = currentBranch?.repoOption.path;
        const searchKeywords = this.commitController.displayedSearchKeywords;
        const matchesSearch = (label: string): boolean =>
            searchKeywords.length === 0
            || searchKeywords.some(keyword => label.toLowerCase().includes(keyword.toLowerCase()));
        const uncommittedLabel = 'Uncommitted Changes';
        const workingTreeRows = workingTreeRepositoryPath && matchesSearch(uncommittedLabel)
            ? [{
                hash: 'uncommitted' as const,
                label: uncommittedLabel,
                repositoryPath: workingTreeRepositoryPath,
                enabled: workingTree.changes.length > 0 || workingTree.staged.length > 0,
            }]
            : [];
        const selectedRepositoryPaths = this.selectedRepositoryPaths;
        const commits = this.commitController.searchedCommitList.map(commit => ({
            ...commit,
            key: `${commit.gitBranchOption?.repoOption.path ?? ''}:${commit.hash}`,
        }));
        const selectedCommitMetadata = this.commitController.selectedCommit;
        const selectedCommit = selectedCommitMetadata ? {
            key: `${selectedCommitMetadata.gitBranchOption?.repoOption.path ?? ''}:${selectedCommitMetadata.hash}`,
            hash: selectedCommitMetadata.hash,
            repositoryPath: selectedCommitMetadata.gitBranchOption?.repoOption.path ?? '',
            kind: (isWorkingTreeHash(selectedCommitMetadata.hash) ? selectedCommitMetadata.hash : 'commit') as ChangeSetMode,
        } : null;
        this.view.webview.postMessage({
            type: 'stateUpdate',
            state: {
                commits,
                showCommitLanes: searchKeywords.length === 0,
                workingTreeRows,
                uncommittedRepositoryCount: this.countUncommittedRepositories(s.commitRepositories),
                stagedCount: workingTree.staged.length,
                changesCount: workingTree.changes.length,
                hasMoreCommits: this.commitController.canLoadMoreCommits,
                isLoadingMoreCommits: this.commitController.isLoadingMoreCommits,
                commitPageError: this.commitController.commitPageErrorMessage,
                branches: this.branches,
                selectedRepositoryPaths,
                selectedBranches: this.selectedBranches,
                isMultiRepository: selectedRepositoryPaths.length > 1,
                files,
                stagedFiles: s.stagedFiles,
                unstagedFiles: s.unstagedFiles,
                filesLoading: s.filesLoading,
                commitMessage: workingTreeRepositoryPath ? this.commitMessageByRepo.get(workingTreeRepositoryPath) ?? '' : '',
                commitEditorLoading: s.commitEditorLoading,
                diffLoading: s.diffLoading,
                diffProgress: s.diffProgress,
                filesMode: s.displayMode,
                selectedPath: s.selectedPath,
                selectedCommit,
                isLoading: commitListLoading,
                loadingMode: this.commitLoadingMode,
                loadingMessage: commitListLoadingMessage,
            },
        });
    }

    private get selectedRepositoryPath(): string | undefined {
        return this.selectedRepositoryPaths.length === 1 ? this.selectedRepositoryPaths[0] : undefined;
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        commitEditMsgEditor: GitCommitEditMsgEditor,
    ) {
        this.displayMode = vscode.workspace.getConfiguration('vscode-gitk').get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
        for (const [repositoryPath, branch] of Object.entries(this.context.workspaceState.get<Record<string, PushBranchOption>>('lastPushedBranches', {}))) {
            this.lastPushedBranchByRepository.set(repositoryPath, branch);
        }
        // 订阅顺序是有意设计：仓库显示必须先于分支/提交刷新，避免下游监听器的同步前置逻辑阻塞 UI 更新。
        this.selectedRepoSubscription = this.repoController.onSelectedRepoListChanged(selected => this.onSelectedRepoListChanged(selected));
        this.reposLoadingSubscription = this.repoController.onReposLoadingChanged(loading => {
            this.reposLoadingSnapshot = loading;
            this.view?.webview.postMessage({ type: 'repoLoadingChanged', loading });
            if (!loading) { void this.refreshPendingGitlinkDiff(); }
        });
        this.branchesController = new GitBranchesController(
            this.repoController,
            this.selectedRepoTotalBranchWatcher,
        );
        this.uncommittedFilesWatcher = new UncommittedFilesWatcher(this.repoHeadBranchWatcher);
        // 分支显示必须先订阅；提交 Controller 的监听器会在回调中启动刷新。
        this.selectedBranchesSubscription = this.branchesController.onSelectedBranchesChanged(branches => this.onSelectedBranchesChanged(branches));
        this.commitController = new GitCommitController(
            this.repoController,
            this.branchesController,
            this.uncommittedFilesWatcher,
        );
        // Diff 面板顶部卡片变化时回写 selectedPath，驱动 Changed Files 高亮。
        this.multiDiffPanel = new MultiDiffPanel(
            (path, generation) => this.syncFileHighlightFromDiffPanel(path, generation),
            identity => this.handleDiffRendered(identity),
            (path, line, column, side) => void this.openWorkspaceFileAtLine(path, line, column, side),
            (path, content) => void this.saveWorkspaceFile(path, content),
            (action, section, path) => void this.runWorkingTreeAction(action, section, path),
        );
        this.commitPanel = new CommitPanel({
            onCommit: (repositoryPath, repositoryPaths, message, amend) => void this.runCommit(repositoryPath, repositoryPaths, message, amend),
            onPush: (repositoryPaths, pullBeforePush) => void this.runCommitPanelPush(repositoryPaths, pullBeforePush),
            onPickPushBranch: repositoryPath => void this.pickCommitPanelPushBranch(repositoryPath),
            onUpdateCardState: (repositoryPath, patch) => this.updateCommitCardState(repositoryPath, patch),
            onToggleDisplayMode: () => this.dispatchIntent({ type: 'toggleFilesMode' }),
            onToggleAmend: (repositoryPath, message) => void this.toggleCommitAmend(repositoryPath, message),
            onHistory: repositoryPath => void this.pickCommitHistoryMessage(repositoryPath),
            onFocusRepository: repositoryPath => this.commitPanel.focus(repositoryPath),
            onSelectFile: (repositoryPath, section, filePath) =>
                void this.openCommitPanelWorkingTreeDiff(repositoryPath, section, filePath),
            onWorkingTreeAction: (repositoryPath, action, section, paths, untrackedPaths) =>
                void this.runCommitPanelWorkingTreeAction(repositoryPath, action, section, paths, untrackedPaths),
        });
        this.commitPanelViewTitleController = new CommitPanelViewTitleController(() => {
            this.syncCommitRepositories();
            this.commitPanel.show(this.buildCommitSnapshot());
        });
        this.diffReader = new DiffReader();
        this.gitActions = new GitActionRunner(
            repositoryPath => this.getRepoRootUri(repositoryPath),
            (_rootUri, reloadSelectors = true, refreshOnlyWhenCurrentBranchSelected?: boolean) => {
                if (refreshOnlyWhenCurrentBranchSelected !== undefined) {
                    const currentBranch = this.branches.find(branch => branch.kind === 'current');
                    if (!refreshOnlyWhenCurrentBranchSelected
                        || !currentBranch
                        || !this.selectedBranches.includes(currentBranch.name)) {
                        return Promise.resolve();
                    }
                }
                return this.refresh(reloadSelectors);
            },
            commitEditMsgEditor,
        );
        // 三个控制器只发通知；推 Webview 与串联下游都由 Provider 承担。
        context.subscriptions.push(
            this.repoController,
            this.repoSubmoduleWatcher,
            this.repoHeadBranchWatcher,
            this.selectedRepoTotalBranchWatcher,
            this.uncommittedFilesWatcher,
            // 保持 selectedRepoSubscription 在构造阶段的订阅顺序；不要移到 Controller 创建之后。
            this.selectedRepoSubscription,
            this.reposLoadingSubscription,
            this.repoController.ontotalRepoListChanged(repositories => {
                this.totalRepoListSnapshot = [...repositories];
                this.onDidChangeRepositoryStateEmitter.fire();
                this.view?.webview.postMessage({
                    type: 'totalRepoListChanged',
                    repositories,
                    selectedRepositoryPaths: this.selectedRepositoryPaths,
                });
                // 头按钮显示快照必须随列表刷新：列表项图标每次都按当前 hasSubmodules 重绘，
                // 但快照是选中时一次性写入的；增量扫描期间 hasSubmodules 会由 false 变 true，
                // 这里同步重新发布，保证下拉按钮图标与列表项一致。
                this.refreshSelectedRepoDisplaySnapshot();
                if (this.commitPanel.isVisible()) {
                    this.syncCommitRepositories();
                    this.commitPanel.update(this.buildCommitSnapshot());
                }
            }),
            this.branchesController,
            this.branchesController.onTotalBranchesListChanged(branchesMap => {
                const branches = [...branchesMap.values()].flat();
                this.totalBranchesListSnapshot = branches;
                this.view?.webview.postMessage({ type: 'totalBranchesListChanged', branches });
                this.onSelectedBranchesChanged(this.branchesController.getSelectedBranchesByRepository());
            }),
            // 保持 selectedBranchesSubscription 在 GitCommitController 创建前注册，确保分支 UI 先于提交刷新。
            this.selectedBranchesSubscription,
            this.branchesController.onBranchesLoadingChanged(loading => {
                this.branchesLoadingSnapshot = loading;
                this.view?.webview.postMessage({ type: 'branchLoadingChanged', loading });
            }),
            this.commitController,
            this.commitController.onSearchedCommitsChanged(() => this.onSearchedCommitsChanged()),
            this.commitController.onTotalCommitsChanged(() => {
                this.onSelectedCommitChanged(this.commitController.selectedCommit);
            }),
            this.commitController.onSelectedCommitChanged(commit => this.onSelectedCommitChanged(commit)),
            this.commitController.onWorkingTreeChangesChanged(event => this.onWorkingTreeChangesChanged(event.changes, event.affectedPaths)),
            this.commitController.onUncommittedPresenceChanged(() => this.schedulePushState()),
            // 状态事件维护所有仓库的未提交卡片，并同步提交图当前仓库的虚拟行。
            this.uncommittedFilesWatcher.onEachHeadBranchUncommittedFileChanged(event => {
                this.onRepositoryUncommittedFilesChanged(event.branch, event.changes);
                if (this.commitController.uncommittedRepositoryPath === event.branch.repoOption.path) {
                    this.schedulePushState();
                }
            }),
            this.uncommittedFilesWatcher.onEachHeadBranchUncommittedFileContentChanged(event => {
                this.onWorkingTreeFileContentChanged(event.branch, event.affectedPaths);
            }),
            // 轻量存在性事件只驱动徽标与状态栏的仓库计数，不等完整清单读取完成。
            this.uncommittedFilesWatcher.onRepositoryUncommittedPresenceChanged(event => {
                this.uncommittedPresence.set(event.repositoryPath, event.hasChanges);
                this.onDidChangeWorkingTreeSummaryEmitter.fire();
                this.schedulePushState();
            }),
            this.commitController.onCommitsLoadingChanged(loading => {
                this.setLoading(loading, loading ? this.commitLoadingMessage : undefined);
                if (loading) { this.postLoadingProgress('commit', this.commitLoadingMessage, 0, 0); }
                this.schedulePushState();
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration('vscode-gitk.changedFilesDisplayMode')) { return; }
                // scope 为 application, 生效值只来自 Global, 与 update() 的写入目标一致, 回读值必然等于刚写入值。
                this.displayMode = vscode.workspace.getConfiguration('vscode-gitk').get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
                if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
            }),
        );
        context.subscriptions.push(
            this.onDidChangeDiffAvailabilityEmitter,
            this.multiDiffPanel,
            this.commitPanel,
            this.commitPanelViewTitleController,
            new vscode.Disposable(() => {
                this.storeUnsubscribe?.();
                this.storeUnsubscribe = undefined;
                this.cancelActiveRequests();
                this.viewDisposables.forEach(disposable => disposable.dispose());
                this.viewDisposables = [];
                this.gitWatchDisposables.forEach(disposable => disposable.dispose());
                this.gitWatchDisposables = [];
            }),
        );
    }

    initializeBackground(): void {
        this.initializeGitWatchers();
        void this.refresh(true);
    }

    canShowMultiDiff(): boolean {
        return !!this.currentHash;
    }

    isGitkLoading(): boolean {
        return this.isLoading;
    }

    getWorkingTreeSummary(): {
        repositoryCount: number;
        stagedCount: number;
        unstagedCount: number;
        untrackedCount: number;
        repositories: Array<{ label: string; stagedCount: number; unstagedCount: number; untrackedCount: number }>;
    } {
        const repositories = store.getState().commitRepositories;
        const summaries = repositories.map(repository => ({
            label: repository.repositoryLabel,
            stagedCount: repository.staged.length,
            unstagedCount: repository.unstaged.filter(file => !file.isUntracked).length,
            untrackedCount: repository.unstaged.filter(file => file.isUntracked).length,
        }));
        return {
            // 仓库数只关心“有无变更”，与徽标共用轻量存在性结果，不等完整清单。
            repositoryCount: this.countUncommittedRepositories(repositories),
            stagedCount: summaries.reduce((count, repository) => count + repository.stagedCount, 0),
            unstagedCount: summaries.reduce((count, repository) => count + repository.unstagedCount, 0),
            untrackedCount: summaries.reduce((count, repository) => count + repository.untrackedCount, 0),
            repositories: summaries,
        };
    }

    async selectCommit(hash: string, repositoryPath?: string, revealDiff = false): Promise<void> {
        const generation = ++this.commitFilesGeneration;
        this.pendingFilesRevealGeneration = undefined;
        // 先废弃在途请求的数据: 推进各 generation 使回程结果被丢弃; abort 只做通知不阻塞。
        this.commitFilesAbortController?.abort();
        this.diffReader.stop();
        this.multiDiffPanel.cancelPending();
        store.setState({
            diffLoading: true,
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
        });
        if (generation !== this.commitFilesGeneration) { return; }
        const abortController = new AbortController();
        this.commitFilesAbortController = abortController;
        try {
            await this.setCommitFiles(hash, repositoryPath, generation, abortController.signal, revealDiff);
        } catch (error: any) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.commitFilesAbortController === abortController) {
                this.commitFilesAbortController = undefined;
            }
            this.updateViewVisible();
        }
    }

    private getWorkingTreeDiffCacheKey(repositoryPath: string, hash: 'uncommitted', files: readonly CommitFile[]): string {
        const fileState = files.map(file => [
            file.diffKey,
            file.status,
            file.oldPath,
            file.oldObjectId,
            file.newObjectId,
            file.oldMode,
            file.newMode,
        ].join('\u0000')).join('\u0001');
        return `${repositoryPath}\u0002${hash}\u0002${fileState}`;
    }

    private clearWorkingTreeDiffCache(repositoryPath: string): void {
        const prefix = `${repositoryPath}\u0002`;
        for (const key of this.workingTreeDiffCache.keys()) {
            if (key.startsWith(prefix)) { this.workingTreeDiffCache.delete(key); }
        }
    }

    /** 仅复用本次 Git 操作未影响且元数据未变化的 Diff，避免单文件操作重读整份工作区。 */
    private canReuseWorkingTreeDiff(
        diff: DiffPayload,
        file: CommitFile,
        affectedPaths: ReadonlySet<string>,
    ): boolean {
        const isAffected = affectedPaths.has(file.path)
            || (!!file.oldPath && affectedPaths.has(file.oldPath))
            || affectedPaths.has(diff.path)
            || (!!diff.oldPath && affectedPaths.has(diff.oldPath));
        return !isAffected
            && diff.path === file.path
            && diff.status === file.status
            && diff.oldPath === file.oldPath
            && diff.oldObjectId === file.oldObjectId
            && diff.newObjectId === file.newObjectId
            && diff.oldMode === file.oldMode
            && diff.newMode === file.newMode
            && diff.isGitlink === file.isGitlink
            && diff.isUntracked === file.isUntracked
            && diff.workingTreeKind === file.workingTreeKind
            && diff.diffKey === file.diffKey;
    }

    private async selectWorkingTreeChanges(
        changes?: { staged: ChangedFile[]; changes: ChangedFile[] },
        showLoading = true,
        revealDiff = false,
        affectedPaths?: ReadonlySet<string>,
        updateWorkingTreeState = true,
    ): Promise<void> {
        const selectedBranch = this.commitController.selectedCommit?.gitBranchOption;
        const selectedHash = this.commitController.selectedCommit?.hash;
        // 未处于工作区上下文时不做任何 Diff 工作, 因此不能推进 generation。
        // 否则会把一个正在进行且健康的工作区读取请求无谓作废, 而本次又不产生终态,
        // 导致 diffLoading 永远停在 true, 面板既无卡片也无空态。
        if (!selectedBranch || !isWorkingTreeHash(selectedHash)) { return; }
        const generation = ++this.commitFilesGeneration;
        const workingTreeChanges = changes ?? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(selectedBranch);
        if (generation !== this.commitFilesGeneration
            || !isWorkingTreeHash(this.currentHash)
            || this.currentRepositoryPath !== selectedBranch.repoOption.path) {
            return;
        }
        // 'uncommitted' 行同时展示已暂存与未暂存/未跟踪文件, staged 排在前, 与 Commit 面板列表顺序一致。
        const staged = workingTreeChanges.staged.map(file => new CommitFile({
            ...file,
            workingTreeKind: 'staged',
            diffKey: `staged:${file.path}`,
        }));
        const unstaged = workingTreeChanges.changes.map(file => new CommitFile({
            ...file,
            workingTreeKind: file.isUntracked ? 'untracked' : 'unstaged',
            diffKey: `unstaged:${file.path}`,
        }));
        const files = [...staged, ...unstaged];
        const workingTreeDiffCacheKey = this.getWorkingTreeDiffCacheKey(selectedBranch.repoOption.path, selectedHash, files);
        const cachedDiffs = this.workingTreeDiffCache.get(workingTreeDiffCacheKey);
        if (cachedDiffs) {
            const selectedFile = cachedDiffs.find(file => (file.diffKey || file.path) === this.selectedPath)
                ?? cachedDiffs.find(file => file.path === this.files.find(current => (current.diffKey || current.path) === this.selectedPath)?.path)
                ?? cachedDiffs[0];
            store.setState({
                files: [...cachedDiffs],
                filesLoading: false,
                diffLoading: false,
                diffError: undefined,
                diffProgress: { completed: cachedDiffs.length, total: cachedDiffs.length },
                selectedPath: selectedFile?.diffKey || selectedFile?.path,
            });
            return;
        }
        if (updateWorkingTreeState) {
            const commitRepositories = store.getState().commitRepositories;
            const commitRepository = {
                repository: selectedBranch.repoOption,
                repositoryPath: selectedBranch.repoOption.path,
                repositoryLabel: selectedBranch.repoOption.label ?? path.basename(vscode.Uri.parse(selectedBranch.repoOption.path).fsPath),
                staged: [...workingTreeChanges.staged],
                unstaged: [...workingTreeChanges.changes],
            };
            const existingRepositoryIndex = commitRepositories.findIndex(repository => repository.repositoryPath === commitRepository.repositoryPath);
            const nextCommitRepositories = existingRepositoryIndex < 0
                ? [...commitRepositories, commitRepository]
                : commitRepositories.map((repository, index) => index === existingRepositoryIndex ? commitRepository : repository);
            store.setState({
                stagedFiles: [...workingTreeChanges.staged],
                unstagedFiles: [...workingTreeChanges.changes],
                commitRepositories: nextCommitRepositories,
            });
            if (this.commitPanel.isVisible()) {
                this.commitPanel.update(this.buildCommitSnapshot());
            }
        }
        const previousSelectedFile = this.files.find(file => (file.diffKey || file.path) === this.selectedPath);
        const previousDiffsByKey = new Map(this.files
            .filter((file): file is DiffPayload => file instanceof DiffPayload)
            .map(file => [file.diffKey || file.path, file]));
        const reusableDiffsByKey = new Map<string, DiffPayload>();
        const filesToRead = affectedPaths && affectedPaths.size > 0
            ? files.filter(file => {
                const key = file.diffKey || file.path;
                const previousDiff = previousDiffsByKey.get(key);
                if (!previousDiff || !this.canReuseWorkingTreeDiff(previousDiff, file, affectedPaths)) { return true; }
                reusableDiffsByKey.set(key, previousDiff);
                return false;
            })
            : files;
        const reusedCount = reusableDiffsByKey.size;
        const rootUri = vscode.Uri.parse(selectedBranch.repoOption.path);
        this.diffReader.stop();
        store.setState({
            diffLoading: true,
            diffError: undefined,
            diffProgress: { completed: reusedCount, total: files.length },
        });
        store.setState({ diffGeneration: store.getState().diffGeneration + 1 });
        const readDiffs = filesToRead.length > 0
            ? await this.diffReader.readDiffs(rootUri, 'uncommitted', filesToRead, 'uncommitted', 0, completed => {
                if (generation !== this.commitFilesGeneration) { return; }
                store.setState({ diffProgress: { completed: reusedCount + completed, total: files.length } });
            })
            : [];
        if (generation !== this.commitFilesGeneration
            || !isWorkingTreeHash(this.currentHash)
            || this.currentRepositoryPath !== selectedBranch.repoOption.path
            || readDiffs.length !== filesToRead.length) { return; }
        const readDiffsByKey = new Map(readDiffs.map(file => [file.diffKey || file.path, file]));
        const diffs = files.map((file, index) => {
            const key = file.diffKey || file.path;
            const payload = readDiffsByKey.get(key) ?? reusableDiffsByKey.get(key);
            return new DiffPayload({ ...payload, ...file, index });
        });
        this.workingTreeDiffCache.set(workingTreeDiffCacheKey, diffs);
        const selectedFile = diffs.find(file => (file.diffKey || file.path) === this.selectedPath)
            ?? diffs.find(file => file.path === previousSelectedFile?.path)
            ?? diffs[0];
        const selectedFilePath = selectedFile?.diffKey || selectedFile?.path;
        this.pendingFilesRevealGeneration = showLoading && diffs.length > 0 ? generation : undefined;
        store.setState({
            files: diffs,
            filesLoading: showLoading && diffs.length > 0,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: diffs.length, total: diffs.length },
            selectedPath: selectedFilePath,
        });
        void this.refreshGitlinkDiffs(rootUri, filesToRead, generation, workingTreeDiffCacheKey);
        if (this.commitPanel.isVisible()) {
            this.commitPanel.update(this.buildCommitSnapshot());
        }
        if (diffs.length === 0) {
            return;
        }
        if (showLoading && revealDiff && this.canShowMultiDiff() && this.view?.visible) {
            this.openDiff(selectedFilePath);
        } else if (showLoading) {
            this.filesLoading = false;
        }
    }

    private isAbortError(error: unknown): boolean {
        const candidate = error as { name?: string; code?: string } | undefined;
        return candidate?.name === 'AbortError' || candidate?.code === 'ABORT_ERR';
    }

    private cancelActiveRequests(): void {
        this.refreshAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.refreshAbortController = undefined;
        this.commitFilesAbortController = undefined;
    }

    /** 请求仓库扫描；首轮由控制器自行初始化，其后只做重扫。 */
    private requestRepositoryScan(): void {
        if (!this.hasStartedRepositoryScan) {
            this.hasStartedRepositoryScan = true;
            void this.repoController.initialize();
            return;
        }
        void this.repoController.rescan();
    }

    /** 仓库选择变化后的唯一下游入口：更新显示快照，分支和提交由各自控制器负责加载。 */
    private onSelectedRepoListChanged(selected: readonly GitRepositoryOption[]): void {
        const repository = selected.length === 1 ? selected[0] : undefined;
        this.commitFilesGeneration++;
        this.commitFilesAbortController?.abort();
        this.commitPanelDiffAbortController?.abort();
        this.diffReader.stop();
        this.multiDiffPanel.cancelPending();
        this.pendingFilesRevealGeneration = undefined;
        store.setState({
            files: [],
            stagedFiles: [],
            unstagedFiles: [],
            selectedPath: undefined,
            currentHash: undefined,
            currentRepositoryPath: undefined,
            currentChangeSet: 'commit',
            filesLoading: true,
            diffLoading: true,
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
            diffGeneration: store.getState().diffGeneration + 1,
        });
        this.selectedRepoDisplaySnapshot = repository
            ? {
                label: repository.label, path: repository.path,
                hasSubmodules: Boolean(repository.hasSubmodules),
                isSubmodule: repository.ancestry.length > 0,
            }
            : undefined;
        this.view?.webview.postMessage({
            type: 'selectedRepoDisplayChanged',
            repository: this.selectedRepoDisplaySnapshot,
        });
        // 选择事件产生后立即同步完整状态，不能等待提交或分支事件。
        this.pushStateToWebview();
    }

    /** 父仓库和子仓库图标都依赖仓库拓扑；子模块扫描完成后须重新发布已选项。 */
    private refreshSelectedRepoDisplaySnapshot(): void {
        const current = this.repoController.selectedRepoList;
        const repository = current.length === 1 ? current[0] : undefined;
        const next = repository
            ? {
                label: repository.label, path: repository.path,
                hasSubmodules: Boolean(repository.hasSubmodules),
                isSubmodule: repository.ancestry.length > 0,
            }
            : undefined;
        if (this.selectedRepoDisplaySnapshot?.path === next?.path
            && this.selectedRepoDisplaySnapshot?.hasSubmodules === next?.hasSubmodules
            && this.selectedRepoDisplaySnapshot?.isSubmodule === next?.isSubmodule) {
            return;
        }
        this.selectedRepoDisplaySnapshot = next;
        this.view?.webview.postMessage({
            type: 'selectedRepoDisplayChanged',
            repository: next,
        });
    }

    /**
     * 徽标计数优先取轻量存在性结果。存在性探测不等 --untracked-files=all 递归展开，
     * 因此能在完整清单就绪前给出计数；存在性缺失的仓库回退到完整清单判定。
     */
    private countUncommittedRepositories(
        repositories: ReadonlyArray<{ repositoryPath: string; staged: readonly unknown[]; unstaged: readonly unknown[] }>,
    ): number {
        let count = 0;
        for (const repository of repositories) {
            const presence = this.uncommittedPresence.get(repository.repositoryPath);
            const hasChanges = presence ?? (repository.staged.length > 0 || repository.unstaged.length > 0);
            if (hasChanges) { count++; }
        }
        return count;
    }

    /** 分支选择变化后的唯一下游入口：更新显示快照，提交加载只由 CommitController 事件驱动。 */
    private onSelectedBranchesChanged(branchesMap: ReadonlyMap<GitRepositoryOption, GitBranchOption[]>): void {
        this.selectedBranchesMap = new Map([...branchesMap].map(([repository, branches]) => [repository, [...branches]]));
        this.schedulePushState();
        const branches = [...this.selectedBranchesMap.values()].flat();
        const currentBranch = branches.find(branch => branch.kind === 'current');
        const names = [...new Set(branches.map(branch => branch.name))];
        const displayBranch = currentBranch ?? branches[0];
        this.selectedBranchDisplaySnapshot = displayBranch && names.length === 1
            ? { label: displayBranch.label, title: displayBranch.name, names, kind: displayBranch.kind }
            : {
                label: names.length === 0 ? '未选择分支' : names.length === 1 ? branches[0].label : `已选择 ${names.length} 个分支`,
                title: names.length === 0 ? '未选择分支' : names.join(', '),
                names,
                kind: displayBranch?.kind,
            };
        this.view?.webview.postMessage({
            type: 'selectedBranchDisplayChanged',
            display: this.selectedBranchDisplaySnapshot,
        });
        // 当前分支选择产生后立即同步完整状态，不能依赖提交列表事件。
        this.pushStateToWebview();
    }

    /** 提交列表变化后的唯一下游入口：初始化卡片默认信息并推送提交列表状态。 */
    private onSearchedCommitsChanged(): void {
        this.initializeCommitMessagesFromProjectHistory();
        this.schedulePushState();
    }

    /** 每个仓库仅首次以当前项目中最新已加载的提交信息填充，之后完全由卡片输入状态接管。 */
    private initializeCommitMessagesFromProjectHistory(): void {
        for (const commit of this.commits) {
            const repositoryPath = commit.gitBranchOption?.repoOption.path;
            // rawMessage 取自 git log %B, 是未经拆分/裁剪的原始提交信息, 原样还原用户当时的输入。
            const message = (commit.rawMessage ?? commit.message).replace(/\s+$/, '');
            if (!repositoryPath || !message || this.initializedCommitMessagesByRepo.has(repositoryPath)) { continue; }
            this.commitMessageByRepo.set(repositoryPath, message);
            this.initializedCommitMessagesByRepo.add(repositoryPath);
        }
    }

    /** 任一仓库未提交变化 (来自 watcher) 时增量更新多仓库 Store, 并刷新 Commit 面板对应卡片。 */
    private onRepositoryUncommittedFilesChanged(branch: GitBranchOption, changes: WorkingTreeChanges): void {
        const repositoryPath = branch.repoOption.path;
        this.clearWorkingTreeDiffCache(repositoryPath);
        const label = branch.repoOption.label ?? path.basename(vscode.Uri.parse(repositoryPath).fsPath);
        const existing = store.getState().commitRepositories;
        const entry = {
            repository: branch.repoOption,
            repositoryPath,
            repositoryLabel: label,
            staged: [...changes.staged],
            unstaged: [...changes.changes],
        };
        const index = existing.findIndex(repo => repo.repositoryPath === repositoryPath);
        const next = index >= 0
            ? existing.map((repo, i) => (i === index ? entry : repo))
            : [...existing, entry];
        store.setState({ commitRepositories: next });
        this.onDidChangeWorkingTreeSummaryEmitter.fire();
        this.commitPanelViewTitleController.update(next);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    /** 文件内容变化不改变未提交状态，仅替换当前虚拟提交中受影响路径的 Diff 负载。 */
    private onWorkingTreeFileContentChanged(
        branch: GitBranchOption,
        affectedPaths: readonly string[],
    ): void {
        const selectedCommit = this.commitController.selectedCommit;
        if (!isWorkingTreeHash(selectedCommit?.hash)
            || selectedCommit.gitBranchOption?.repoOption.path !== branch.repoOption.path
            || selectedCommit.gitBranchOption.hash !== branch.hash) { return; }
        // 内容事件覆盖工作区内容变化与 index 内容变化；DiffReader 会按 workingTreeKind 读取正确来源。
        if (affectedPaths.length > 0) { void this.refreshWorkingTreeDiffs(branch, affectedPaths); }
    }

    /** 内容事件只读取并替换已展示的目标 Diff，不重建文件清单或 Commit Panel。 */
    private async refreshWorkingTreeDiffs(branch: GitBranchOption, affectedPaths: readonly string[]): Promise<void> {
        const paths = new Set(affectedPaths);
        const files = this.files.filter((file): file is DiffPayload =>
            file instanceof DiffPayload && (paths.has(file.path) || (!!file.oldPath && paths.has(file.oldPath))),
        );
        if (files.length === 0) { return; }
        const generation = ++this.commitFilesGeneration;
        this.diffReader.stop();
        // 当前提交身份未变化，仅替换受影响文件的 Diff，不能进入全量加载态。
        store.setState({
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: this.files.length, total: this.files.length },
            diffGeneration: store.getState().diffGeneration + 1,
        });
        const rootUri = vscode.Uri.parse(branch.repoOption.path);
        const workingTreeHash = this.currentHash;
        // 缓存键由清单元数据组成, 无法表达工作区内容(unstaged 的 newObjectId 恒为全 0);
        //   因此每次内容重读都必须回写缓存, 否则切走再切回会拿到本次之前的旧正文。
        const cacheKey = isWorkingTreeHash(workingTreeHash)
            ? this.getWorkingTreeDiffCacheKey(branch.repoOption.path, workingTreeHash, this.files)
            : undefined;
        const refreshed = await this.diffReader.readDiffs(rootUri, 'uncommitted', files, 'uncommitted');
        if (generation !== this.commitFilesGeneration
            || !isWorkingTreeHash(this.currentHash)
            || this.currentRepositoryPath !== branch.repoOption.path
            || this.commitController.selectedCommit?.gitBranchOption?.hash !== branch.hash) { return; }
        this.applyRefreshedDiffs(refreshed);
        if (cacheKey) {
            this.workingTreeDiffCache.set(
                cacheKey,
                this.files.filter((file): file is DiffPayload => file instanceof DiffPayload),
            );
        }
    }

    // 将重读到的 Diff 负载按 diffKey/path 就地替换回 store.files, 保持原有下标与未受影响项不变。
    private applyRefreshedDiffs(refreshed: readonly DiffPayload[]): void {
        const refreshedByKey = new Map(refreshed.map(file => [file.diffKey || file.path, file]));
        const nextFiles = this.files.map((file, index) => {
            const refreshedFile = refreshedByKey.get(file.diffKey || file.path);
            return refreshedFile ? new DiffPayload({ ...refreshedFile, index }) : file;
        });
        store.setState({
            files: nextFiles,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: nextFiles.length, total: nextFiles.length },
        });
    }

    private onWorkingTreeChangesChanged(
        changes: { staged: ChangedFile[]; changes: ChangedFile[] },
        eventAffectedPaths?: readonly string[],
    ): void {
        const repositoryPath = this.commitController.uncommittedRepositoryPath;
        if (repositoryPath && this.workingTreeUiMutations.has(repositoryPath)) {
            this.deferredWorkingTreeChanges.set(repositoryPath, { changes, affectedPaths: eventAffectedPaths });
            return;
        }
        this.applyWorkingTreeChanges(changes, eventAffectedPaths);
    }

    private applyWorkingTreeChanges(
        changes: { staged: ChangedFile[]; changes: ChangedFile[] },
        eventAffectedPaths?: readonly string[],
    ): Promise<void> {
        this.schedulePushState();
        // 显式 Git 操作的 pending 路径与 watcher 事件携带的受影响路径取并集,
        // 后者覆盖"状态与内容同时变化"时被编辑文件需连内容重读的场景。
        const pending = this.pendingWorkingTreeDiffPaths;
        this.pendingWorkingTreeDiffPaths = undefined;
        const affectedPaths = pending || eventAffectedPaths
            ? new Set<string>([...(pending ?? []), ...(eventAffectedPaths ?? [])])
            : undefined;
        const selectedBranch = this.commitController.selectedCommit?.gitBranchOption;
        if (!isWorkingTreeHash(this.currentHash)
            || !selectedBranch
            || selectedBranch.repoOption.path !== this.commitController.uncommittedRepositoryPath) { return Promise.resolve(); }
        return this.selectWorkingTreeChanges(changes, false, false, affectedPaths)
            .then(() => this.refreshCommitPanel());
    }

    /** 选中提交状态与文件读取统一由该回调驱动，覆盖首次默认选择和用户选择。 */
    private onSelectedCommitChanged(commit: CommitMetadata | undefined): void {
        const hash = commit?.hash;
        const repositoryPath = commit?.gitBranchOption?.repoOption.path;
        // 提交内容身份由仓库和 commit id 共同组成；虚拟提交固定使用 uncommitted。
        if (hash === this.currentHash && repositoryPath === this.currentRepositoryPath) {
            this.schedulePushState();
            return;
        }
        const isVirtual = isWorkingTreeHash(hash);
        const revealDiff = this.requestedDiffReveal?.hash === hash
            && this.requestedDiffReveal.repositoryPath === repositoryPath;
        if (revealDiff) { this.requestedDiffReveal = undefined; }
        store.setState({
            currentHash: hash,
            currentRepositoryPath: repositoryPath,
            currentChangeSet: isVirtual ? hash : 'commit',
            selectedPath: undefined,
            files: [],
            stagedFiles: [],
            unstagedFiles: [],
            filesLoading: Boolean(commit),
            diffLoading: Boolean(commit),
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
        });
        this.schedulePushState();
        const shouldOpenDiff = this.restoreDiffPanelOnViewVisible || this.openDiffOnInitialVisible;
        if (shouldOpenDiff && this.view?.visible && this.currentHash) {
            this.restoreDiffPanelOnViewVisible = false;
            this.openDiffOnInitialVisible = false;
            this.openDiff();
        }
        if (!commit || !hash) { return; }
        if (isVirtual) {
            void this.selectWorkingTreeChanges(undefined, true, revealDiff);
        } else {
            void this.selectCommit(hash, repositoryPath, revealDiff);
        }
    }

    private setLoading(value: boolean, message?: string): void {
        if (this.isLoading !== value) {
            this.isLoading = value;
            if (!value) { this.loadingMessage = undefined; }
            this.onDidChangeDiffAvailabilityEmitter.fire();
        }
        // 二次刷新沿用 setLoading 时也要带阶段文案，避免退回通用"加载中..."。
        if (value && message) { this.loadingMessage = message; }
        if (!value) { this.lastLoadingProgress = undefined; }
    }

    /**
     * 加载态呈现方式: 已选仓库/分支不变的就地重读用顶部进度条, 选择变化要重建列表时用全屏蒙版。
     * 进度消息必须先于状态快照到达(加载事件先发 loadingProgress 再 schedulePushState),
     *   因此它必须自带模式, 否则 Webview 会先按上一轮的模式闪一下再被纠正。
     */
    private get commitLoadingMode(): 'bar' | 'overlay' {
        return this.commitController.isInPlaceReload ? 'bar' : 'overlay';
    }

    /** 提交列表阶段文案: 搜索与重读必须区分, 否则搜索时仍挂着"加载历史提交列表"。 */
    private get commitLoadingMessage(): string {
        return this.commitController.isSearching ? '正在搜索提交...' : '正在加载历史提交列表...';
    }

    // 统一投递加载进度并记录，供 Webview 后接管时重播。
    private postLoadingProgress(phase: string, message: string, current: number, total: number): void {
        this.lastLoadingProgress = { phase, message, current, total };
        this.loadingMessage = message;
        this.view?.webview.postMessage({
            type: 'loadingProgress',
            phase,
            message,
            current,
            total,
            loadingMode: this.commitLoadingMode,
        });
    }

    private republishLoadingProgress(): void {
        const progress = this.lastLoadingProgress;
        if (!progress) { return; }
        this.view?.webview.postMessage({ type: 'loadingProgress', ...progress });
    }

    private updateMultiDiffVisibility(): void {
        if (!this.view?.visible) {
            this.restoreDiffPanelOnViewVisible = this.multiDiffPanel.isOpen();
            this.multiDiffPanel.hide();
            // 面板隐藏后不会再有渲染完成信号, 立即放行 Changed Files 列表。
            if (this.pendingFilesRevealGeneration !== undefined) {
                this.pendingFilesRevealGeneration = undefined;
                this.filesLoading = false;
            }
            return;
        }
        if (this.restoreDiffPanelOnViewVisible && !this.isLoading && this.currentHash) {
            this.restoreDiffPanelOnViewVisible = false;
            this.openDiff(this.selectedPath);
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        const viewGeneration = ++this.viewGeneration;
        this.view = view;
        this.updateViewVisible();
        if (view.visible) {
            this.openDiffOnInitialVisible = true;
        }
        this.commitPanelViewTitleController.bindView(view, store.getState().commitRepositories);
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons'),
            ],
        };
        view.webview.html = this.getHtml();
        // Store 订阅: 数据驱动推送到 Webview
        this.storeUnsubscribe?.();
        this.storeUnsubscribe = store.subscribe(() => this.schedulePushState());
        this.schedulePushState();
        // 视图级订阅单独管理, onDidDispose 时一并释放, 避免反复创建累积泄漏
        this.viewDisposables.forEach(d => d.dispose());
        this.viewDisposables = [
            view.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            view.onDidChangeVisibility(() => {
                this.updateViewVisible();
                this.updateMultiDiffVisibility();
            }),
            view.onDidDispose(() => {
                if (this.view === view) {
                    this.commitPanelViewTitleController.unbindView(view);
                    this.view = undefined;
                    this.updateViewVisible();
                    this.storeUnsubscribe?.();
                    this.storeUnsubscribe = undefined;
                    ++this.viewGeneration;
                    this.cancelActiveRequests();
                    this.viewDisposables.forEach(d => d.dispose());
                    this.viewDisposables = [];
                }
            }),
        ];
        this.initializingViewGeneration = viewGeneration;
        void this.initializeView(viewGeneration);
    }

    private async initializeView(viewGeneration: number): Promise<void> {
        try {
            this.initializeGitWatchers();
            if (this.viewGeneration !== viewGeneration || !this.view) { return; }
            // Store 已包含上次后台准备的选择器与提交数据时，直接复用快照，不重复读取分支和提交历史。
            if (this.hasPreparedInitialData()) {
                this.pushStateToWebview();
                // 首次进入时后台数据已就绪，立即消费一次初始化打开意图，不能留给后续 Git 操作触发。
                this.updateMultiDiffVisibility();
                if (this.openDiffOnInitialVisible && this.view?.visible && this.currentHash) {
                    this.openDiffOnInitialVisible = false;
                    this.openDiff();
                }
            } else if (this.refreshAbortController) {
                // 后台首次加载仍在进行时只复用其进度，禁止 abort 后从头重启。
                this.pushStateToWebview();
                this.republishLoadingProgress();
            } else {
                await this.refresh();
            }
        } finally {
            if (this.initializingViewGeneration === viewGeneration) {
                this.initializingViewGeneration = 0;
            }
        }
    }

    // 仓库/分支/提交均已改由控制器持有，判据一律回读控制器实时状态。
    private hasPreparedInitialData(): boolean {
        return this.repoController.totalRepoList.length > 0
            && this.branchesController.getBranches().length > 0
            && this.commitController.searchedCommitList.length > 0
            && !this.isLoading;
    }

    private initializeGitWatchers(): void {
        if (this.gitWatchDisposables.some(disposable => disposable === this.gitWatcherSentinel)) { return; }
        // 仓库缓存已由 GitRepoController 自己持有，重扫直接走它的 rescan。
        const refreshWorkspaceRepositories = () => {
            this.hasStartedRepositoryScan = false;
            void this.repoSubmoduleWatcher.initialize();
        };
        this.gitWatchDisposables.push(
            this.gitWatcherSentinel,
            vscode.workspace.onDidChangeWorkspaceFolders(refreshWorkspaceRepositories),
        );
    }

    private readonly gitWatcherSentinel = new vscode.Disposable(() => undefined);

    private queueLifecycleRefresh(): void {
        if (this.initializingViewGeneration === this.viewGeneration) { return; }
        void this.refresh();
    }

    private isRefreshCurrent(generation: number): boolean {
        return generation === this.refreshGeneration;
    }

    // 仅仓库集合可能变化时才重新发现仓库与子模块。
    async refresh(reloadSelectors = true): Promise<void> {
        const generation = ++this.refreshGeneration;
        this.refreshAbortController?.abort();
        const abortController = new AbortController();
        this.refreshAbortController = abortController;
        try {
            await this.refreshInternal(generation, abortController.signal, reloadSelectors);
        } catch (error) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.refreshAbortController === abortController) {
                this.refreshAbortController = undefined;
            }
        }
    }


    /** 当前仓库根 URI：优先取选中提交所属仓库，回退到已选仓库。 */
    private getRepoRootUri(repositoryPath = this.currentRepositoryPath): vscode.Uri | undefined {
        const target = repositoryPath ?? this.selectedRepositoryPath;
        return target ? vscode.Uri.parse(target) : undefined;
    }

    /** 生命周期刷新入口：只负责仓库扫描与加载态。 */
    private async refreshInternal(refreshGen: number, signal?: AbortSignal, reloadSelectors = true): Promise<void> {
        if (signal?.aborted) { return; }
        if (!this.hasRepositorySelection) {
            this.postLoadingProgress('start', '初始化环境...', 0, 0);
        }
        if (reloadSelectors) { this.requestRepositoryScan(); }
        if (signal?.aborted || !this.isRefreshCurrent(refreshGen)) { return; }
        if (this.hasRepositorySelection && this.repositories.length === 0) {
            return;
        }
        this.updateViewVisible();
    }

    /**
     * 手动刷新: 重读当前提交列表和全部仓库当前 HEAD 的未提交变更, 并异步重扫仓库拓扑与分支列表,
     * 不干扰选择器生命周期。
     * 仓库与分支是提交列表的筛选维度, 与提交读取是三条独立数据源, 因此并行推进、互不等待:
     *   重扫后若仓库集合变化, 由 SelectedRepoTotalBranchWatcher.syncRepositories 按 needsFullRefresh 补齐新仓库。
     * 选中仓库的提交列表与工作区状态由 GitCommitController 负责并吸收异常;
     * 其余 current-head 仓库经 watcher 强制刷新, 结果通过 onEachHeadBranchUncommittedFileChanged 回流多仓库 Store。
     */
    private refreshCurrentViewData(): void {
        void this.requestRepositoryScan();
        this.selectedRepoTotalBranchWatcher.refreshSelectedRepositories();
        void this.commitController.forceRefreshCurrentSelection();
        const selectedRepositoryPath = this.commitController.uncommittedRepositoryPath;
        for (const branch of this.uncommittedFilesWatcher.listCurrentHeadBranches()) {
            // 选中仓库已由 commit controller 刷新, 避免重复 status。
            if (branch.repoOption.path === selectedRepositoryPath) { continue; }
            void this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(branch)
                .catch(error => console.warn(`无法刷新未提交文件: ${branch.repoOption.path}`, error));
        }
    }

    private onMessage(message: unknown): void {
        if (!this.isGitkIntent(message)) { return; }
        this.dispatchIntent(message);
    }

    private isGitkIntent(message: unknown): message is GitkIntent {
        return !!message && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string';
    }

    // MVI: Intent 先由 Store 归约状态，再由 Provider 执行声明式副作用。
    private dispatchIntent(msg: GitkIntent): void {
        for (const effect of store.dispatch(msg)) {
            this.runEffect(effect);
        }
    }

    private runEffect(effect: StoreEffect): void {
        switch (effect.type) {
            case 'webviewReady':
                this.view?.webview.postMessage({
                    type: 'totalRepoListChanged',
                    repositories: this.totalRepoListSnapshot,
                    selectedRepositoryPaths: this.selectedRepositoryPaths,
                });
                this.view?.webview.postMessage({ type: 'totalBranchesListChanged', branches: this.totalBranchesListSnapshot });
                this.view?.webview.postMessage({
                    type: 'selectedRepoDisplayChanged',
                    repository: this.selectedRepoDisplaySnapshot,
                });
                this.view?.webview.postMessage({
                    type: 'selectedBranchDisplayChanged',
                    display: this.selectedBranchDisplaySnapshot,
                });
                this.view?.webview.postMessage({ type: 'repoLoadingChanged', loading: this.reposLoadingSnapshot });
                this.view?.webview.postMessage({ type: 'branchLoadingChanged', loading: this.branchesLoadingSnapshot });
                this.pushStateToWebview();
                break;
            case 'refresh':
                this.refreshCurrentViewData();
                break;
            case 'selectRepositories': {
                if (!Array.isArray(effect.paths)) {
                    break;
                }
                const paths = new Set(effect.paths.filter((path): path is string => typeof path === 'string'));
                const selected = this.repositories.filter(repository => paths.has(repository.path));
                if (selected.length !== paths.size) {
                    break;
                }
                this.repoController.selectRepositories(selected);
                break;
            }
            case 'selectBranches': {
                if (!Array.isArray(effect.names)) {
                    break;
                }
                const names = new Set(effect.names.filter((name): name is string => typeof name === 'string'));
                this.branchesController.selectBranches(
                    this.branchesController.getBranches().filter(branch => names.has(branch.name)),
                );
                break;
            }
            case 'loadMoreCommits':
                void this.commitController.loadMoreCommits();
                break;
            case 'gitSync': {
                const repositoryPath = this.selectedRepositoryPath;
                if (repositoryPath && (effect.action === 'fetch' || effect.action === 'pull' || effect.action === 'push')) {
                    void this.gitActions.syncRepository(effect.action, repositoryPath);
                }
                break;
            }
            case 'openRepositoryTerminal': {
                const repositoryPath = this.selectedRepositoryPath;
                const rootUri = repositoryPath ? vscode.Uri.parse(repositoryPath) : undefined;
                if (!rootUri) {
                    void vscode.window.showWarningMessage('请先选择一个仓库。');
                    break;
                }
                const terminalName = path.basename(rootUri.fsPath) || 'Gitk';
                vscode.window.createTerminal({ name: `Gitk: ${terminalName}`, cwd: rootUri }).show();
                break;
            }
            case 'commitAction':
                if (typeof effect.action === 'string' && typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    this.gitActions.runCommitAction(effect.action, effect.hash, effect.repositoryPath);
                }
                break;
            case 'selectCommit':
                if (isWorkingTreeHash(effect.hash)) {
                    const branch = this.branchesController.getSelectedCurrentBranch();
                    if (!branch || !this.commitController.uncommittedRepositoryPath) { break; }
                    this.requestedDiffReveal = { hash: effect.hash, repositoryPath: branch.repoOption.path };
                    const changed = this.commitController.selectCommit(new CommitMetadata({ hash: effect.hash, gitBranchOption: branch }));
                    // 工作区虚拟行的底层数据是动态的: 若 identity 未变化(selectCommit 去重 return false)但当前尚未加载出该行文件,
                    //   必须显式重新加载, 否则"此前加载失败/被门禁 bail 过"的虚拟行会因去重被永久挡死、点击无反应。
                    if (!changed
                        && this.currentHash === effect.hash
                        && this.currentRepositoryPath === branch.repoOption.path) {
                        void this.selectWorkingTreeChanges(undefined, true, true).then(() => this.refreshCommitPanel());
                    }
                } else if (typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    const commit = this.findCommit(effect.hash, effect.repositoryPath);
                    if (commit) {
                        this.requestedDiffReveal = { hash: effect.hash, repositoryPath: effect.repositoryPath };
                        const changed = this.commitController.selectCommit(commit);
                        if (!changed
                            && this.currentHash === effect.hash
                            && this.currentRepositoryPath === effect.repositoryPath) {
                            this.requestedDiffReveal = undefined;
                            this.openDiff(this.selectedPath);
                        }
                    }
                }
                break;
            case 'selectFile':
                if (typeof effect.path === 'string') {
                    this.selectChangedFile(effect.path);
                }
                break;
            case 'copyFilePath':
                if (typeof effect.path === 'string') {
                    const rootUri = effect.absolute === true ? this.getRepoRootUri() : undefined;
                    const value = rootUri
                        ? vscode.Uri.joinPath(rootUri, ...effect.path.split('/')).fsPath
                        : effect.path;
                    void vscode.env.clipboard.writeText(value);
                }
                break;
            case 'workingTreeAction':
                void this.runWorkingTreeAction(effect.action, effect.section, effect.path, undefined, effect.paths);
                break;
            case 'workingTreeCommit':
                if (typeof effect.action === 'string'
                    && typeof effect.repositoryPath === 'string'
                    && typeof effect.message === 'string') {
                    void this.runWorkingTreeCommit(effect.action, effect.repositoryPath, effect.message);
                }
                break;
            case 'updateCommitMessage':
                if (typeof effect.repositoryPath === 'string' && typeof effect.message === 'string') {
                    this.updateWorkingTreeCommitMessage(effect.repositoryPath, effect.message);
                }
                break;
            case 'openCommitEditor':
                void this.runOpenCommitEditor(effect.repositoryPath, effect.amend);
                break;
            case 'openCommitPanel':
                // 打开面板前先同步仓库和工作区快照，避免复用过期的空卡片。
                this.syncCommitRepositories();
                this.commitPanel.show(this.buildCommitSnapshot(), this.selectedRepositoryPath);
                this.repoController.totalRepoList.forEach(repository => {
                    if (repository.hasSubmodules) {
                        void this.loadUnpushedCommitState(repository.path);
                        void this.loadDefaultPushBranch(repository.path);
                    }
                });
                break;
            case 'toggleFilesDisplayModeSetting': {
                const configuration = vscode.workspace.getConfiguration('vscode-gitk');
                const currentDisplayMode = configuration.get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
                void configuration.update(
                    'changedFilesDisplayMode',
                    currentDisplayMode === 'tree' ? 'flat' : 'tree',
                    vscode.ConfigurationTarget.Global,
                );
                break;
            }
            case 'search': {
                // 搜索与去重一律由提交控制器裁决，Provider 不再自行读提交。
                if (typeof effect.keywords !== 'string') { break; }
                const keywords = effect.keywords.trim().split(/\s+/).filter(k => k.length > 0);
                void this.commitController.search(keywords);
                break;
            }
        }
    }

    private findCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        return this.commitController.findCommit(hash, repositoryPath);
    }

    private async runOpenCommitEditor(repositoryPath: string, amend: boolean): Promise<void> {
        try {
            this.commitAmendByRepo.set(repositoryPath, amend);
            this.syncCommitRepositories();
            // 打开时展示所有仓库卡片, 并定位到触发提交的那个仓库。
            this.commitPanel.show(this.buildCommitSnapshot(), repositoryPath);
            this.repoController.totalRepoList.forEach(repository => {
                if (repository.hasSubmodules) { void this.loadDefaultPushBranch(repository.path); }
            });
        } finally {
            store.setState({ commitEditorLoading: false });
        }
    }

    /** Commit Panel 文件点击统一切到对应仓库的虚拟提交，再由同一 MultiDiff 入口激活并定位。 */
    private async openCommitPanelWorkingTreeDiff(
        repositoryPath: string,
        section: 'staged' | 'unstaged',
        filePath: string,
    ): Promise<void> {
        this.commitPanelDiffAbortController?.abort();
        const abortController = new AbortController();
        this.commitPanelDiffAbortController = abortController;
        try {
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (!branch) { return; }
            const revealPath = `${section}:${filePath}`;
            // Commit 面板的 staged/unstaged 分组统一对应合并后的 'uncommitted' 虚拟行。
            const targetHash = 'uncommitted' as const;
            const isCurrentWorkingTree = this.currentHash === targetHash
                && this.currentRepositoryPath === repositoryPath;
            if (!isCurrentWorkingTree) {
                const selectedBranch = await this.selectCommitPanelRepository(branch, abortController.signal);
                if (!selectedBranch || abortController.signal.aborted) { return; }
                const nextGeneration = this.commitFilesGeneration + 1;
                const changed = this.commitController.selectCommit(new CommitMetadata({ hash: targetHash, gitBranchOption: selectedBranch }));
                const selectionIsLoading = this.currentHash === targetHash
                    && this.currentRepositoryPath === repositoryPath
                    && store.getState().diffLoading;
                if (changed || selectionIsLoading) {
                    const generation = changed ? nextGeneration : this.commitFilesGeneration;
                    const loaded = await this.waitForWorkingTreeSelection(repositoryPath, targetHash, generation, abortController.signal);
                    if (!loaded || abortController.signal.aborted) { return; }
                }
            }
            if (this.currentHash !== targetHash
                || this.currentRepositoryPath !== repositoryPath
                || store.getState().diffLoading
                || !this.files.some(file => (file.diffKey || file.path) === revealPath)) { return; }
            store.setState({ selectedPath: revealPath });
            this.openDiff(revealPath);
        } finally {
            if (this.commitPanelDiffAbortController === abortController) {
                this.commitPanelDiffAbortController = undefined;
            }
        }
    }

    private selectCommitPanelRepository(branch: GitBranchOption, signal: AbortSignal): Promise<GitBranchOption | undefined> {
        const selected = this.branchesController.getSelectedCurrentBranch();
        if (selected?.repoOption.path === branch.repoOption.path) { return Promise.resolve(selected); }
        return new Promise(resolve => {
            const finish = (result?: GitBranchOption): void => {
                subscription.dispose();
                signal.removeEventListener('abort', cancel);
                resolve(result);
            };
            const cancel = (): void => finish();
            const subscription = this.branchesController.onSelectedBranchesChanged(branchesByRepository => {
                const current = [...branchesByRepository.values()].flat()
                    .find(candidate => candidate.kind === 'current' && candidate.repoOption.path === branch.repoOption.path);
                if (current) { finish(current); }
            });
            signal.addEventListener('abort', cancel, { once: true });
            this.repoController.selectRepositories([branch.repoOption]);
        });
    }

    private waitForWorkingTreeSelection(repositoryPath: string, targetHash: 'uncommitted', generation: number, signal: AbortSignal): Promise<boolean> {
        return new Promise(resolve => {
            const complete = (): boolean => this.commitFilesGeneration >= generation
                && this.currentHash === targetHash
                && this.currentRepositoryPath === repositoryPath
                && !store.getState().diffLoading;
            if (complete()) { resolve(true); return; }
            const finish = (loaded: boolean): void => {
                unsubscribe();
                signal.removeEventListener('abort', cancel);
                resolve(loaded);
            };
            const cancel = (): void => finish(false);
            const unsubscribe = store.subscribeSelector(
                state => `${state.currentRepositoryPath ?? ''}\u0000${state.currentHash ?? ''}\u0000${state.diffGeneration}\u0000${state.diffLoading}`,
                () => {
                    if (complete()) { finish(true); }
                },
            );
            signal.addEventListener('abort', cancel, { once: true });
        });
    }

    /** 以完整仓库拓扑构造 Commit editor 卡片；HEAD 与工作区状态仅补充卡片内容。 */
    private syncCommitRepositories(): void {
        const currentBranchesByPath = new Map(this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .map(branch => [branch.repoOption.path, branch]));
        const repositories = this.repoController.totalRepoList.map(repository => {
            const repositoryPath = repository.path;
            const branch = currentBranchesByPath.get(repositoryPath);
            // CommitPanel 始终消费 watcher 的全仓库 HEAD 快照；Changed Files 的 stagedFiles/unstagedFiles 只是当前选中虚拟行投影。
            const changes = branch
                ? this.uncommittedFilesWatcher.getCachedUncommittedFilesByHeadBranch(branch)
                    ?? { staged: [], changes: [] }
                : { staged: [], changes: [] };
            return {
                repository,
                repositoryPath,
                repositoryLabel: repository.label,
                staged: [...changes.staged],
                unstaged: [...changes.changes],
            };
        });
        store.setState({ commitRepositories: repositories });
    }

    /** 卡片交互状态由 Provider 保存，后续 UI 只能从快照重建。 */
    private updateCommitCardState(repositoryPath: string, patch: CommitCardStatePatch): void {
        if (patch.message !== undefined) { this.commitMessageByRepo.set(repositoryPath, patch.message); }
        if (patch.selectedCommitSubmoduleRepositoryPaths !== undefined) {
            this.selectedCommitSubmodulesByRepo.set(repositoryPath, [...patch.selectedCommitSubmoduleRepositoryPaths]);
        }
        if (patch.selectedPushSubmoduleRepositoryPaths !== undefined) {
            this.selectedPushSubmodulesByRepo.set(repositoryPath, [...patch.selectedPushSubmoduleRepositoryPaths]);
        }
        if (patch.pullBeforePush !== undefined) { this.pullBeforePushByRepo.set(repositoryPath, patch.pullBeforePush); }
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    /** 从扩展层多仓库 Store 组装卡片; 模板为重开销, 展开时懒加载。 */
    private buildCommitSnapshot(): CommitPanelSnapshot {
        const currentBranchesByPath = new Map(this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .map(branch => [branch.repoOption.path, branch]));
        const repositoriesByPath = new Map(this.repoController.totalRepoList
            .map(repository => [repository.path, repository]));
        // 先同步完整仓库列表，再生成卡片，保证 changes 与 CommitPanel 使用同一份仓库快照。
        const cards = store.getState().commitRepositories.map(repo => {
            const repository = repositoriesByPath.get(repo.repositoryPath) ?? repo.repository;
            const amend = this.commitAmendByRepo.get(repo.repositoryPath) === true;
            const headKey = `${repo.repositoryPath}\u0000${currentBranchesByPath.get(repo.repositoryPath)?.hash ?? ''}`;
            const committedFiles = amend ? this.amendCommittedFilesByHead.get(headKey) ?? [] : [];
            return {
                repositoryPath: repo.repositoryPath,
                repositoryLabel: repository.label,
                repositoryHasSubmodules: Boolean(repository.hasSubmodules),
                repositoryParentPath: repository.ancestry.at(-1)?.path,
                repositoryAncestry: repository.ancestry,
                message: this.commitMessageByRepo.get(repo.repositoryPath) ?? '',
                selectedCommitSubmoduleRepositoryPaths: this.selectedCommitSubmodulesByRepo.get(repo.repositoryPath) ?? [],
                selectedPushSubmoduleRepositoryPaths: this.selectedPushSubmodulesByRepo.get(repo.repositoryPath) ?? [],
                pullBeforePush: this.pullBeforePushByRepo.get(repo.repositoryPath) ?? true,
                pushTargetLabel: (this.lastPushedBranchByRepository.get(repo.repositoryPath)
                    ?? this.pushBranchByRepository.get(repo.repositoryPath))?.upstreamName,
                amend,
                committedFiles: committedFiles.map(file => ({ path: file.path, status: file.status, isUntracked: file.isUntracked, isSubmodule: file.isGitlink || file.oldMode === '160000' || file.newMode === '160000' })),
                committedFilesLoading: amend && this.amendCommittedFilesLoading.has(headKey),
                latestCommitSubmodulePaths: this.commitGitlinkPathsByHead.get(headKey) ?? [],
                hasUnpushedCommits: (this.unpushedCommitCountByRepository.get(repo.repositoryPath) ?? 0) > 0,
                unpushedCommitCount: this.unpushedCommitCountByRepository.get(repo.repositoryPath) ?? 0,
                changedSubmoduleRepositoryPaths: [...repo.staged, ...repo.unstaged]
                    .filter(file => file.isGitlink || file.oldMode === '160000' || file.newMode === '160000')
                    .map(file => path.resolve(vscode.Uri.parse(repo.repositoryPath).fsPath, file.path))
                    .map(repositoryPath => this.repoController.totalRepoList.find(repository =>
                        path.normalize(vscode.Uri.parse(repository.path).fsPath).toLowerCase() === path.normalize(repositoryPath).toLowerCase(),
                    )?.path)
                    .filter((repositoryPath): repositoryPath is string => Boolean(repositoryPath)),
                stagedFiles: repo.staged.map(file => ({ path: file.path, status: file.status, isUntracked: file.isUntracked, isSubmodule: file.isGitlink || file.oldMode === '160000' || file.newMode === '160000' })),
                unstagedFiles: repo.unstaged.map(file => ({ path: file.path, status: file.status, isUntracked: file.isUntracked, isSubmodule: file.isGitlink || file.oldMode === '160000' || file.newMode === '160000' })),
                committing: this.commitCommittingByRepo.has(repo.repositoryPath),
            } satisfies CommitCard;
        });
        return { cards, displayMode: store.getState().displayMode };
    }

    /** 刷新提交面板内容 (add/restore 或工作区变化后): 先同步多仓库 Store 再重建卡片。 */
    private async refreshCommitPanel(): Promise<void> {
        if (!this.commitPanel.isVisible()) { return; }
        this.syncCommitRepositories();
        this.commitPanel.update(this.buildCommitSnapshot());
        this.repoController.totalRepoList.forEach(repository => {
            if (repository.hasSubmodules) {
                void this.loadUnpushedCommitState(repository.path);
            }
        });
    }

    private async loadUnpushedCommitState(repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
        if (!rootUri || !branch) { return; }
        const headKey = `${repositoryPath}\u0000${branch.hash}`;
        if (this.unpushedStateLoadedByHead.has(headKey) || this.unpushedStateLoadingByHead.has(headKey)) { return; }
        this.unpushedStateLoadingByHead.add(headKey);
        try {
            const [ahead, gitlinkPaths] = await Promise.all([
                getGitAheadCount(rootUri),
                getGitlinkPathsInCommit(rootUri, branch.hash),
            ]);
            const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (currentBranch?.hash === branch.hash) {
                this.unpushedCommitCountByRepository.set(repositoryPath, ahead);
                this.commitGitlinkPathsByHead.set(headKey, gitlinkPaths);
                this.unpushedStateLoadedByHead.add(headKey);
            }
        } finally {
            this.unpushedStateLoadingByHead.delete(headKey);
        }
        await this.refreshCommitPanel();
    }

    private async loadAmendCommittedFiles(repositoryPath: string): Promise<void> {
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
        if (!branch) { return; }
        const key = `${repositoryPath}\u0000${branch.hash}`;
        if (this.amendCommittedFilesByHead.has(key) || this.amendCommittedFilesLoading.has(key)) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        this.amendCommittedFilesLoading.add(key);
        await this.refreshCommitPanel();
        try {
            const files = await getCommitFiles(rootUri, branch.hash);
            const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
            if (this.commitAmendByRepo.get(repositoryPath) === true && currentBranch?.hash === branch.hash) {
                this.amendCommittedFilesByHead.set(key, files);
            }
        } finally {
            this.amendCommittedFilesLoading.delete(key);
            await this.refreshCommitPanel();
        }
    }

    private async toggleCommitAmend(repositoryPath: string, message: string): Promise<void> {
        // 由宿主权威状态翻转该仓库的 amend, 不接收 webview 传来的目标值。
        const amend = !(this.commitAmendByRepo.get(repositoryPath) === true);
        if (amend) {
            this.commitMessageBeforeAmendByRepo.set(repositoryPath, message);
        }
        this.commitAmendByRepo.set(repositoryPath, amend);
        if (amend) {
            void this.loadAmendCommittedFiles(repositoryPath);
        } else {
            await this.refreshCommitPanel();
        }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const nextMessage = amend
            ? await readCurrentCommitMessage(rootUri)
            : this.commitMessageBeforeAmendByRepo.get(repositoryPath) ?? '';
        this.commitMessageByRepo.set(repositoryPath, nextMessage);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        if (!amend) {
            this.commitMessageBeforeAmendByRepo.delete(repositoryPath);
        }
    }

    /**
     * 历史提交信息选择器: 直接取当前项目已加载的提交历史(totalCommitList), 既不再执行 git log,
     * 也不受搜索关键词影响; 填入的是 rawMessage(git log %B) 原始完整信息, 不做拼接裁剪, 原样还原用户输入。
     */
    private async pickCommitHistoryMessage(repositoryPath: string): Promise<void> {
        // 同一条信息只保留首次出现(列表按时间倒序, 即最新一条)。
        const history = new Map<string, { shortHash: string; subject: string; message: string }>();
        for (const commit of this.commitController.totalCommitList) {
            if (commit.gitBranchOption?.repoOption.path !== repositoryPath) { continue; }
            const message = (commit.rawMessage ?? commit.message).replace(/\s+$/, '');
            if (!message || history.has(message)) { continue; }
            history.set(message, { shortHash: commit.shortHash, subject: commit.message.trim(), message });
        }
        if (history.size === 0) {
            void vscode.window.showInformationMessage('当前项目没有已加载的历史提交信息。');
            return;
        }
        const items = [...history.values()].map(entry => ({
            label: entry.subject,
            description: entry.shortHash,
            // detail 只支持单行, 把正文中的换行折叠成可见分隔符, 便于挑出带多行正文的提交; 不影响实际填入的 message。
            detail: entry.message.split('\n').slice(1).filter(line => line.trim()).join(' ⏎ '),
            message: entry.message,
        }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择当前项目的历史提交信息填入' });
        if (picked) { this.updateCommitCardState(repositoryPath, { message: picked.message }); }
    }

    private async loadDefaultPushBranch(repositoryPath: string): Promise<void> {
        if (this.pushBranchByRepository.has(repositoryPath)) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const branches = await getPushBranches(rootUri);
        const branch = branches[0];
        if (!branch) { return; }
        this.pushBranchByRepository.set(repositoryPath, branch);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    private async pickCommitPanelPushBranch(repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const branches = await getPushBranches(rootUri);
        if (branches.length === 0) {
            void vscode.window.showInformationMessage('当前仓库没有配置 upstream 的本地分支。');
            return;
        }
        const items = branches.map(branch => {
            return {
                label: branch.upstreamName,
                detail: `未推送提交：${branch.recentUnpushedCommits.length}`,
                branch,
            };
        });
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要推送的分支（按当前分支与最近未推送提交排序）',
        });
        if (!picked) { return; }
        this.pushBranchByRepository.set(repositoryPath, picked.branch);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    private async runCommitPanelPush(
        repositoryPaths: readonly string[],
        pullBeforePush: boolean,
        focusCommitPanel = true,
    ): Promise<void> {
        const rootRepositoryPath = repositoryPaths.at(-1);
        if (!rootRepositoryPath) { return; }
        const rootUri = this.getRepoRootUri(rootRepositoryPath);
        if (!rootUri) { return; }
        const branches = await getPushBranches(rootUri);
        if (branches.length === 0) {
            void vscode.window.showInformationMessage('当前仓库没有配置 upstream 的本地分支。');
            return;
        }
        const branch = this.lastPushedBranchByRepository.get(rootRepositoryPath)
            ?? this.pushBranchByRepository.get(rootRepositoryPath)
            ?? branches[0];
        if (!branch) {
            void vscode.window.showInformationMessage('当前仓库没有配置 upstream 的本地分支。');
            return;
        }
        this.pushBranchByRepository.set(rootRepositoryPath, branch);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        const orderedRepositoryPaths = [...new Set(repositoryPaths)]
            .map((repositoryPath, index) => ({
                repositoryPath,
                index,
                depth: this.repoSubmoduleWatcher.getRepositoryAncestry(repositoryPath).length,
            }))
            .sort((left, right) => right.depth - left.depth || left.index - right.index)
            .map(item => item.repositoryPath);
        const pushedBranchByRepository = new Map<string, Awaited<ReturnType<typeof getPushBranches>>[number]>([
            [rootRepositoryPath, branch],
        ]);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `推送 ${branch.name}`,
                cancellable: false,
            }, async progress => {
                for (const repositoryPath of orderedRepositoryPaths) {
                    const repositoryUri = this.getRepoRootUri(repositoryPath);
                    if (!repositoryUri) { continue; }
                    const repositoryBranch = repositoryPath === rootRepositoryPath
                        ? branch
                        : this.pushBranchByRepository.get(repositoryPath);
                    if (!repositoryBranch) {
                        throw new Error(`仓库未选择可推送分支：${repositoryPath}`);
                    }
                    if (pullBeforePush) {
                        progress.report({ message: `正在切换并拉取：${repositoryPath}` });
                        await runGitCommand(repositoryUri, ['switch', repositoryBranch.name]);
                        await runGitCommand(repositoryUri, ['pull', repositoryBranch.upstreamRemote, repositoryBranch.upstreamBranch]);
                    }
                    progress.report({ message: `正在推送：${repositoryPath}` });
                    if (repositoryPath === rootRepositoryPath) {
                        await runGitCommand(repositoryUri, [
                            'push',
                            branch.upstreamRemote,
                            `${branch.name}:${branch.upstreamBranch}`,
                        ]);
                    } else {
                        await runGitCommand(repositoryUri, [
                            'push', repositoryBranch.upstreamRemote, `${repositoryBranch.name}:${repositoryBranch.upstreamBranch}`,
                        ]);
                        pushedBranchByRepository.set(repositoryPath, repositoryBranch);
                    }
                }
            });
            pushedBranchByRepository.forEach((branch, repositoryPath) => {
                this.lastPushedBranchByRepository.set(repositoryPath, branch);
            });
            await this.context.workspaceState.update('lastPushedBranches', Object.fromEntries(this.lastPushedBranchByRepository));
            if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
            for (const repositoryPath of orderedRepositoryPaths) {
                this.unpushedCommitCountByRepository.delete(repositoryPath);
                for (const headKey of this.unpushedStateLoadedByHead) {
                    if (headKey.startsWith(`${repositoryPath}\u0000`)) {
                        this.unpushedStateLoadedByHead.delete(headKey);
                        this.commitGitlinkPathsByHead.delete(headKey);
                    }
                }
            }
            await this.commitController.forceRefreshCurrentSelection();
        } catch (error) {
            void vscode.window.showErrorMessage(`Git Push 失败：${error instanceof Error ? error.message : String(error)}`);
        }
        // 操作由 Commit 面板触发, 显示权归触发者: 结束后把面板带回编辑器区前台。
        if (focusCommitPanel) {
            this.commitPanel.focus(rootRepositoryPath);
        }
    }

    private async runCommit(
        repositoryPath: string,
        repositoryPaths: readonly string[],
        message: string,
        amend: boolean,
        focusCommitPanel = true,
    ): Promise<boolean> {
        const rootAncestry = new Set([repositoryPath, ...this.repoSubmoduleWatcher.getRepositorySubtree(repositoryPath).map(repository => repository.path)]);
        const orderedRepositoryPaths = [...new Set(repositoryPaths)]
            .filter(path => rootAncestry.has(path))
            .map((path, index) => ({ path, index, depth: this.repoSubmoduleWatcher.getRepositoryAncestry(path).length }))
            .sort((left, right) => right.depth - left.depth || left.index - right.index)
            .map(item => item.path);
        if (!orderedRepositoryPaths.includes(repositoryPath)) { orderedRepositoryPaths.push(repositoryPath); }
        if (orderedRepositoryPaths.some(path => this.commitCommittingByRepo.has(path))) { return false; }
        orderedRepositoryPaths.forEach(path => this.commitCommittingByRepo.add(path));
        await this.refreshCommitPanel();
        const committedRepositoryPaths: string[] = [];
        let committed = false;
        try {
            for (const currentPath of orderedRepositoryPaths) {
                const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                    .find(branch => branch.repoOption.path === currentPath);
                const changes = currentBranch
                    ? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(currentBranch)
                    : undefined;
                if (!changes || (changes.staged.length === 0 && changes.changes.length === 0)) { continue; }
                const rootUri = this.getRepoRootUri(currentPath);
                if (!rootUri) { continue; }
                await commitWithMessage(rootUri, message, currentPath === repositoryPath ? amend : false);
                committed = true;
                committedRepositoryPaths.push(currentPath);
                if (currentPath !== repositoryPath) {
                    const ancestry = this.repoSubmoduleWatcher.getRepositoryAncestry(currentPath);
                    const parent = ancestry.at(-1);
                    if (parent && orderedRepositoryPaths.includes(parent.path)) {
                        const childUri = vscode.Uri.parse(currentPath);
                        const parentUri = vscode.Uri.parse(parent.path);
                        const gitlinkPath = path.relative(parentUri.fsPath, childUri.fsPath).split(path.sep).join('/');
                        await runGitCommand(parentUri, ['add', '--', gitlinkPath]);
                    }
                }
            }
            if (!committed) { void vscode.window.showInformationMessage('变更文件为空，无需提交'); }
            this.commitAmendByRepo.delete(repositoryPath);
            // commit 不改写 .git/HEAD, HEAD 文件监听器不会触发; 必须显式重读并等待新 HEAD 的
            // 工作区状态就绪, 再刷新提交列表, 保证遮罩结束时 staged/unstaged 与新 commit 同步。
            await Promise.all(committedRepositoryPaths
                .map(committedPath => this.uncommittedFilesWatcher.refreshHeadBranch(committedPath)));
            await this.commitController.forceRefreshCurrentSelection();
        } catch (error) {
            void vscode.window.showErrorMessage(`Git Commit 失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            orderedRepositoryPaths.forEach(path => this.commitCommittingByRepo.delete(path));
            await this.refreshCommitPanel();
            // 操作由 Commit 面板触发, 显示权归触发者: 结束后把面板带回编辑器区前台。
            if (focusCommitPanel) {
                this.commitPanel.focus(repositoryPath);
            }
        }
        return committed;
    }

    private async runWorkingTreeCommit(
        action: string,
        repositoryPath: string,
        message: string,
    ): Promise<void> {
        if (!message.trim()) {
            void vscode.window.showWarningMessage('提交信息不能为空');
            return;
        }
        const normalizedAction = action === 'amend' || action === 'push' || action === 'sync'
            ? action
            : 'commit';
        const committed = await this.runCommit(
            repositoryPath,
            [repositoryPath],
            message,
            normalizedAction === 'amend',
            false,
        );
        if (!committed || (normalizedAction !== 'push' && normalizedAction !== 'sync')) {
            return;
        }
        await this.runCommitPanelPush(
            [repositoryPath],
            normalizedAction === 'sync',
            false,
        );
    }

    private updateWorkingTreeCommitMessage(repositoryPath: string, message: string): void {
        this.commitMessageByRepo.set(repositoryPath, message);
        if (this.commitPanel.isVisible()) {
            this.commitPanel.update(this.buildCommitSnapshot());
        }
        this.schedulePushState();
    }

    private async runCommitPanelWorkingTreeAction(
        repositoryPath: string,
        action: 'stage' | 'unstage' | 'discard',
        section: 'staged' | 'unstaged',
        paths: readonly string[],
        untrackedPaths: readonly string[],
    ): Promise<void> {
        if (paths.length === 0) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const untrackedPathSet = new Set(untrackedPaths);
        const discardSelection = action === 'discard'
            ? await this.confirmDiscardWorkingTreeChanges(paths, untrackedPathSet)
            : { paths: [...paths], discardUntrackedToTrash: false };
        if (!discardSelection) { return; }
        const gitlinkPaths = new Set<string>();
        const affectedSubmoduleRepositoryPaths = new Set<string>();
        if (action === 'discard') {
            const gitlinkSubmodules = discardSelection.paths.flatMap(filePath => {
                const submodule = this.repoSubmoduleWatcher.findSubmoduleRepository(repositoryPath, filePath);
                return submodule ? [{ filePath, submodule }] : [];
            });
            let recurseNestedSubmodules = false;
            if (gitlinkSubmodules.some(({ submodule }) => this.repoSubmoduleWatcher.getRepositorySubtree(submodule.path).length > 1)) {
                const choice = await vscode.window.showWarningMessage(
                    '检测到子模块包含嵌套子模块。是否同时递归撤销子模块的子模块修改？',
                    { modal: true },
                    '递归撤销',
                    '仅撤销直接子模块',
                );
                if (!choice) { return; }
                recurseNestedSubmodules = choice === '递归撤销';
            }
            for (const { filePath, submodule } of gitlinkSubmodules) {
                gitlinkPaths.add(filePath);
                const affectedRepositories = recurseNestedSubmodules
                    ? this.repoSubmoduleWatcher.getRepositorySubtree(submodule.path)
                    : [submodule];
                affectedRepositories.forEach(repository => affectedSubmoduleRepositoryPaths.add(repository.path));
            }
        }
        this.workingTreeActionQueue.push({
            action,
            section,
            paths: discardSelection.paths,
            untrackedPaths: untrackedPathSet,
            discardUntrackedToTrash: discardSelection.discardUntrackedToTrash,
            rootUri,
            gitlinkPaths,
            affectedSubmoduleRepositoryPaths: [...affectedSubmoduleRepositoryPaths],
        });
        void this.processWorkingTreeActionQueue();
    }

    private async runWorkingTreeAction(
        action: unknown,
        section: unknown,
        filePath?: unknown,
        repositoryPath?: string,
        selectedPaths?: unknown,
    ): Promise<void> {
        if ((action !== 'stage' && action !== 'unstage' && action !== 'discard')
            || (section !== 'staged' && section !== 'unstaged')
            || (filePath !== undefined && typeof filePath !== 'string')
            || (selectedPaths !== undefined
                && (!Array.isArray(selectedPaths) || selectedPaths.some(path => typeof path !== 'string')))) { return; }
        // Changed Files 区不带 repositoryPath, 用虚拟提交仓库; Commit 卡片显式指定其仓库。
        const targetRepositoryPath = repositoryPath ?? this.commitController.uncommittedRepositoryPath;
        if (!targetRepositoryPath) { return; }
        const rootUri = this.getRepoRootUri(targetRepositoryPath);
        if (!rootUri) { return; }
        // 当前选中仓库用共用的 Store 清单; 其余 Commit 卡片仓库向 watcher 取各自清单。
        const useStore = targetRepositoryPath === this.commitController.uncommittedRepositoryPath;
        const branch = this.branches.find(b => b.kind === 'current' && b.repoOption.path === targetRepositoryPath);
        const changes = useStore
            ? { staged: store.getState().stagedFiles, changes: store.getState().unstagedFiles }
            : branch?.kind === 'current'
                ? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch).catch(() => ({ staged: [], changes: [] }))
                : { staged: [], changes: [] };
        const unstagedFiles = changes.changes;
        const sectionFiles = section === 'staged' ? changes.staged : unstagedFiles;
        const availablePaths = new Set(sectionFiles.map(file => file.path));
        const paths = Array.isArray(selectedPaths)
            ? [...new Set(selectedPaths.filter((path): path is string => availablePaths.has(path)))]
            : typeof filePath === 'string'
                ? [filePath]
                : sectionFiles.map(file => file.path);
        if (paths.length === 0) { return; }
        const untrackedPaths = new Set(unstagedFiles.filter(file => file.isUntracked).map(file => file.path));
        const gitlinkPaths = new Set<string>();
        const affectedSubmoduleRepositoryPaths = new Set<string>();
        if (action === 'discard') {
            for (const filePath of paths) {
                const submodule = this.repoSubmoduleWatcher.findSubmoduleRepository(targetRepositoryPath, filePath);
                if (submodule) {
                    gitlinkPaths.add(filePath);
                    this.repoSubmoduleWatcher.getRepositorySubtree(submodule.path)
                        .forEach(repository => affectedSubmoduleRepositoryPaths.add(repository.path));
                }
            }
        }
        const discardSelection = action === 'discard'
            ? await this.confirmDiscardWorkingTreeChanges(paths, untrackedPaths)
            : { paths: [...paths], discardUntrackedToTrash: false };
        if (!discardSelection) { return; }
        this.workingTreeActionQueue.push({
            action,
            section,
            paths: discardSelection.paths,
            untrackedPaths,
            discardUntrackedToTrash: discardSelection.discardUntrackedToTrash,
            rootUri,
            gitlinkPaths,
            affectedSubmoduleRepositoryPaths: [...affectedSubmoduleRepositoryPaths],
        });
        void this.processWorkingTreeActionQueue();
    }

    private async confirmDiscardWorkingTreeChanges(
        paths: readonly string[],
        untrackedPaths: ReadonlySet<string>,
    ): Promise<{ paths: string[]; discardUntrackedToTrash: boolean } | undefined> {
        const tracked = paths.filter(filePath => !untrackedPaths.has(filePath));
        const untracked = paths.filter(filePath => untrackedPaths.has(filePath));
        if (untracked.length === 0) {
            const files = store.getState().unstagedFiles.filter(file => tracked.includes(file.path));
            const allDeleted = files.every(file => file.status === 'D');
            const message = allDeleted
                ? tracked.length === 1
                    ? `是否确实要还原“${path.basename(tracked[0])}”?`
                    : `是否确定要还原全部 ${tracked.length} 个文件?`
                : tracked.length === 1
                    ? `是否确实要放弃“${path.basename(tracked[0])}”中的更改?`
                    : `是否确实要放弃 ${tracked.length} 个文件中的全部更改?\n\n此操作不可撤消!\n如果继续操作，你当前的工作集将永久丢失。`;
            const primaryAction = allDeleted
                ? tracked.length === 1 ? '还原文件' : `还原所有 ${tracked.length} 文件`
                : tracked.length === 1 ? '放弃文件' : `放弃所有 ${tracked.length} 个文件`;
            const choice = await vscode.window.showWarningMessage(message, { modal: true }, primaryAction);
            return choice === primaryAction
                ? { paths: [...tracked], discardUntrackedToTrash: false }
                : undefined;
        }

        const discardToTrash = vscode.workspace.getConfiguration('vscode-gitk').get<boolean>('discardUntrackedChangesToTrash', true)
            && !vscode.env.remoteName
            && !(process.platform === 'linux' && !!process.env.SNAP);
        const warning = discardToTrash
            ? ''
            : untracked.length === 1
                ? '\n\n此操作不可撤消!\n如果继续操作，此文件将永久丢失。'
                : '\n\n此操作不可撤消!\n如果继续操作，这些文件将永久丢失。';
        const untrackedMessage = untracked.length === 1
            ? `是否确实要删除以下未跟踪的文件： '${path.basename(untracked[0])}'？${warning}`
            : `是否确实要删除 ${untracked.length} 个未跟踪的文件? ${warning}`;
        const detail = discardToTrash
            ? untracked.length === 1 ? '您可以从回收站还原此文件。' : '您可以从回收站还原这些文件。'
            : '';
        if (tracked.length === 0) {
            const primaryAction = discardToTrash
                ? '移动到回收站'
                : untracked.length === 1 ? '删除文件' : `删除所有 ${untracked.length} 个文件`;
            const choice = await vscode.window.showWarningMessage(
                untrackedMessage,
                { detail, modal: true },
                primaryAction,
            );
            return choice === primaryAction
                ? { paths: [...untracked], discardUntrackedToTrash: discardToTrash }
                : undefined;
        }

        const trackedMessage = tracked.length === 1
            ? `\n\n是否确实要放弃“${path.basename(tracked[0])}”中的更改?`
            : `\n\n是否确实要放弃 ${tracked.length} 文件中的所有更改？`;
        const trackedAction = tracked.length === 1
            ? '放弃 1 个已跟踪的文件'
            : `放弃所有 ${tracked.length} 个跟踪的文件`;
        const allAction = `放弃所有 ${paths.length} 个文件`;
        const choice = await vscode.window.showWarningMessage(
            `${untrackedMessage} ${detail}${trackedMessage}\n\n此操作不可撤消!\n如果继续操作，你当前的工作集将永久丢失。`,
            { modal: true },
            trackedAction,
            allAction,
        );
        if (choice === trackedAction) {
            return { paths: tracked, discardUntrackedToTrash: false };
        }
        return choice === allAction
            ? { paths: [...paths], discardUntrackedToTrash: discardToTrash }
            : undefined;
    }

    private async getCurrentlyTrackedPaths(rootUri: vscode.Uri, paths: readonly string[]): Promise<string[]> {
        if (paths.length === 0) { return []; }
        const output = await runGitReadCommand(rootUri, ['ls-files', '--cached', '-z', '--', ...paths]);
        return output.split('\0').filter(Boolean);
    }

    private async processWorkingTreeActionQueue(): Promise<void> {
        if (this.processingWorkingTreeActions) { return; }
        this.processingWorkingTreeActions = true;
        let failed = false;
        try {
            do {
                while (this.workingTreeActionQueue.length > 0) {
                    const operation = this.workingTreeActionQueue.shift()!;
                    const currentBranches = this.uncommittedFilesWatcher.listCurrentHeadBranches();
                    const mutationBranches = [operation.rootUri.toString(), ...operation.affectedSubmoduleRepositoryPaths]
                        .flatMap(repositoryPath => currentBranches.filter(branch => branch.repoOption.path === repositoryPath));
                    mutationBranches.forEach(branch => this.uncommittedFilesWatcher.beginWorkingTreeMutation(branch));
                    let mutationEnded = false;
                    const endMutation = async (progress?: vscode.Progress<{ message?: string }>): Promise<void> => {
                        const rootRepositoryPath = operation.rootUri.toString();
                        this.workingTreeUiMutations.add(rootRepositoryPath);
                        this.deferredWorkingTreeChanges.delete(rootRepositoryPath);
                        await Promise.all(mutationBranches.map(branch => {
                            const isRootRepository = branch.repoOption.path === rootRepositoryPath;
                            return this.uncommittedFilesWatcher.endWorkingTreeMutation(
                                branch,
                                isRootRepository ? operation.paths : [],
                                !isRootRepository,
                            );
                        }));
                        mutationEnded = true;
                        const deferred = this.deferredWorkingTreeChanges.get(rootRepositoryPath);
                        this.deferredWorkingTreeChanges.delete(rootRepositoryPath);
                        this.workingTreeUiMutations.delete(rootRepositoryPath);
                        if (deferred) {
                            progress?.report({ message: '正在刷新变更文件和差异视图...' });
                            await this.applyWorkingTreeChanges(deferred.changes, deferred.affectedPaths);
                        }
                    };
                    try {
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: operation.action === 'stage'
                                ? '添加文件'
                                : operation.action === 'unstage' ? '取消暂存' : '还原更改',
                            cancellable: false,
                        }, async progress => {
                            const total = operation.paths.length;
                            for (let index = 0; index < total; index++) {
                                const filePath = operation.paths[index];
                                const actionMessage = operation.action === 'discard'
                                    ? '还原文件'
                                    : operation.action === 'stage'
                                        ? (operation.untrackedPaths.has(filePath) ? '添加文件' : '更新文件')
                                        : '取消暂存文件';
                                progress.report({
                                    message: `${index + 1}/${total} ${actionMessage}：${filePath}`,
                                });
                            }
                            if (operation.action === 'discard') {
                                const targetCommitByRepository = new Map<string, string>();
                                const affectedRepositories = operation.affectedSubmoduleRepositoryPaths
                                    .map(repositoryPath => ({
                                        repositoryPath,
                                        ancestry: this.repoSubmoduleWatcher.getRepositoryAncestry(repositoryPath),
                                    }))
                                    .sort((left, right) => left.ancestry.length - right.ancestry.length);
                                for (const { repositoryPath, ancestry } of affectedRepositories) {
                                    const parent = ancestry.at(-2);
                                    if (!parent) { continue; }
                                    const childUri = vscode.Uri.parse(repositoryPath);
                                    const parentUri = vscode.Uri.parse(parent.path);
                                    const gitlinkPath = path.relative(parentUri.fsPath, childUri.fsPath).split(path.sep).join('/');
                                    const targetCommit = (await runGitReadCommand(parentUri, ['rev-parse', `:${gitlinkPath}`])).trim();
                                    if (targetCommit) { targetCommitByRepository.set(repositoryPath, targetCommit); }
                                }
                                // 状态快照可能在确认弹窗期间过期; 以当前 index 的实际跟踪状态为准,
                                // 避免把后来变成未跟踪的文件传给 `git restore`。
                                const currentlyTrackedPaths = new Set(await this.getCurrentlyTrackedPaths(operation.rootUri, operation.paths));
                                const trackedPaths = operation.paths.filter(filePath =>
                                    currentlyTrackedPaths.has(filePath) && !operation.untrackedPaths.has(filePath));
                                for (const filePath of operation.paths) {
                                    if (operation.untrackedPaths.has(filePath)) {
                                        await vscode.workspace.fs.delete(
                                            vscode.Uri.joinPath(operation.rootUri, filePath),
                                            { recursive: true, useTrash: operation.discardUntrackedToTrash },
                                        );
                                    }
                                }
                                if (trackedPaths.length > 0) {
                                    await runGitCommand(operation.rootUri, ['restore', '--worktree', '--', ...trackedPaths]);
                                }
                                // 子模块撤销范围已由弹窗确定；逐仓库恢复并回到父仓库 gitlink 指定的提交。
                                for (const repositoryPath of operation.affectedSubmoduleRepositoryPaths) {
                                    const repositoryUri = vscode.Uri.parse(repositoryPath);
                                    await runGitCommand(repositoryUri, ['restore', '--staged', '--worktree', '--', '.']);
                                    const targetCommit = targetCommitByRepository.get(repositoryPath);
                                    if (targetCommit) { await runGitCommand(repositoryUri, ['checkout', '--detach', targetCommit]); }
                                }
                            } else if (operation.action === 'stage') {
                                await runGitCommand(operation.rootUri, ['add', '--', ...operation.paths]);
                            } else {
                                await runGitCommand(operation.rootUri, ['restore', '--staged', '--', ...operation.paths]);
                            }
                            progress.report({ message: '正在同步 Git 工作区状态...' });
                            await endMutation(progress);
                        });
                    } finally {
                        if (!mutationEnded) {
                            await Promise.all(mutationBranches.map(branch => {
                                const isRootRepository = branch.repoOption.path === operation.rootUri.toString();
                                return this.uncommittedFilesWatcher.endWorkingTreeMutation(
                                    branch,
                                    isRootRepository ? operation.paths : [],
                                    !isRootRepository,
                                );
                            }));
                        }
                    }
                }
            } while (this.workingTreeActionQueue.length > 0);
        } catch (error) {
            failed = true;
            void vscode.window.showErrorMessage(`Git 操作失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.processingWorkingTreeActions = false;
            if (failed) { this.commitController.requestUncommittedPresenceCheck(); }
        }
    }

    private async readGitlinkCommitSubjects(rootUri: vscode.Uri, files: CommitFile[]): Promise<void> {
        const gitlinkFiles = files.filter(file => file.isGitlink);
        await Promise.all(gitlinkFiles.map(async file => {
            const submodulePath = path.resolve(rootUri.fsPath, file.path);
            const submoduleUri = vscode.Uri.file(submodulePath);
            file.gitlinkScanPending = false;
            const isRealObjectId = (hash: string | undefined): hash is string => Boolean(hash) && !/^0+$/.test(hash);
            // `git diff` 的工作区端 gitlink OID 是零占位；真实新端只能由子模块工作区 HEAD 提供。
            if (file.workingTreeKind === 'unstaged' && !isRealObjectId(file.newObjectId)) {
                file.newObjectId = (await runGitReadCommand(submoduleUri, ['rev-parse', '--verify', 'HEAD'])).trim();
            }
            const hashes = [file.oldObjectId, file.newObjectId].filter(isRealObjectId);            if (hashes.length === 0) { return; }
            try {
                const output = await runGitReadCommand(submoduleUri, ['show', '-s', '--format=%H%x1f%h%x1f%B%x1e', ...hashes]);
                const commits = new Map<string, GitlinkCommit>();
                for (const record of output.split('\x1e')) {
                    const [hash, shortHash, message] = record.split('\x1f');
                    const normalizedMessage = message?.trim();
                    const subject = normalizedMessage?.split(/\r?\n/).find(line => line.trim().length > 0)?.trim();
                    if (hash && shortHash) { commits.set(hash, { hash, shortHash, subject, message: normalizedMessage || undefined }); }
                }
                file.oldGitlinkCommit = file.oldObjectId ? commits.get(file.oldObjectId) : undefined;
                file.newGitlinkCommit = file.newObjectId ? commits.get(file.newObjectId) : undefined;
                if (file.status !== 'A' && file.status !== 'D'
                    && isRealObjectId(file.oldObjectId) && isRealObjectId(file.newObjectId)) {
                    const rangeOutput = await runGitReadCommand(submoduleUri, [
                        'log', '--format=%H%x1f%h%x1f%B%x1e', `${file.oldObjectId}..${file.newObjectId}`,
                    ]);
                    const rangeCommits = rangeOutput.split('\x1e').flatMap(record => {
                        const [hash, shortHash, message] = record.split('\x1f');
                        const normalizedMessage = message?.trim();
                        const subject = normalizedMessage?.split(/\r?\n/).find(line => line.trim().length > 0)?.trim();
                        return hash && shortHash ? [{ hash, shortHash, subject, message: normalizedMessage || undefined }] : [];
                    });
                    file.gitlinkRangeCommits = [
                        file.oldGitlinkCommit,
                        ...rangeCommits,
                    ].filter((commit): commit is GitlinkCommit => Boolean(commit));
                }
            } catch {
                // SHA 仍由父仓库 gitlink 保存；子模块本地缺少对象或两端非线性时仅不显示范围消息。
            }
        }));
    }

    private async refreshGitlinkDiffs(
        rootUri: vscode.Uri,
        files: readonly CommitFile[],
        generation: number,
        workingTreeDiffCacheKey?: string,
    ): Promise<void> {
        const gitlinkFiles = files.filter(file => file.isGitlink);
        if (gitlinkFiles.length === 0) { return; }
        await this.readGitlinkCommitSubjects(rootUri, gitlinkFiles as CommitFile[]);
        if (generation !== this.commitFilesGeneration
            || this.currentRepositoryPath !== rootUri.toString()
            || !this.files.some(file => file.isGitlink)) { return; }
        const currentDiffs = store.getState().files.filter((file): file is DiffPayload => 'original' in file && 'modified' in file);
        const updated = this.diffReader.updateGitlinkPayloads(currentDiffs, gitlinkFiles);
        if (workingTreeDiffCacheKey) { this.workingTreeDiffCache.set(workingTreeDiffCacheKey, updated); }
        store.setState({
            files: updated,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: updated.length, total: updated.length },
        });
    }

    private async refreshPendingGitlinkDiff(): Promise<void> {
        if (!this.currentHash || !this.selectedRepositoryPath) { return; }
        const hasPending = store.getState().files.some(file => file.isGitlink && file.gitlinkScanPending);
        if (!hasPending) { return; }
        if (isWorkingTreeHash(this.currentHash)) {
            await this.selectWorkingTreeChanges(undefined, false);
            return;
        }
        await this.selectCommit(this.currentHash, this.selectedRepositoryPath);
    }

    private async setCommitFiles(
        hash: string,
        repositoryPath: string | undefined,
        generation: number,
        signal?: AbortSignal,
        revealDiff = false,
    ): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) {
            if (generation === this.commitFilesGeneration) {
                store.setState({
                    filesLoading: false,
                    diffLoading: false,
                    diffError: '无法确定当前提交所属的 Git 仓库。',
                });
            }
            return;
        }
        const publishDiffProgress = (current: number, total: number): void => {
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            store.setState({ diffProgress: { completed: current, total } });
            this.view?.webview.postMessage({
                type: 'filesLoadingProgress',
                hash, repositoryPath, current, total,
                message: '正在加载变更文件...',
            });
        };
        const reportProgress = (current: number, total: number): void => {
            publishDiffProgress(current, total);
        };
        try {
            // 文件清单与 Diff 正文先在局部完成，Store.files 只接收完整 DiffPayload[]。
            const files = await getCommitFiles(rootUri, hash, signal, reportProgress);
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            store.setState({ diffProgress: { completed: 0, total: files.length } });
            const diffs = files.length > 0
                ? await this.diffReader.readDiffs(rootUri, hash, files, 'commit', 0, (completed, total) => {
                    if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
                    store.setState({ diffProgress: { completed, total } });
                })
                : [];
            if (signal?.aborted
                || generation !== this.commitFilesGeneration
                || this.currentHash !== hash
                || this.currentRepositoryPath !== repositoryPath) { return; }
            const selectedPath = diffs[0]?.diffKey || diffs[0]?.path;
            this.pendingFilesRevealGeneration = diffs.length > 0 ? generation : undefined;
            store.setState({
                files: diffs,
                filesLoading: diffs.length > 0,
                diffLoading: false,
                diffError: undefined,
                diffProgress: { completed: diffs.length, total: diffs.length },
                selectedPath,
            });
            void this.refreshGitlinkDiffs(rootUri, files, generation);
            if (diffs.length === 0) {
                return;
            }
            if (revealDiff && this.canShowMultiDiff() && this.view?.visible) {
                this.openDiff(selectedPath);
            } else {
                this.pendingFilesRevealGeneration = undefined;
                this.filesLoading = false;
            }
        } catch (error: any) {
            if (!this.isAbortError(error) && generation === this.commitFilesGeneration) {
                this.view?.webview.postMessage({ type: 'filesError', hash, repositoryPath, message: error instanceof Error ? error.message : String(error) });
                this.pendingFilesRevealGeneration = undefined;
                store.batch(() => {
                    this.filesLoading = false;
                    store.setState({
                        diffLoading: false,
                        diffError: error instanceof Error ? error.message : String(error),
                    });
                });
            }
        }
    }

    // 仅当前提交的 Diff 面板完成首屏渲染后，才放行 Changed Files 列表。
    private handleDiffRendered(identity?: string): void {
        if (this.pendingFilesRevealGeneration === undefined) { return; }
        const currentIdentity = `${this.currentRepositoryPath ?? ''}\u0000${this.currentHash ?? ''}`;
        if (identity !== undefined && identity !== currentIdentity) { return; }
        if (this.pendingFilesRevealGeneration !== this.commitFilesGeneration) {
            this.pendingFilesRevealGeneration = undefined;
            return;
        }
        this.pendingFilesRevealGeneration = undefined;
        this.filesLoading = false;
    }

    private resolveSelectedChangedFile(preferredPath?: string): string | undefined {
        const selectedPath = preferredPath ?? this.selectedPath;
        const resolvedPath = selectedPath && this.files.some(file => (file.diffKey || file.path) === selectedPath)
            ? selectedPath
            : (this.files[0]?.diffKey || this.files[0]?.path);
        this.selectedPath = resolvedPath;
        return resolvedPath;
    }

    // 面板已是活动标签时只做轻量定位; 未激活/未创建则由 openDiff 先激活标签再定位。
    private selectChangedFile(filePath: string): void {
        if (!this.canShowMultiDiff() || !this.view?.visible) { return; }
        if (this.multiDiffPanel.revealFile(filePath)) { return; }
        this.openDiff(filePath);
    }

    navigateMultiDiffChange(direction: -1 | 1): void {
        this.multiDiffPanel.navigateChange(direction);
    }

    setMultiDiffRenderSideBySide(renderSideBySide: boolean): void {
        this.multiDiffPanel.setRenderSideBySide(renderSideBySide);
    }

    private openDiff(filePath?: string): void {
        if (!this.view?.visible) {
            this.multiDiffPanel.hide();
            return;
        }
        if (!this.currentHash) {
            this.multiDiffPanel.cancelPending();
            return;
        }
        if (!this.getRepoRootUri()) { return; }
        // 完整 Diff 数据已原子写入 Store，此处只显示面板并定位文件。
        this.multiDiffPanel.show(this.currentHash, this.commitController.selectedCommit?.message ?? '', filePath);
    }

    // 工作区 Diff 右侧编辑后回写文件。
    private async saveWorkspaceFile(filePath: string, content: string): Promise<void> {
        // 只有工作区文件(unstaged/untracked)可回写; staged 行右侧是 index 内容, 回写工作区会篡改语义。
        // filePath 是裸路径(不带 staged:/unstaged: 前缀), 合并展示后同一路径可能同时存在于两个分组,
        //   必须按 workingTreeKind 精确区分, 不能只取首个命中。
        if (this.currentChangeSet !== 'uncommitted') { return; }
        const isStagedOnly = this.files.some(file => file.path === filePath && file.workingTreeKind === 'staged')
            && !this.files.some(file => file.path === filePath && file.workingTreeKind !== 'staged');
        if (isStagedOnly) { return; }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        const fileUri = vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
        try {
            // 保留磁盘原有行尾: Monaco 传回的是 LF, 若原文件是 CRLF 直接写会让整个文件变成全量差异。
            const existing = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
            const useCrlf = /\r\n/.test(existing);
            const normalized = normalizeEol(content);
            const output = useCrlf ? normalized.replace(/\n/g, '\r\n') : normalized;
            if (output === existing) { return; }
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(output, 'utf8'));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`无法保存文件 ${filePath}: ${message}`);
        }
    }

    // 打开 Diff 对应侧的工作区文件。Ctrl/Cmd + 左键会校验该侧内容后再定位。
    private async openWorkspaceFileAtLine(
        filePath: string,
        line?: number,
        column?: number,
        side: 'original' | 'modified' = 'modified',
    ): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        const fileUri = vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            let selection: vscode.Range | undefined;
            if (typeof line === 'number' && line > 0) {
                const expected = this.files.find(file => file.path === filePath)
                    ?? this.files.find(file => file.oldPath === filePath);
                const expectedContent = expected && 'modified' in expected
                    ? side === 'original' ? expected.original : expected.modified
                    : undefined;
                // git cat-file 读的是对象库原始内容(LF), 工作区在 core.autocrlf=true 下是 CRLF,
                // 直接全等比较会把所有文本文件都误判为已修改, 故先归一化行尾再比对。
                if (side === 'modified'
                    && typeof expectedContent === 'string'
                    && normalizeEol(document.getText()) !== normalizeEol(expectedContent)) {
                    void vscode.window.showWarningMessage(`${filePath} 与当前提交的内容已不一致（文件已被修改），无法定位到对应行。`);
                    return;
                }
                const position = document.validatePosition(new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1)));
                selection = new vscode.Range(position, position);
            }
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Active,
                selection,
                preserveFocus: false,
                preview: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`无法打开文件 ${filePath}: ${message}`);
        }
    }

    private syncFileHighlightFromDiffPanel(filePath: string, generation: number): void {
        const state = store.getState();
        if (generation !== state.diffGeneration || state.selectedPath === filePath || !this.files.some(file => (file.diffKey || file.path) === filePath)) { return; }
        this.selectedPath = filePath;
    }

    // 生成 webview HTML (div flex 布局, 替代 table)
    private getHtml(): string {
        const codiconCssUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons', 'codicon.css'),
        );
        return renderGitkWebviewHtml(String(codiconCssUri));
    }
}