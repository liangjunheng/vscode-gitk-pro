import * as path from 'path';
import * as vscode from 'vscode';
import { type ChangeSetMode, type ChangedFile, type GitBranchOption, CommitFile, CommitMetadata, DiffPayload, type GitkIntent, type GitRepositoryOption, WorkingTreeChanges } from '../types';
import { getCommitFiles, getGitRepositoryState, runGitCommand, runGitReadCommand, readCommitHistoryMessages, readCurrentCommitMessage } from '../git/gitLogProvider';
import { MultiDiffPanel } from './multiDiffPanel';
import { CommitPanel, type CommitPanelSnapshot, type CommitCard } from './commitPanel';
import { CommitPanelViewTitleController } from './commitPanelViewTitleController';
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
    private repositoryStateDebounceTimer?: ReturnType<typeof setTimeout>;
    private lastLoadingProgress?: { phase: string; message: string; current: number; total: number };
    private repositoryStateSignature?: string;
    private storeUnsubscribe?: () => void;
    private pushStatePending = false;
    private gitWatchDisposables: vscode.Disposable[] = [];
    private readonly multiDiffPanel: MultiDiffPanel;
    private readonly commitPanel: CommitPanel;
    private readonly commitPanelViewTitleController: CommitPanelViewTitleController;
    // 每仓库独立的 amend / committing 状态 (多卡片各自提交)。
    private readonly commitAmendByRepo = new Map<string, boolean>();
    private readonly commitMessageBeforeAmendByRepo = new Map<string, string>();
    private readonly commitCommittingByRepo = new Set<string>();
    private readonly diffReader: DiffReader;
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
    private selectedRepoDisplaySnapshot?: { label: string; path: string; hasSubmodules: boolean };
    private selectedBranchDisplaySnapshot: { label: string; title: string; names: string[] } = {
        label: '未选择分支',
        title: '未选择分支',
        names: [],
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
    }> = [];
    private processingWorkingTreeActions = false;
    private pendingWorkingTreeDiffPaths?: ReadonlySet<string>;

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
        const commitListLoadingMessage = commitListLoading ? '正在加载提交历史' : undefined;
        // HEAD 在已选分支中时始终显示虚拟提交，轻量 Presence 只控制是否置灰。
        const workingTree = this.commitController.workingTreeChanges;
        const workingTreeRepositoryPath = this.commitController.uncommittedRepositoryPath;
        const workingTreeRows = workingTreeRepositoryPath ? [{
            hash: 'uncommitted' as const,
            label: 'Uncommitted Changes',
            repositoryPath: workingTreeRepositoryPath,
            enabled: this.commitController.hasUncommittedChanges,
        }] : [];
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
            kind: selectedCommitMetadata.hash === 'uncommitted' ? 'changes' : 'commit',
        } : null;
        this.view.webview.postMessage({
            type: 'stateUpdate',
            state: {
                commits,
                workingTreeRows,
                uncommittedRepositoryCount: s.commitRepositories.filter(repository =>
                    repository.staged.length > 0 || repository.unstaged.length > 0).length,
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
                commitEditorLoading: s.commitEditorLoading,
                diffLoading: s.diffLoading,
                diffProgress: s.diffProgress,
                filesMode: s.displayMode,
                selectedPath: s.selectedPath,
                selectedCommit,
                isLoading: commitListLoading,
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
        // 订阅顺序是有意设计：仓库显示必须先于分支/提交刷新，避免下游监听器的同步前置逻辑阻塞 UI 更新。
        this.selectedRepoSubscription = this.repoController.onSelectedRepoListChanged(selected => this.onSelectedRepoListChanged(selected));
        this.reposLoadingSubscription = this.repoController.onReposLoadingChanged(loading => {
            this.reposLoadingSnapshot = loading;
            this.view?.webview.postMessage({ type: 'repoLoadingChanged', loading });
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
            () => this.handleDiffRendered(),
            (path, line, column, side) => void this.openWorkspaceFileAtLine(path, line, column, side),
            (path, content) => void this.saveWorkspaceFile(path, content),
            (action, section, path) => void this.runWorkingTreeAction(action, section, path),
        );
        this.commitPanel = new CommitPanel({
            onCommit: (repositoryPath, message, amend) => void this.runCommit(repositoryPath, message, amend),
            onToggleDisplayMode: () => this.dispatchIntent({ type: 'toggleFilesMode' }),
            onToggleAmend: (repositoryPath, message) => void this.toggleCommitAmend(repositoryPath, message),
            onHistory: repositoryPath => void this.pickCommitHistoryMessage(repositoryPath),
            onFocusRepository: repositoryPath => this.commitPanel.focus(repositoryPath),
            onSelectFile: (repositoryPath, section, filePath) =>
                void this.openCommitPanelWorkingTreeDiff(repositoryPath, section, filePath),
            onWorkingTreeAction: (repositoryPath, action, section, paths, untrackedPaths) =>
                void this.runCommitPanelWorkingTreeAction(repositoryPath, action, section, paths, untrackedPaths),
            onClose: () => this.commitPanel.hide(),
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
                this.view?.webview.postMessage({ type: 'totalRepoListChanged', repositories });
                this.onSelectedRepoListChanged(this.repoController.selectedRepoList);
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
            // 状态事件维护所有仓库的未提交卡片；内容事件只刷新当前虚拟提交的对应 Diff。
            this.uncommittedFilesWatcher.onEachHeadBranchUncommittedFileChanged(event => {
                this.onRepositoryUncommittedFilesChanged(event.branch, event.changes);
            }),
            this.uncommittedFilesWatcher.onEachHeadBranchUncommittedFileContentChanged(event => {
                this.onWorkingTreeFileContentChanged(event.branch, event.affectedPaths);
            }),
            this.commitController.onCommitsLoadingChanged(loading => {
                this.setLoading(loading, loading ? '正在加载历史提交列表...' : undefined);
                if (loading) { this.postLoadingProgress('commit', '正在加载历史提交列表...', 0, 0); }
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

    async selectCommit(hash: string, repositoryPath?: string): Promise<void> {
        const generation = ++this.commitFilesGeneration;
        this.pendingFilesRevealGeneration = undefined;
        // 先废弃在途请求的数据: 推进各 generation 使回程结果被丢弃; abort 只做通知不阻塞。
        this.commitFilesAbortController?.abort();
        this.diffReader.stop();
        this.multiDiffPanel.cancelPending();
        if (generation !== this.commitFilesGeneration) { return; }
        const abortController = new AbortController();
        this.commitFilesAbortController = abortController;
        try {
            await this.setCommitFiles(hash, repositoryPath, generation, abortController.signal);
        } catch (error: any) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.commitFilesAbortController === abortController) {
                this.commitFilesAbortController = undefined;
            }
            this.updateViewVisible();
        }
    }

    private async selectWorkingTreeChanges(
        changes?: { staged: ChangedFile[]; changes: ChangedFile[] },
        showLoading = true,
        affectedPaths?: ReadonlySet<string>,
        updateWorkingTreeState = true,
    ): Promise<void> {
        const generation = ++this.commitFilesGeneration;
        const selectedBranch = this.commitController.selectedCommit?.gitBranchOption;
        if (!selectedBranch || this.commitController.selectedCommit?.hash !== 'uncommitted') { return; }
        const workingTreeChanges = changes ?? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(selectedBranch);
        if (generation !== this.commitFilesGeneration
            || this.currentHash !== 'uncommitted'
            || this.currentRepositoryPath !== selectedBranch.repoOption.path) { return; }
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
        const rootUri = vscode.Uri.parse(selectedBranch.repoOption.path);
        const previousDiffs = new Map(this.files
            .filter((file): file is DiffPayload => file instanceof DiffPayload)
            .map(file => [file.diffKey || file.path, file]));
        const isAffected = (file: CommitFile) => affectedPaths?.has(file.path) || (!!file.oldPath && affectedPaths?.has(file.oldPath));
        const filesToRead = files.filter(file => {
            const previous = previousDiffs.get(file.diffKey || file.path);
            return !previous || isAffected(file) || !file.equals(previous);
        });
        this.diffReader.stop();
        store.setState({ diffGeneration: store.getState().diffGeneration + 1 });
        const readDiffs = filesToRead.length > 0
            ? await this.diffReader.readDiffs(rootUri, 'uncommitted', filesToRead, 'uncommitted')
            : [];
        const readDiffsByKey = new Map(readDiffs.map(file => [file.diffKey || file.path, file]));
        const diffs = files.map((file, index) => {
            const key = file.diffKey || file.path;
            const payload = readDiffsByKey.get(key) ?? previousDiffs.get(key);
            return new DiffPayload({ ...payload, ...file, index });
        });
        if (generation !== this.commitFilesGeneration
            || this.currentHash !== 'uncommitted'
            || this.currentRepositoryPath !== selectedBranch.repoOption.path) { return; }
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
        if (this.commitPanel.isVisible()) {
            this.commitPanel.update(this.buildCommitSnapshot());
        }
        if (diffs.length === 0) {
            this.multiDiffPanel.hide();
            return;
        }
        if (showLoading && this.canShowMultiDiff() && this.view?.visible) {
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
        console.log('[GitkViewProvider] onSelectedRepoListChanged', performance.now());
        const repository = selected.length === 1 ? selected[0] : undefined;
        this.selectedRepoDisplaySnapshot = repository
            ? { label: repository.label, path: repository.path, hasSubmodules: Boolean(repository.hasSubmodules) }
            : undefined;
        console.log('[GitkViewProvider] selectedRepoDisplayChanged postMessage before', performance.now());
        this.view?.webview.postMessage({
            type: 'selectedRepoDisplayChanged',
            repository: this.selectedRepoDisplaySnapshot,
        });
        console.log('[GitkViewProvider] selectedRepoDisplayChanged postMessage after', performance.now());
        // 选择事件产生后立即同步完整状态，不能等待提交或分支事件。
        this.pushStateToWebview();
    }

    /** 分支选择变化后的唯一下游入口：更新显示快照，提交加载只由 CommitController 事件驱动。 */
    private onSelectedBranchesChanged(branchesMap: ReadonlyMap<GitRepositoryOption, GitBranchOption[]>): void {
        this.selectedBranchesMap = new Map([...branchesMap].map(([repository, branches]) => [repository, [...branches]]));
        this.schedulePushState();
        const branches = [...this.selectedBranchesMap.values()].flat();
        const currentBranch = branches.find(branch => branch.kind === 'current');
        const names = [...new Set(branches.map(branch => branch.name))];
        this.selectedBranchDisplaySnapshot = currentBranch && names.length === 1
            ? { label: currentBranch.label, title: currentBranch.name, names }
            : {
                label: names.length === 0 ? '未选择分支' : names.length === 1 ? branches[0].label : `已选择 ${names.length} 个分支`,
                title: names.length === 0 ? '未选择分支' : names.join(', '),
                names,
            };
        this.view?.webview.postMessage({
            type: 'selectedBranchDisplayChanged',
            display: this.selectedBranchDisplaySnapshot,
        });
        // 当前分支选择产生后立即同步完整状态，不能依赖提交列表事件。
        this.pushStateToWebview();
    }

    /** 提交列表变化后的唯一下游入口：仅推送提交列表状态。 */
    private onSearchedCommitsChanged(): void {
        this.schedulePushState();
    }

    /** 任一仓库未提交变化 (来自 watcher) 时增量更新多仓库 Store, 并刷新 Commit 面板对应卡片。 */
    private onRepositoryUncommittedFilesChanged(branch: GitBranchOption, changes: WorkingTreeChanges): void {
        const repositoryPath = branch.repoOption.path;
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
        this.commitPanelViewTitleController.update(next);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    /** 文件内容变化不改变未提交状态，仅替换当前虚拟提交中受影响路径的 Diff 负载。 */
    private onWorkingTreeFileContentChanged(
        branch: GitBranchOption,
        affectedPaths: readonly string[],
    ): void {
        const selectedCommit = this.commitController.selectedCommit;
        if (selectedCommit?.hash !== 'uncommitted'
            || selectedCommit.gitBranchOption?.repoOption.path !== branch.repoOption.path
            || selectedCommit.gitBranchOption.hash !== branch.hash) { return; }
        void this.refreshWorkingTreeDiffs(branch, affectedPaths);
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
        store.setState({ diffGeneration: store.getState().diffGeneration + 1 });
        const rootUri = vscode.Uri.parse(branch.repoOption.path);
        const refreshed = await this.diffReader.readDiffs(rootUri, 'uncommitted', files, 'uncommitted');
        if (generation !== this.commitFilesGeneration
            || this.currentHash !== 'uncommitted'
            || this.currentRepositoryPath !== branch.repoOption.path
            || this.commitController.selectedCommit?.gitBranchOption?.hash !== branch.hash) { return; }
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
        this.schedulePushState();
        // 显式 Git 操作的 pending 路径与 watcher 事件携带的受影响路径取并集,
        // 后者覆盖"状态与内容同时变化"时被编辑文件需连内容重读的场景。
        const pending = this.pendingWorkingTreeDiffPaths;
        this.pendingWorkingTreeDiffPaths = undefined;
        const affectedPaths = pending || eventAffectedPaths
            ? new Set<string>([...(pending ?? []), ...(eventAffectedPaths ?? [])])
            : undefined;
        const selectedBranch = this.commitController.selectedCommit?.gitBranchOption;
        if (this.currentHash !== 'uncommitted'
            || !selectedBranch
            || selectedBranch.repoOption.path !== this.commitController.uncommittedRepositoryPath) { return; }
        void this.selectWorkingTreeChanges(changes, false, affectedPaths).then(() => this.refreshCommitPanel());
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
        const isVirtual = hash === 'uncommitted';
        store.setState({
            currentHash: hash,
            currentRepositoryPath: repositoryPath,
            currentChangeSet: isVirtual ? 'uncommitted' : 'commit',
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
        if (!commit || !hash) { return; }
        if (isVirtual) {
            void this.selectWorkingTreeChanges();
        } else {
            void this.selectCommit(hash, repositoryPath);
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

    // 统一投递加载进度并记录，供 Webview 后接管时重播。
    private postLoadingProgress(phase: string, message: string, current: number, total: number): void {
        this.lastLoadingProgress = { phase, message, current, total };
        this.loadingMessage = message;
        this.view?.webview.postMessage({ type: 'loadingProgress', phase, message, current, total });
    }

    private republishLoadingProgress(): void {
        const progress = this.lastLoadingProgress;
        if (!progress) { return; }
        this.view?.webview.postMessage({ type: 'loadingProgress', ...progress });
    }

    private updateMultiDiffVisibility(): void {
        if (!this.view?.visible) {
            this.multiDiffPanel.hide();
            // 面板隐藏后不会再有渲染完成信号, 立即放行 Changed Files 列表。
            if (this.pendingFilesRevealGeneration !== undefined) {
                this.pendingFilesRevealGeneration = undefined;
                this.filesLoading = false;
            }
            return;
        }
        if (!this.isLoading && this.currentHash && this.files.length > 0) {
            this.openDiff(this.selectedPath);
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        const viewGeneration = ++this.viewGeneration;
        this.view = view;
        this.updateViewVisible();
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
                // 首次进入时后台数据已就绪，不会触发可见性事件，需主动显示 Diff。
                this.updateMultiDiffVisibility();
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
        const refreshRepositoryState = () => this.queueRepositoryStateRefresh();
        const gitRefsWatcher = vscode.workspace.createFileSystemWatcher('**/.git/refs/**');
        this.gitWatchDisposables.push(
            this.gitWatcherSentinel,
            vscode.workspace.onDidChangeWorkspaceFolders(refreshWorkspaceRepositories),
            gitRefsWatcher,
            gitRefsWatcher.onDidCreate(refreshRepositoryState),
            gitRefsWatcher.onDidChange(refreshRepositoryState),
            gitRefsWatcher.onDidDelete(refreshRepositoryState),
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


    private queueRepositoryStateRefresh(): void {
        if (this.repositoryStateDebounceTimer) {
            clearTimeout(this.repositoryStateDebounceTimer);
        }
        this.repositoryStateDebounceTimer = setTimeout(() => {
            this.repositoryStateDebounceTimer = undefined;
            void this.refreshOnRepositoryStateChanged();
        }, 300);
    }

    // 自身的 git status / diff 会回写 .git/index 的 stat 缓存并触发 watcher。
    // 首次初始化期间一律忽略，其余情况按 HEAD + refs 内容签名判定是否真的变了。
    private async refreshOnRepositoryStateChanged(): Promise<void> {
        // 视图初始化中或首次加载尚未产出提交时，一律不打断当前加载。
        if (this.initializingViewGeneration === this.viewGeneration) { return; }
        if (this.refreshAbortController && this.commits.length === 0) { return; }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) {
            void this.refresh(false);
            return;
        }
        const signature = await this.readRepositoryStateSignature(rootUri);
        if (signature && signature === this.repositoryStateSignature) { return; }
        this.repositoryStateSignature = signature;
        // 工作树、暂存区和 refs 变化不改变仓库集合，禁止重扫子模块。
        void this.refresh(false);
    }

    private async captureRepositoryStateSignature(): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        const signature = await this.readRepositoryStateSignature(rootUri);
        if (signature) { this.repositoryStateSignature = signature; }
    }

    /** 当前仓库根 URI：优先取选中提交所属仓库，回退到已选仓库。 */
    private getRepoRootUri(repositoryPath = this.currentRepositoryPath): vscode.Uri | undefined {
        const target = repositoryPath ?? this.selectedRepositoryPath;
        return target ? vscode.Uri.parse(target) : undefined;
    }

    private async readRepositoryStateSignature(rootUri: vscode.Uri): Promise<string | undefined> {
        try {
            const state = await getGitRepositoryState(rootUri);
            return [state.head, state.branch, state.refs].join('\u0000');
        } catch {
            // 读取失败时不做抑制，交由正常刷新兜底。
            return undefined;
        }
    }

    /**
     * 生命周期刷新入口：只负责仓库扫描与加载态。
     * 分支由 GitBranchesController 接管，提交由 GitCommitController 接管。
     */
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
        // 记录基线，使本轮加载自身写入 .git/index 引发的 watcher 事件不再触发重复刷新。
        void this.captureRepositoryStateSignature();
        this.updateViewVisible();
    }

    /**
     * 手动刷新: 重读当前提交列表和全部仓库当前 HEAD 的未提交变更, 不干扰选择器生命周期。
     * 选中仓库的提交列表与工作区状态由 GitCommitController 负责并吸收异常;
     * 其余 current-head 仓库经 watcher 强制刷新, 结果通过 onEachHeadBranchUncommittedFileChanged 回流多仓库 Store。
     */
    private refreshCurrentViewData(): void {
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
                this.view?.webview.postMessage({ type: 'totalRepoListChanged', repositories: this.totalRepoListSnapshot });
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
            case 'commitAction':
                if (typeof effect.action === 'string' && typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    this.gitActions.runCommitAction(effect.action, effect.hash, effect.repositoryPath);
                }
                break;
            case 'selectCommit':
                if (effect.hash === 'uncommitted') {
                    const branch = this.branchesController.getSelectedCurrentBranch();
                    if (!branch || !this.commitController.uncommittedRepositoryPath) { break; }
                    this.commitController.selectCommit(new CommitMetadata({ hash: effect.hash, gitBranchOption: branch }));
                } else if (typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    const commit = this.findCommit(effect.hash, effect.repositoryPath);
                    if (commit) { this.commitController.selectCommit(commit); }
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
                void this.runWorkingTreeAction(effect.action, effect.section, effect.path);
                break;
            case 'openCommitEditor':
                void this.runOpenCommitEditor(effect.repositoryPath, effect.amend);
                break;
            case 'openCommitPanel':
                this.commitPanel.show(this.buildCommitSnapshot(), this.selectedRepositoryPath);
                break;
            case 'persistFilesDisplayMode':
                void vscode.workspace.getConfiguration('vscode-gitk')
                    .update('changedFilesDisplayMode', effect.displayMode, vscode.ConfigurationTarget.Global);
                break;
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
            const isCurrentWorkingTree = this.currentHash === 'uncommitted'
                && this.currentRepositoryPath === repositoryPath;
            if (!isCurrentWorkingTree) {
                const selectedBranch = await this.selectCommitPanelRepository(branch, abortController.signal);
                if (!selectedBranch || abortController.signal.aborted) { return; }
                const nextGeneration = this.commitFilesGeneration + 1;
                const changed = this.commitController.selectCommit(new CommitMetadata({ hash: 'uncommitted', gitBranchOption: selectedBranch }));
                const selectionIsLoading = this.currentHash === 'uncommitted'
                    && this.currentRepositoryPath === repositoryPath
                    && store.getState().diffLoading;
                if (changed || selectionIsLoading) {
                    const generation = changed ? nextGeneration : this.commitFilesGeneration;
                    const loaded = await this.waitForWorkingTreeSelection(repositoryPath, generation, abortController.signal);
                    if (!loaded || abortController.signal.aborted) { return; }
                }
            }
            if (this.currentHash !== 'uncommitted'
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

    private waitForWorkingTreeSelection(repositoryPath: string, generation: number, signal: AbortSignal): Promise<boolean> {
        return new Promise(resolve => {
            const complete = (): boolean => this.commitFilesGeneration >= generation
                && this.currentHash === 'uncommitted'
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
        const selectedRepositoryPath = this.commitController.uncommittedRepositoryPath;
        const repositories = this.repoController.totalRepoList.map(repository => {
            const repositoryPath = repository.path;
            const branch = currentBranchesByPath.get(repositoryPath);
            const changes = repositoryPath === selectedRepositoryPath
                ? { staged: store.getState().stagedFiles, changes: store.getState().unstagedFiles }
                : branch
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

    /** 从扩展层多仓库 Store 组装卡片; 模板为重开销, 展开时懒加载。 */
    private buildCommitSnapshot(): CommitPanelSnapshot {
        const cards = store.getState().commitRepositories.map(repo => ({
            repositoryPath: repo.repositoryPath,
            repositoryLabel: repo.repositoryLabel,
            repositoryHasSubmodules: Boolean(repo.repository.hasSubmodules),
            repositoryAncestry: repo.repository.ancestry,
            amend: this.commitAmendByRepo.get(repo.repositoryPath) === true,
            stagedFiles: repo.staged.map(file => ({ path: file.path, status: file.status, isUntracked: file.isUntracked })),
            unstagedFiles: repo.unstaged.map(file => ({ path: file.path, status: file.status, isUntracked: file.isUntracked })),
            committing: this.commitCommittingByRepo.has(repo.repositoryPath),
        } satisfies CommitCard));
        return { cards, displayMode: store.getState().displayMode };
    }

    /** 刷新提交面板内容 (add/restore 或工作区变化后): 先同步多仓库 Store 再重建卡片。 */
    private async refreshCommitPanel(): Promise<void> {
        if (!this.commitPanel.isVisible()) { return; }
        this.syncCommitRepositories();
        this.commitPanel.update(this.buildCommitSnapshot());
    }

    private async toggleCommitAmend(repositoryPath: string, message: string): Promise<void> {
        // 由宿主权威状态翻转该仓库的 amend, 不接收 webview 传来的目标值。
        const amend = !(this.commitAmendByRepo.get(repositoryPath) === true);
        if (amend) {
            this.commitMessageBeforeAmendByRepo.set(repositoryPath, message);
        }
        this.commitAmendByRepo.set(repositoryPath, amend);
        await this.refreshCommitPanel();
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const nextMessage = amend
            ? await readCurrentCommitMessage(rootUri)
            : this.commitMessageBeforeAmendByRepo.get(repositoryPath) ?? '';
        this.commitPanel.setMessage(repositoryPath, nextMessage);
        if (!amend) {
            this.commitMessageBeforeAmendByRepo.delete(repositoryPath);
        }
    }

    /** 历史提交信息选择器: 选中后填入指定仓库卡片的信息框。 */
    private async pickCommitHistoryMessage(repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const history = await readCommitHistoryMessages(rootUri);
        const items: (vscode.QuickPickItem & { message: string })[] = history.map(item => ({
            label: item.subject,
            description: item.shortHash,
            message: item.message,
        }));
        if (items.length === 0) {
            void vscode.window.showInformationMessage('没有可用的历史提交信息。');
            return;
        }
        const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择历史提交信息填入' });
        if (picked) { this.commitPanel.setMessage(repositoryPath, picked.message); }
    }

    private async runCommit(repositoryPath: string, message: string, amend: boolean): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri || this.commitCommittingByRepo.has(repositoryPath)) { return; }
        this.commitCommittingByRepo.add(repositoryPath);
        await this.refreshCommitPanel();
        try {
            await commitWithMessage(rootUri, message, amend);
            this.commitCommittingByRepo.delete(repositoryPath);
            this.commitAmendByRepo.delete(repositoryPath);
            // 提交后的 staged/unstaged 状态由 uncommitted watcher 监听 index 与新 HEAD 后发布。
            // 这里仅刷新提交历史，不能立即读取 Commit 面板，否则可能读到旧 HEAD 缓存。
            await this.refresh();
        } catch (error) {
            this.commitCommittingByRepo.delete(repositoryPath);
            await this.refreshCommitPanel();
            void vscode.window.showErrorMessage(`Git Commit 失败：${error instanceof Error ? error.message : String(error)}`);
        }
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
        this.workingTreeActionQueue.push({
            action,
            section,
            paths: discardSelection.paths,
            untrackedPaths: untrackedPathSet,
            discardUntrackedToTrash: discardSelection.discardUntrackedToTrash,
            rootUri,
        });
        void this.processWorkingTreeActionQueue();
    }

    private async runWorkingTreeAction(action: unknown, section: unknown, filePath?: unknown, repositoryPath?: string): Promise<void> {
        if ((action !== 'stage' && action !== 'unstage' && action !== 'discard')
            || (section !== 'staged' && section !== 'unstaged')
            || (filePath !== undefined && typeof filePath !== 'string')) { return; }
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
        const paths = typeof filePath === 'string'
            ? [filePath]
            : (section === 'staged' ? changes.staged : unstagedFiles).map(file => file.path);
        if (paths.length === 0) { return; }
        const untrackedPaths = new Set(unstagedFiles.filter(file => file.isUntracked).map(file => file.path));
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

    private async processWorkingTreeActionQueue(): Promise<void> {
        if (this.processingWorkingTreeActions) { return; }
        this.processingWorkingTreeActions = true;
        let failed = false;
        try {
            do {
                while (this.workingTreeActionQueue.length > 0) {
                    const operation = this.workingTreeActionQueue.shift()!;
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
                            const trackedPaths = operation.paths.filter(filePath => !operation.untrackedPaths.has(filePath));
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
                        } else if (operation.action === 'stage') {
                            await runGitCommand(operation.rootUri, ['add', '--', ...operation.paths]);
                        } else {
                            await runGitCommand(operation.rootUri, ['restore', '--staged', '--', ...operation.paths]);
                        }
                        const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches().find(branch =>
                            branch.repoOption.path === operation.rootUri.toString());
                        if (currentBranch) {
                            this.pendingWorkingTreeDiffPaths = new Set(operation.paths);
                            void this.uncommittedFilesWatcher.refreshUncommittedFilesForPaths(currentBranch, operation.paths);
                        }
                    });
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

    private async setCommitFiles(hash: string, repositoryPath: string | undefined, generation: number, signal?: AbortSignal): Promise<void> {
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
        const reportProgress = (current: number, total: number): void => {
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            this.view?.webview.postMessage({
                type: 'filesLoadingProgress',
                hash, repositoryPath, current, total,
                message: '正在加载变更文件...',
            });
        };
        try {
            // 文件清单与 Diff 正文先在局部完成，Store.files 只接收完整 DiffPayload[]。
            const files = await getCommitFiles(rootUri, hash, signal, reportProgress);
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            const diffs = files.length > 0
                ? await this.diffReader.readDiffs(rootUri, hash, files, 'commit')
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
            if (diffs.length === 0) {
                this.multiDiffPanel.hide();
                return;
            }
            if (this.canShowMultiDiff() && this.view?.visible) {
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

    // 收到 Diff 面板渲染完成信号后放行 Changed Files 列表。
    private handleDiffRendered(): void {
        if (this.pendingFilesRevealGeneration === undefined) { return; }
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
        if (this.currentChangeSet !== 'changes' && this.currentChangeSet !== 'uncommitted') { return; }
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
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gitk</title>
<link rel="stylesheet" href="${codiconCssUri}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: var(--vscode-editor-font-family, sans-serif); font-size: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); display: flex; flex-direction: column; height: 100%; }
  #header { display: flex; align-items: center; gap: 0; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; min-width: 0; }
  #header button { border: none; cursor: pointer; border-radius: 2px; }
  .selector { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .selector-group { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 8px; }
  .repo-group { padding-left: 0; border-right: 1px solid var(--vscode-panel-border); }
  #branchSelector { border-right: 1px solid var(--vscode-panel-border); }
  .search-group { padding-left: 0; border: 0; }
  .selector-prefix { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #header .uncommitted-repo-badge { flex: 0 0 16px; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: var(--vscode-button-background, #007acc); color: #fff; font: inherit; font-size: 9px; font-weight: 600; line-height: 16px; text-align: center; }
  .uncommitted-repo-badge:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
  .uncommitted-repo-badge[hidden] { display: none; }
  .dropdown { position: relative; flex: 0 1 auto; min-width: 0; }
  #repositoryDropdown, #branchDropdown { width: 20ch; }
  .dropdown-current { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
  .dropdown-current:has(.dropdown-spinner) { gap: 2px; }
  .dropdown-label:has(.dropdown-spinner) { display: inline-flex; align-items: center; flex: 1 1 auto; gap: 4px; }
  .dropdown-label .dropdown-spinner { margin-left: auto; margin-right: 0; }
  .dropdown-label .dropdown-spinner[hidden] { display: none; }
  .dropdown-current:hover:not(:disabled), .dropdown.open .dropdown-current { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .dropdown-current:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-current:disabled { cursor: default; opacity: .6; }
  .dropdown-current[data-loading="true"] .dropdown-spinner { display: inline-block; }
  .dropdown-spinner { display: inline-block; width: 10px; height: 10px; flex: 0 0 auto; margin-right: 4px; border: 1.5px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: dropdown-spin .8s linear infinite; vertical-align: -1px; }
  @keyframes dropdown-spin { to { transform: rotate(360deg); } }
  .dropdown-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repository-icon { display: inline-flex; flex: 0 0 auto; width: 16px; height: 16px; margin-right: 4px; vertical-align: -3px; color: var(--vscode-icon-foreground, currentColor); }
  .repository-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .repository-icon.has-submodules { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-icon-foreground, currentColor)); }
  .dropdown-chevron { margin-left: auto; display: inline-flex; align-items: center; color: var(--vscode-descriptionForeground); }
  .dropdown-chevron svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .dropdown.open .dropdown-chevron { transform: rotate(180deg); }
  .dropdown-menu { position: absolute; top: calc(100% + 3px); left: 0; z-index: 20; display: none; flex-direction: column; width: max(100%, 190px); padding: 5px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  .dropdown.open .dropdown-menu { display: flex; }
  .dropdown-filter { width: 100%; height: 25px; flex: 0 0 auto; margin-bottom: 4px; padding: 0 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; font-size: 11px; }
  .dropdown-filter:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-options { min-height: 0; flex: 1 1 auto; overflow-y: auto; }
  .dropdown-progress { position: absolute; top: 0; right: 0; left: 0; z-index: 2; height: 2px; overflow: hidden; background: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  .dropdown-progress::before { content: ''; display: block; width: 35%; height: 100%; background: var(--vscode-progressBar-background); animation: dropdown-progress 1.1s ease-in-out infinite; }
  @keyframes dropdown-progress { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  .dropdown-option, .dropdown-group { width: 100%; min-height: 24px; padding: 4px 7px; overflow: hidden; border: 0; border-radius: 3px; font: inherit; font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-option { color: inherit; background: transparent; cursor: pointer; }
  .dropdown-option:hover, .dropdown-option:focus-visible { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); outline: none; }
  .dropdown-option.selected::before { content: '✓'; display: inline-block; width: 14px; color: var(--vscode-menu-selectionForeground, var(--vscode-textLink-foreground)); }
  #repositoryDropdown .dropdown-option, #branchDropdown .dropdown-option { display: flex; align-items: center; gap: 6px; }
  #repositoryDropdown .dropdown-option.selected::before, #branchDropdown .dropdown-option.selected::before { display: none; }
  #repositoryDropdown .dropdown-option input { display: none; }
  #branchDropdown .dropdown-option input { flex: 0 0 auto; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); }
  .dropdown-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 2px 1px; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
  .dropdown-actions-right { display: flex; align-items: center; gap: 6px; }
  .dropdown-actions button { min-width: 52px; height: 26px; padding: 0 10px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground)); border: 1px solid transparent; border-radius: 6px; cursor: pointer; font: inherit; font-size: 11px; transition: background-color 120ms ease, border-color 120ms ease; }
  .dropdown-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .dropdown-actions button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .dropdown-actions .toggle-all { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; padding: 0 7px; background: transparent; }
  .dropdown-actions .toggle-all:hover, .dropdown-actions .toggle-all:active { background: transparent; }
  .dropdown-actions .toggle-all input { width: 13px; height: 13px; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); pointer-events: none; }
  .dropdown-actions .confirm-selection, .dropdown-actions .cancel-selection { min-width: 35px; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 10px; }
  .dropdown-actions .confirm-selection { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .dropdown-actions .confirm-selection:hover { background: var(--vscode-button-hoverBackground); }
  .dropdown-group { padding-bottom: 1px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; cursor: default; }
  .dropdown-empty { padding: 8px 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #toolbarActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .toolbar-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; }
  .toolbar-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .toolbar-icon .codicon { font-size: 16px; line-height: 16px; }
  .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .toolbar-icon.refresh-unchanged { animation: refresh-unchanged 550ms ease-out; }
  @keyframes refresh-unchanged { 0%, 100% { color: var(--vscode-icon-foreground); } 45% { color: var(--vscode-descriptionForeground); } }
  #header .count { opacity: 0.7; font-size: 11px; white-space: nowrap; }
  #workspace { display: grid; grid-template-columns: minmax(180px, 1fr) 5px minmax(180px, 1fr); flex: 1; min-height: 0; }
  #graph { --graph-lane-width: 22px; --main-width: calc(var(--graph-lane-width) + 60ch); --hash-width: max-content; --author-width: max-content; --date-width: max-content; min-width: 0; min-height: 0; overflow: auto; }
  #panelResizeHandle { cursor: col-resize; background: var(--vscode-panel-border); }
  #panelResizeHandle:hover, #panelResizeHandle.resizing { background: var(--vscode-focusBorder); }
  #filesSection { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  #filesHeader { height: 30px; padding: 0 10px; display: flex; align-items: center; flex: 0 0 auto; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-weight: 600; }
  #filesTitle { display: flex; align-items: center; min-width: 0; gap: 6px; white-space: nowrap; }
  #filesCommitHash { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 400; }
  #filesActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  #commitSplitGroup { display: flex; align-items: stretch; margin-right: 4px; border-radius: 5px; overflow: hidden; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #commitSplitGroup[hidden] { display: none; }
  #commitPrimaryBtn { height: 24px; border: 0; border-radius: 0; padding: 0 8px; color: inherit; background: transparent; font: inherit; white-space: nowrap; cursor: pointer; }
  #commitPrimaryBtn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  #commitPrimaryBtn:disabled { cursor: wait; opacity: .7; }
  #commitSplitGroup.loading #commitPrimaryBtn::before { content: ''; display: inline-block; width: 10px; height: 10px; margin-right: 6px; border: 1.5px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: dropdown-spin .8s linear infinite; vertical-align: -1px; }
  #commitPrimaryBtn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #filesActions .action-group { display: flex; align-items: center; gap: 2px; }
  #filesActions .action-group + .action-group:not([hidden])::before { content: ''; display: inline-block; width: 1px; height: 14px; margin: 0 4px; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.3)); }
  #filesHeader [hidden] { display: none !important; }
  #filesHeader .toolbar-icon { width: 24px; height: 24px; border: 1px solid transparent; border-radius: 4px; transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease; }
  #filesHeader .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-toolbar-hoverOutline, transparent); }
  #filesHeader .toolbar-icon:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  #filesHeader .toolbar-icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #filesHeader .toolbar-icon svg { width: 16px; height: 16px; stroke-width: 1.5; }
  #filesList { min-width: 0; min-height: 0; flex: 1 1 auto; overflow-x: auto; overflow-y: auto; }
  #filesList > * { min-width: max-content; }
  #fileContextMenu { position: fixed; z-index: 20; min-width: 168px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  #fileContextMenu[hidden] { display: none; }
  #fileContextMenu button { display: block; width: 100%; border: 0; border-radius: 3px; padding: 5px 8px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; font: inherit; }
  #fileContextMenu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground)); }
  .file-item, .folder-item { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 10px; }
  .file-item { cursor: pointer; }
  .folder-item { cursor: pointer; font-weight: 600; gap: 0; }
  .folder-item .file-path { margin-left: 4px; }
  .file-item:hover, .folder-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #filesList > .working-tree-content { display: inline-grid; grid-template-columns: 1fr; width: max-content; min-width: 100%; }
  .working-tree-section-body { position: relative; width: 100%; min-width: 0; background: var(--working-tree-row-background); }
  .working-tree-section-body::before { content: ''; position: absolute; top: 0; bottom: 0; left: 7px; z-index: 1; width: 1px; pointer-events: none; }
  .working-tree-section[data-section="staged"] .working-tree-section-body::before { background: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .working-tree-section[data-section="unstaged"] .working-tree-section-body::before { background: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .working-tree-section + .working-tree-section { border-top: 1px solid var(--vscode-panel-border); }
  .working-tree-section { --working-tree-header-background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background)); --working-tree-row-background: var(--vscode-editor-background); position: relative; width: 100%; min-width: 0; }
  .working-tree-section-header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; width: 100%; min-width: 0; height: 26px; padding: 0 0 0 10px; box-sizing: border-box; font-weight: 600; background: var(--working-tree-header-background); }
  .working-tree-section-body .file-item { width: max-content; min-width: 100%; padding-left: 15px; padding-right: 0; background: var(--working-tree-row-background); }
  .working-tree-section-body .file-item:hover { --working-tree-row-background: var(--vscode-list-hoverBackground); }
  .working-tree-section-body .file-item.selected { --working-tree-row-background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .working-tree-section-header.disabled { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .working-tree-section-leading { position: sticky; left: 10px; z-index: 2; display: inline-flex; align-items: center; flex: 0 0 auto; min-width: 0; padding-right: 4px; background: var(--working-tree-header-background); }
  .working-tree-section-title { min-width: 0; }
  .working-tree-section-count { margin-left: 5px; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .working-tree-section-actions, .file-actions { position: sticky; right: 0; isolation: isolate; overflow: hidden; display: flex; align-items: center; flex: 0 0 auto; margin-left: auto; gap: 2px; box-sizing: border-box; padding: 1px 0 1px 4px; }
  .working-tree-section-actions { --working-tree-actions-background: var(--working-tree-header-background); --working-tree-actions-base: var(--vscode-editorWidget-background, var(--vscode-editor-background)); z-index: 3; }
  .file-actions { --working-tree-actions-background: var(--working-tree-row-background); --working-tree-actions-base: var(--vscode-editor-background); }
  .working-tree-section-actions::before, .file-actions::before { content: ''; position: absolute; inset: 0; z-index: 0; background: linear-gradient(var(--working-tree-actions-background), var(--working-tree-actions-background)), var(--working-tree-actions-base); }
  .working-tree-action { position: relative; z-index: 1; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; appearance: none; }
  .working-tree-actions-spacer { position: relative; z-index: 1; flex: 0 0 8px; width: 8px; align-self: stretch; }
  .working-tree-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .working-tree-action:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  .working-tree-action:focus { outline: none; }
  .working-tree-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .working-tree-action .codicon { font-size: 16px; }
  .working-tree-section-header.disabled .working-tree-section-actions { display: none; }
  .file-item .file-actions { z-index: 2; align-self: stretch; }
  .file-item .file-path { flex: 1 1 auto; }
  /* 选择器需两级以压过 codicon.css 的 .codicon[class*='codicon-']，否则其 display:inline-block 与 16px/1 行高会让图标顶对齐。 */
  .folder-item .tree-chevron, .folder-item .tree-folder-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 14px; width: 14px; height: 100%; color: var(--vscode-icon-foreground); font-size: 13px; line-height: 1; }
  .working-tree-kind { display: inline-grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; box-sizing: border-box; }
  .working-tree-kind svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .working-tree-kind .kind-accent { fill: currentColor; stroke: none; }
  .working-tree-kind-untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c)); }
  .working-tree-kind-untracked .kind-file { stroke-dasharray: 1.6 1.6; }
  .working-tree-kind-unstaged { color: var(--vscode-foreground); }
  .working-tree-kind-staged { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status { width: 12px; text-align: center; font-weight: 700; }
  .file-status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .file-status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .working-tree-section[data-section="staged"] .file-name { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .working-tree-section[data-section="unstaged"] .file-name { color: var(--vscode-textLink-foreground, #3794ff); }
  .working-tree-section[data-section="unstaged"] .file-item.untracked .file-status,
  .working-tree-section[data-section="unstaged"] .file-item.untracked .file-name { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .file-path { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .file-folder { opacity: 0.55; }
  #filesEmpty { padding: 8px 10px; color: var(--vscode-descriptionForeground); }
  #filesEmpty:has(.files-loading-spinner) { display: flex; align-items: center; gap: 7px; }
  .files-loading-spinner { width: 12px; height: 12px; flex: 0 0 auto; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: files-loading-spin .8s linear infinite; }
  @keyframes files-loading-spin { to { transform: rotate(360deg); } }
  .commit-header, .commit-row { display: grid; grid-template-columns: var(--main-width) var(--author-width) var(--hash-width) var(--date-width); align-items: center; min-width: max-content; }
  .commit-header { position: sticky; top: 0; z-index: 1; height: 30px; margin: 0; padding: 0 10px; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-weight: 600; }
  .commit-row { min-height: 26px; height: auto; box-sizing: border-box; cursor: pointer; align-items: start; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  /* 分支图与描述合并为 col-main 单列: SVG 画泳道(左), 摘要行与描述(右)在同一字段内竖排。 */
  .col-main { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: 26px; align-items: center; min-width: 0; overflow: hidden; }
  .commit-row.expanded .col-main { grid-template-rows: 26px auto; }
  .col-main .graph-svg { grid-column: 1; grid-row: 1 / -1; align-self: stretch; flex: 0 0 auto; }
  .col-main-summary { grid-column: 2; grid-row: 1; display: flex; align-items: center; min-width: 0; overflow: hidden; padding: 0 5px; }
  .col-main-summary .commit-message-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--vscode-foreground, inherit); }
  .commit-description { display: none; grid-column: 2; grid-row: 2; padding: 7px 5px; border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); line-height: 17px; cursor: text; }
  .commit-row.expanded .commit-description { display: block; }
  .commit-description:empty { display: none; }
  .commit-description-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; white-space: normal; }
  .commit-description-ref { display: inline-flex; align-items: center; min-height: 18px; padding: 0 6px; border-radius: 5px; color: var(--vscode-editor-background); font-size: 12px; line-height: 18px; }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground, #094771); }
  .commit-row.working-tree:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.working-tree.disabled { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); cursor: default; pointer-events: none; }
  .commit-row.working-tree.disabled:hover { background: transparent; }
  .commit-row.working-tree.disabled .working-tree-label, .commit-row.working-tree.disabled .working-tree-count { color: inherit; }
  .working-tree-label { color: var(--vscode-textLink-foreground); font-weight: 600; }
  .working-tree-count { color: var(--vscode-descriptionForeground); }
  .commit-header > div { position: relative; min-width: 0; padding: 5px 14px 5px 0; overflow: hidden; white-space: nowrap; text-align: left; }
  .commit-header .resize-handle { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
  .commit-header .resize-handle:hover { background: var(--vscode-focusBorder); }
  .col-main, .col-hash, .col-author, .col-date { min-width: 0; overflow: hidden; white-space: nowrap; text-align: left; }
  .col-hash, .col-author, .col-date { padding: 0 5px; height: 26px; display: flex; align-items: center; }
  .graph-svg { flex: 0 0 auto; }
  .col-message-head-refs { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-right: 8px; vertical-align: middle; flex: 0 0 auto; }
  .col-message-head-ref { display: inline-flex; align-items: center; gap: 3px; min-height: 16px; padding: 0 5px; border-radius: 4px; color: var(--vscode-editor-background); font-size: 11px; line-height: 16px; }
  /* 选择器需两级以压过 codicon.css 的 .codicon[class*='codicon-']，否则其 16px/1 行高会让图标与标签文本错位。 */
  .col-message-head-ref .codicon { display: flex; align-items: center; font-size: 11px; line-height: 1; }
  .col-hash { width: max-content; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85; color: var(--vscode-descriptionForeground, inherit); }
  .col-author, .col-date { width: max-content; text-overflow: clip; }
  .col-author { opacity: 0.75; }
  .col-date { opacity: 0.65; font-variant-numeric: tabular-nums; }
  svg { display: block; }
  .ref-head { font-weight: 600; }
  .dot { stroke: var(--vscode-editor-background); stroke-width: 1; }
  #loading { padding: 20px; text-align: center; }
  #loadingText { opacity: 0.8; margin-bottom: 10px; }
  #progressBar { width: 80%; height: 4px; background: var(--vscode-panel-border, #444); border-radius: 2px; margin: 0 auto 4px; overflow: hidden; }
  #progressBarFill { height: 100%; background: var(--vscode-textLink-foreground, #007acc); width: 0%; transition: width 0.3s ease; border-radius: 2px; }
  #progressBarFill.indeterminate { width: 30%; animation: indeterminate 1s ease-in-out infinite alternate; }
  @keyframes indeterminate { from { transform: translateX(-150%); } to { transform: translateX(350%); } }
  #progressStep { font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0.7; }
  #commitEmpty { padding: 8px 10px; color: var(--vscode-descriptionForeground); }
  #commitFooter { min-width: max-content; padding: 8px 10px; text-align: center; color: var(--vscode-descriptionForeground); }
  #commitFooter button { border: 0; color: var(--vscode-textLink-foreground); background: transparent; cursor: pointer; text-decoration: underline; }
  #searchBox { display: flex; align-items: center; position: relative; }
  #searchInput { width: 150px; padding: 3px 22px 3px 24px; font-size: 12px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, inherit); border-radius: 4px; transition: border-color 0.15s, box-shadow 0.15s; }
  #searchInput:focus { outline: none; border-color: var(--vscode-focusBorder, #007acc); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc); }
  #searchInput::placeholder { color: var(--vscode-inputPlaceholderForeground, #888); }
  #searchIcon { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; opacity: 0.5; pointer-events: none; color: var(--vscode-input-foreground, inherit); }
  #searchClear { position: absolute; right: 4px; top: 0; bottom: 0; margin: auto 0; width: 16px; height: 16px; border: none; background: transparent; color: var(--vscode-descriptionForeground, #888); cursor: pointer; display: none; font-size: 14px; line-height: 16px; padding: 0; border-radius: 3px; align-items: center; justify-content: center; }
  #searchClear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-input-foreground, inherit); }
  #searchClear.visible { display: flex; }
</style>
</head>
<body>
  <div id="header">
    <div class="selector-group repo-group"><span class="selector-prefix">repo:</span><div class="dropdown" id="repositoryDropdown">
      <button class="dropdown-current" type="button" title="切换仓库或子仓库" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>未选择仓库</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选仓库" aria-label="筛选仓库"><div class="dropdown-options"></div></div>
    </div><button class="uncommitted-repo-badge" id="uncommittedRepoBadge" title="Git - 0 个仓库有未提交文件" aria-label="打开存在未提交文件的仓库" hidden>0</button></div>
    <div class="selector-group" id="branchSelector"><span class="selector-prefix">branchs:</span><div class="dropdown" id="branchDropdown">
      <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>加载分支...</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选分支" aria-label="筛选分支"><div class="dropdown-options"></div><div class="dropdown-actions"><button type="button" class="toggle-all" aria-pressed="false"><input type="checkbox" tabindex="-1" aria-hidden="true"><span>全选</span></button><div class="dropdown-actions-right"><button type="button" class="confirm-selection">确定</button><button type="button" class="cancel-selection">取消</button></div></div></div>
    </div></div>
    <div class="selector-group search-group"><div class="selector" id="searchBox"><svg id="searchIcon" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 .96-.96l3.04 3.03-1.06 1.06-2.94-3.13z"/></svg><input type="text" id="searchInput" placeholder="搜索提交..." title="输入关键词搜索, 支持作者/邮箱/消息/Hash/日期, 多个关键词用空格隔开, 回车开始搜索"><button id="searchClear" title="清除搜索">&times;</button></div><span class="count" id="countLabel"></span><button class="toolbar-icon" id="refreshBtn" title="刷新提交" aria-label="刷新提交"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6A5 5 0 1 0 13 10M13 2v4H9"/></svg></button></div>
    <div id="toolbarActions">
      <button class="toolbar-icon" id="fetchBtn" title="Fetch" aria-label="Fetch"><span class="codicon codicon-repo-fetch" aria-hidden="true"></span></button>
      <button class="toolbar-icon" id="pullBtn" title="Pull" aria-label="Pull"><span class="codicon codicon-repo-pull" aria-hidden="true"></span></button>
      <button class="toolbar-icon" id="pushBtn" title="Push" aria-label="Push"><span class="codicon codicon-repo-push" aria-hidden="true"></span></button>
    </div>
  </div>
  <main id="workspace">
    <div id="graph">
      <div id="commitHeader" class="commit-header"><div>描述</div><div>作者</div><div>Commit ID</div><div>时间</div></div>
      <div id="loading" style="display:none;">
        <div id="loadingText">加载中...</div>
        <div id="progressBar"><div id="progressBarFill"></div></div>
        <div id="progressStep"></div>
      </div>
      <div id="commitList"><div id="commitEmpty">提交记录将在此显示</div></div>
      <div id="commitFooter" hidden></div>
    </div>
    <div id="panelResizeHandle" role="separator" aria-label="调整提交图与变更文件宽度" aria-orientation="vertical"></div>
    <section id="filesSection">
      <div id="filesHeader"><div id="filesTitle"><span>Changed Files</span><span id="filesCommitHash"></span><span class="action-group" aria-label="复制操作"><button class="toolbar-icon commit-action" data-action="copyHash" title="Copy Commit Hash to Clipboard" aria-label="Copy Commit Hash to Clipboard"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1"/><path d="M3 10.5v-7A1.5 1.5 0 0 1 4.5 2H10"/></svg></button></span></div><div id="filesActions"><div class="action-group commit-history-action-group" aria-label="提交操作"><button class="toolbar-icon commit-action" data-action="addTag" title="Add Tag..." aria-label="Add Tag"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.75 7.25 3h5.75v5.75L8.25 13.5 2.5 7.75Z"/><circle cx="10.25" cy="5.75" r=".75" fill="currentColor" stroke="none"/></svg></button><button class="toolbar-icon commit-action" data-action="createBranch" title="Create Branch..." aria-label="Create Branch"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 5.5c0 2.1 1.4 3.5 3.5 3.5H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="9" r="1.25"/></svg></button><button class="toolbar-icon commit-action" data-action="checkout" title="Checkout..." aria-label="Checkout"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v8m0 0-2-2m2 2 2-2M4 11h4.5A3.5 3.5 0 0 0 12 7.5V5"/><path d="m10 6 2-2 2 2"/></svg></button><button class="toolbar-icon commit-action" data-action="cherryPick" title="Cherry Pick..." aria-label="Cherry Pick"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.25"/><circle cx="12" cy="12" r="1.25"/><path d="M4 5.25v2.5A3.25 3.25 0 0 0 7.25 11H12M6 3h3"/></svg></button><button class="toolbar-icon commit-action" data-action="revert" title="Revert..." aria-label="Revert"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 3 6.5 5.5 9M3.5 6.5h6A3.5 3.5 0 1 1 6 10"/></svg></button><button class="toolbar-icon commit-action" data-action="drop" title="Drop..." aria-label="Drop"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 6.5v6h6v-6M7 8.5v2.5M9 8.5v2.5"/></svg></button></div><div class="action-group commit-history-action-group" aria-label="分支操作"><button class="toolbar-icon commit-action" data-action="merge" title="Merge into current branch..." aria-label="Merge into current branch"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 10c0-2.5 1.75-4 4.25-4H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="6" r="1.25"/></svg></button><button class="toolbar-icon commit-action" data-action="rebase" title="Rebase current branch on this Commit..." aria-label="Rebase current branch on this Commit"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h7M8.5 2 11 4 8.5 6M13 12H6M7.5 10 5 12l2.5 2"/></svg></button><button class="toolbar-icon commit-action" data-action="reset" title="Reset current branch to this Commit..." aria-label="Reset current branch to this Commit"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="5.5" width="8" height="8" rx="1"/><path d="M2.5 6A4.5 4.5 0 0 1 7 2.5h2M7 2.5l2 2-2 2"/></svg></button></div><div id="commitSplitGroup" class="action-group" hidden><button id="commitPrimaryBtn" type="button" title="创建新的提交">Go Commit</button></div><div class="action-group"><button class="toolbar-icon" id="filesModeBtn" title="显示方式（当前：树状）" aria-label="显示方式"><svg viewBox="0 0 16 16" aria-hidden="true"><path id="filesModeIcon" d="M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6"/></svg></button></div></div></div>
      <div id="filesList"><div id="filesEmpty">选择一个提交以查看变更文件</div></div>
      <div id="fileContextMenu" hidden><button type="button" data-copy-path="relative">复制相对路径</button><button type="button" data-copy-path="absolute">复制完整路径</button></div>
    </section>
  </main>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  let commits = [];
  let branches = [];
  let totalBranches = [];
  let selectedBranches = [];
  let uncommittedEnabled = false;
  let stagedCount = 0;
  let changesCount = 0;
  let files = [];
  let stagedFiles = [];
  let unstagedFiles = [];
  let filesLoading = false;
  let filesMode = 'flat';
  let contextFilePath = '';
  let selectedPath = '';
  let selectedCommitHash = '';
  let selectedCommitRepositoryPath = '';
  let hasMoreCommits = false;
  let commitListRevision = 0;
  let isLoadingMoreCommits = false;
  let commitPageError = '';
  let isCommitLoading = false;
  let commitLoadObserver = null;
  let commitListModelKey = '';
  let workingTreeModelKey = '';
  let repositoryEntries = [];
  let selectedRepositoryPaths = [];
  const collapsedFolders = new Set();
  const columnWidths = {};
  const columnWidthChars = { hash: 0, author: 0, date: 0 };
  let resizing = null;
  let panelResizing = null;

    const ROW_H = 26;
    const LANE_W = 12;
    const expandedCommits = new Set();
  const DOT_R = 5;
  let graphViewportWidth = 0;
  // 增量渲染状态
  let currentMaxLane = 0;
  let currentGraphW = LANE_W + 10;

  window.addEventListener('focus', function() { vscode.postMessage({ type: 'focus' }); });
  window.addEventListener('blur', function() { closeDropdowns(); vscode.postMessage({ type: 'blur' }); });
  document.addEventListener('visibilitychange', function() { if (document.visibilityState !== 'visible') closeDropdowns(); vscode.postMessage({ type: document.visibilityState === 'visible' ? 'focus' : 'blur' }); });

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

  function updateDropdownLoading(dropdown, loading, ariaLabel) {
    const progress = dropdown.options.querySelector('.dropdown-progress');
    dropdown.current.dataset.loading = loading ? 'true' : 'false';
    let spinner = dropdown.current.querySelector('.dropdown-spinner');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'dropdown-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      dropdown.current.querySelector('.dropdown-label').appendChild(spinner);
    }
    spinner.hidden = !loading;
    if (loading) {
      if (!progress) {
        const nextProgress = document.createElement('div');
        nextProgress.className = 'dropdown-progress';
        nextProgress.setAttribute('aria-label', ariaLabel);
        dropdown.options.insertBefore(nextProgress, dropdown.options.firstChild);
      }
    } else if (progress) {
      progress.remove();
    }
  }
  function updateRepositoryLoading(loading) {
    updateDropdownLoading(repositoryDropdown, loading, '正在加载仓库');
  }
  function updateBranchLoading(loading) {
    updateDropdownLoading(branchDropdown, loading, '正在加载分支');
  }
  function showLoadingProgress(phase, message, current, total) {
    isCommitLoading = true;
    document.getElementById('commitList').style.display = 'none';
    document.getElementById('commitFooter').hidden = true;
    document.getElementById('countLabel').hidden = true;
    if (message) document.getElementById('loadingText').textContent = message;
    var fill = document.getElementById('progressBarFill');
    var step = document.getElementById('progressStep');
    var c = current || 0;
    var t = total || 0;
    if (t > 0) {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.round(c / t * 100) + '%';
      step.textContent = c + ' / ' + t;
      step.style.display = 'block';
    } else {
      fill.classList.add('indeterminate');
      fill.style.width = '';
      step.textContent = '';
      step.style.display = 'none';
    }
    // 加载阶段立即覆盖提交列表；数据仍保留在内存中，失败或完成后可继续渲染。
    document.getElementById('progressBar').style.display = 'block';
    document.getElementById('loading').style.display = 'block';
    document.getElementById('commitList').style.display = 'none';
  }
  document.getElementById('refreshBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('uncommittedRepoBadge').addEventListener('click', function() {
    vscode.postMessage({ type: 'openCommitPanel' });
  });
  document.addEventListener('animationend', function(event) {
    var target = event.target;
    if (target && target.id === 'refreshBtn') target.classList.remove('refresh-unchanged');
  });
  document.addEventListener('animationcancel', function(event) {
    var target = event.target;
    if (target && target.id === 'refreshBtn') target.classList.remove('refresh-unchanged');
  });
  ['fetch', 'pull', 'push'].forEach(function(action) {
    document.getElementById(action + 'Btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'gitSync', action: action });
    });
  });
  document.querySelectorAll('.commit-action').forEach(function(button) {
    button.addEventListener('click', function() {
      if (!selectedCommitHash || selectedCommitHash === 'uncommitted' || !selectedCommitRepositoryPath) return;
      vscode.postMessage({ type: 'commitAction', action: button.dataset.action, hash: selectedCommitHash, repositoryPath: selectedCommitRepositoryPath });
    });
  });
  document.getElementById('commitPrimaryBtn').addEventListener('click', function() {
    if (this.disabled) return;
    this.disabled = true;
    document.getElementById('commitSplitGroup').classList.add('loading');
    document.getElementById('commitSplitGroup').setAttribute('aria-busy', 'true');
    vscode.postMessage({ type: 'openCommitEditor', amend: false, repositoryPath: selectedCommitRepositoryPath });
  });
  document.getElementById('filesModeBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'toggleFilesMode' });
  });
  var searchDebounceTimer = null;
  function triggerSearch() {
    var input = document.getElementById('searchInput');
    vscode.postMessage({ type: 'search', keywords: input.value });
  }
  function debounceSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function() {
      searchDebounceTimer = null;
      triggerSearch();
    }, 500);
  }
  function triggerSearchImmediately() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    triggerSearch();
  }
  document.getElementById('searchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerSearchImmediately();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.value = '';
      document.getElementById('searchClear').classList.remove('visible');
      triggerSearchImmediately();
    }
  });
  document.getElementById('searchInput').addEventListener('input', function() {
    var clearBtn = document.getElementById('searchClear');
    if (this.value.length > 0) { clearBtn.classList.add('visible'); } else { clearBtn.classList.remove('visible'); }
    debounceSearch();
  });
  document.getElementById('searchClear').addEventListener('click', function() {
    var input = document.getElementById('searchInput');
    input.value = '';
    input.focus();
    this.classList.remove('visible');
    triggerSearchImmediately();
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
        if (root === branchDropdown) {
          // 每次打开都以已确认选择重置弹窗草稿。
          const applied = branchDropdown.appliedSelection || new Set();
          branchDropdown.selected.clear();
          applied.forEach(function(value) { branchDropdown.selected.add(value); });
        }
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
    dropdown.menu.style.maxHeight = Math.floor(panelHeight * 3 / 4) + 'px';
  }

  function updateOpenDropdownHeights() {
    [repositoryDropdown, branchDropdown].forEach(function(dropdown) {
      if (dropdown && dropdown.root.classList.contains('open')) updateDropdownHeight(dropdown);
    });
  }

  function closeDropdown(dropdown) {
    const wasOpen = dropdown.root.classList.contains('open');
    if (wasOpen && !dropdown.skipRestore && dropdown.restoreSelection) dropdown.restoreSelection();
    dropdown.skipRestore = false;
    dropdown.root.classList.remove('open');
    dropdown.current.setAttribute('aria-expanded', 'false');
  }

  function closeDropdowns() {
    if (repositoryDropdown) closeDropdown(repositoryDropdown);
    if (branchDropdown) closeDropdown(branchDropdown);
  }

  const repositoryDropdown = createDropdown('repositoryDropdown', function() {});
  const branchDropdown = createDropdown('branchDropdown', function() {});

  document.addEventListener('click', function(event) {
    if (!event.target.closest('.dropdown')) closeDropdowns();
    if (!event.target.closest('#fileContextMenu')) document.getElementById('fileContextMenu').hidden = true;
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      closeDropdowns();
      document.getElementById('fileContextMenu').hidden = true;
    }
  });
  document.getElementById('fileContextMenu').addEventListener('click', function(event) {
    const button = event.target.closest('[data-copy-path]');
    if (!button || !contextFilePath) return;
    vscode.postMessage({ type: 'copyFilePath', path: contextFilePath, absolute: button.getAttribute('data-copy-path') === 'absolute' });
    document.getElementById('fileContextMenu').hidden = true;
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
    if (msg.type === 'stateUpdate') {
      // 每次都以完整 Store 快照替换业务模型；局部变量仅保存 DOM 交互细节。
      var state = msg.state;
      if (!state) return;
      var previousCommitLoading = isCommitLoading;
      isCommitLoading = Boolean(state.isLoading);
      commits = state.commits || [];
      branches = state.branches || [];
      selectedBranches = state.selectedBranches || [];
      var workingTreeRows = state.workingTreeRows || [];
      uncommittedEnabled = Boolean(workingTreeRows[0]?.enabled);
      var uncommittedRepositoryCount = Number(state.uncommittedRepositoryCount) || 0;
      var uncommittedRepoBadge = document.getElementById('uncommittedRepoBadge');
      uncommittedRepoBadge.textContent = String(uncommittedRepositoryCount);
      uncommittedRepoBadge.title = 'Git - ' + uncommittedRepositoryCount + ' 个仓库有未提交文件';
      uncommittedRepoBadge.hidden = uncommittedRepositoryCount === 0;
      stagedCount = Number(state.stagedCount) || 0;
      changesCount = Number(state.changesCount) || 0;
      hasMoreCommits = Boolean(state.hasMoreCommits);
      isLoadingMoreCommits = Boolean(state.isLoadingMoreCommits);
      commitPageError = state.commitPageError || '';
      files = state.files || [];
      stagedFiles = state.stagedFiles || [];
      unstagedFiles = state.unstagedFiles || [];
      filesMode = state.filesMode || 'tree';
      filesLoading = Boolean(state.filesLoading);
      var commitEditorLoading = Boolean(state.commitEditorLoading);
      document.getElementById('commitPrimaryBtn').disabled = commitEditorLoading;
      document.getElementById('commitSplitGroup').classList.toggle('loading', commitEditorLoading);
      document.getElementById('commitSplitGroup').setAttribute('aria-busy', String(commitEditorLoading));
      var diffProgress = state.diffProgress || { completed: 0, total: 0 };
      var diffLoading = Boolean(state.diffLoading);
      selectedPath = state.selectedPath || '';
      selectedCommitHash = state.selectedCommit ? state.selectedCommit.hash : '';
      selectedCommitRepositoryPath = state.selectedCommit ? state.selectedCommit.repositoryPath : '';
      var nextCommitListModelKey = JSON.stringify([
        commits.map(function(commit) { return commit.key || ((commit.repositoryPath || '') + ':' + commit.hash); }),
        selectedRepositoryPaths,
        selectedBranches,
        workingTreeRows.map(function(row) { return [row.hash, row.repositoryPath, row.label, row.enabled]; }),
        commitListRevision,
      ]);
      var shouldRenderCommitList = nextCommitListModelKey !== commitListModelKey
        || previousCommitLoading !== isCommitLoading;
      commitListModelKey = nextCommitListModelKey;
      currentMaxLane = 0;
      currentGraphW = LANE_W + 10;
      columnWidthChars.hash = 0;
      columnWidthChars.author = 0;
      columnWidthChars.date = 0;
      if (state.commitListRevision !== undefined && state.commitListRevision !== commitListRevision) expandedCommits.clear();
      commitListRevision = state.commitListRevision || 0;
      renderSelectorState(state);
      if (shouldRenderCommitList) {
        render();
      }
      applySelectedCommit();
      updateCountLabel();
      updateFilesCommitHash();
      if (filesLoading) {
        var progressText = diffProgress.total > 0 ? '（已加载 ' + diffProgress.completed + ' / ' + diffProgress.total + '）' : '';
        document.getElementById('filesList').innerHTML = '<div id="filesEmpty"><span class="files-loading-spinner"></span><span>正在加载变更文件' + progressText + '...</span></div>';
      } else {
        renderFiles();
      }
      if (isCommitLoading) {
        showLoadingProgress('start', state.loadingMessage || '加载中...', 0, 0);
      } else {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('commitList').style.display = 'block';
        document.getElementById('countLabel').hidden = false;
        renderCommitFooter();
      }
    } else if (msg.type === 'totalRepoListChanged') {
      updateTotalRepositoryList(msg.repositories || []);
    } else if (msg.type === 'totalBranchesListChanged') {
      updateTotalBranchesList(msg.branches || []);
    } else if (msg.type === 'repoLoadingChanged') {
      updateRepositoryLoading(Boolean(msg.loading));
    } else if (msg.type === 'selectedRepoDisplayChanged') {
      updateSelectedRepoDisplay(msg.repository);
    } else if (msg.type === 'selectedBranchDisplayChanged') {
      updateSelectedBranchDisplay(msg.display);
    } else if (msg.type === 'branchLoadingChanged') {
      updateBranchLoading(Boolean(msg.loading));
    } else if (msg.type === 'loadingProgress') {
      showLoadingProgress(msg.phase || 'start', msg.message || '加载中...', msg.current, msg.total);
    } else if (msg.type === 'refreshing') {
      showLoadingProgress('start', msg.message || '正在刷新...', 0, 0);
    } else if (msg.type === 'filesLoadingProgress') {
      if ((msg.hash || '') !== selectedCommitHash || (msg.repositoryPath || '') !== selectedCommitRepositoryPath) return;
      if (!filesLoading) return; // 只在 loading 状态下更新进度
      var loadingMessage = escapeHtml(msg.message || '正在加载变更文件...');
      var progressText = msg.total > 0 ? ' (' + msg.current + '/' + msg.total + ')' : '';
      document.getElementById('filesList').innerHTML = '<div id="filesEmpty"><span class="files-loading-spinner"></span><span>' + loadingMessage + progressText + '</span></div>';
    } else if (msg.type === 'filesError') {
      if ((msg.hash || '') !== selectedCommitHash || (msg.repositoryPath || '') !== selectedCommitRepositoryPath) return;
      document.getElementById('filesList').innerHTML = '<div id="filesEmpty">无法加载变更文件: ' + escapeHtml(msg.message || '') + '</div>';
    }
  });
  vscode.postMessage({ type: 'webviewReady' });

  function selectedLabel(entries, selectedValues, emptyLabel, allLabel) {
    const selected = new Set(selectedValues || []);
    const seen = new Set();
    const selectedEntries = [];
    entries.forEach(function(entry) {
      if (selected.has(entry.value) && !seen.has(entry.value)) { seen.add(entry.value); selectedEntries.push(entry); }
    });
    const uniqueCount = new Set(entries.map(function(entry) { return entry.value; })).size;
    if (uniqueCount > 0 && seen.size === uniqueCount) return allLabel;
    const label = selectedEntries.map(function(entry) { return entry.label; }).join(', ') || emptyLabel;
    return label.length > 20 ? label.slice(0, 20) + '...' : label;
  }

  function selectedTitle(entries, selectedValues, emptyLabel) {
    const selected = new Set(selectedValues || []);
    const seen = new Set();
    const selectedEntries = [];
    entries.forEach(function(entry) {
      if (selected.has(entry.value) && !seen.has(entry.value)) { seen.add(entry.value); selectedEntries.push(entry); }
    });
    return selectedEntries.map(function(entry) { return entry.label; }).join(', ') || emptyLabel;
  }

  function repositoryIcon(hasSubmodules) {
    return hasSubmodules
      ? '<span class="repository-icon has-submodules" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/><rect x="5" y="7.5" width="6" height="3.5" rx="0.5"/></svg></span>'
      : '<span class="repository-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/></svg></span>';
  }
  function updateSelectedRepoDisplay(repository) {
    console.log('[Webview] updateSelectedRepoDisplay', performance.now(), repository);
    const loading = repositoryDropdown.current.dataset.loading === 'true';
    repositoryDropdown.current.disabled = !repository;
    repositoryDropdown.label.innerHTML = (repository
      ? repositoryIcon(repository.hasSubmodules) + escapeHtml(repository.label)
      : '未选择仓库') + '<span class="dropdown-spinner"' + (loading ? '' : ' hidden') + ' aria-hidden="true"></span>';
    repositoryDropdown.current.title = repository ? repository.path : '未选择仓库';
  }
  function updateSelectedBranchDisplay(display) {
    // 是否置灰只由完整分支列表是否为空决定，不能由当前选中分支决定。
    const loading = branchDropdown.current.dataset.loading === 'true';
    branchDropdown.current.disabled = totalBranches.length === 0;
    branchDropdown.label.innerHTML = escapeHtml(display ? display.label : '未选择分支')
      + '<span class="dropdown-spinner"' + (loading ? '' : ' hidden') + ' aria-hidden="true"></span>';
    branchDropdown.current.title = display ? display.title : '未选择分支';
  }
  function renderRepositoryOptions(entries, selectedValues) {
    const selectedValue = (selectedValues || []).find(function(value) {
      return entries.some(function(entry) { return entry.value === value; });
    }) || '';
    repositoryDropdown.options.innerHTML = '';
    entries.forEach(function(entry) {
      const option = document.createElement('label');
      const checked = entry.value === selectedValue;
      option.className = 'dropdown-option' + (checked ? ' selected' : '');
      option.title = entry.title || entry.label;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'repository';
      radio.value = entry.value;
      radio.checked = checked;
      radio.addEventListener('change', function() {
        if (!radio.checked) return;
        repositoryDropdown.options.querySelectorAll('.dropdown-option').forEach(function(item) {
          item.classList.toggle('selected', item === option);
        });
        closeDropdown(repositoryDropdown);
        // 先让浏览器提交仓库阶段这一帧，再通知扩展端；否则同步代码会在首次绘制前切到分支阶段。
        requestAnimationFrame(function() {
          updateBranchLoading(true);
          vscode.postMessage({ type: 'selectRepositories', paths: [entry.value] });
        });
      });
      option.appendChild(radio);
      option.insertAdjacentHTML('beforeend', repositoryIcon(entry.hasSubmodules));
      option.appendChild(document.createTextNode(entry.label));
      repositoryDropdown.options.appendChild(option);
    });
  }

  function renderBranchOptions(entries, selectedValues) {
    const options = entries.filter(function(entry) { return !entry.group; });
    // 当前分支会同时出现在本地分支分组；全选状态和动作均按唯一引用计算。
    const uniqueOptionValues = Array.from(new Set(options.map(function(entry) { return entry.value; })));
    // 持久化 selected Set, 避免 stateUpdate 重建时旧 change handler 引用过期 Set
    if (!branchDropdown.selected) branchDropdown.selected = new Set();
    const selected = branchDropdown.selected;
    // 分支列表未变时只更新 checkbox 状态, 不销毁 DOM (避免 stateUpdate 导致点击丢失)
    var existingInputs = branchDropdown.options.querySelectorAll('input[type="checkbox"]');
    var canUpdateInPlace = existingInputs.length === options.length &&
      Array.from(existingInputs).every(function(input, i) { return input.value === options[i].value; });
    const serverSelection = (selectedValues || []).slice().sort().join('\0');
    // 弹窗打开期间，无论选项 DOM 是否因状态刷新重建，都保留打开前快照及未确认的选择。
    const keepPendingSelection = Boolean(branchDropdown.openSelection) || (branchDropdown.pendingSelection && branchDropdown.pendingSelection !== serverSelection);
    if (!keepPendingSelection) {
      selected.clear();
      (selectedValues || []).forEach(function(v) { selected.add(v); });
      branchDropdown.appliedSelection = new Set(selected);
      branchDropdown.pendingSelection = undefined;
    }
    function updateSelectionUi() {
      branchDropdown.options.querySelectorAll('input').forEach(function(checkbox) {
        checkbox.checked = selected.has(checkbox.value);
        checkbox.parentElement.classList.toggle('selected', checkbox.checked);
      });
      const toggleAll = branchDropdown.menu.querySelector('.toggle-all');
      const toggleAllCheckbox = toggleAll && toggleAll.querySelector('input[type="checkbox"]');
      const allSelected = uniqueOptionValues.length > 0 && uniqueOptionValues.every(function(value) { return selected.has(value); });
      if (toggleAll) toggleAll.setAttribute('aria-pressed', String(allSelected));
      if (toggleAllCheckbox) {
        toggleAllCheckbox.checked = allSelected;
        toggleAllCheckbox.indeterminate = false;
      }
    }
    function applySelection(values) {
      selected.clear();
      values.forEach(function(value) { selected.add(value); });
      updateSelectionUi();
    }
    branchDropdown.restoreSelection = function() {
      // 非确认关闭时，草稿无条件回到最后一次已应用选择。
      const appliedSelection = Array.from(branchDropdown.appliedSelection || []);
      branchDropdown.pendingSelection = undefined;
      applySelection(appliedSelection);
    };
    function bindBranchActions() {
      const toggleAll = branchDropdown.menu.querySelector('.toggle-all');
      const cancel = branchDropdown.menu.querySelector('.cancel-selection');
      const confirm = branchDropdown.menu.querySelector('.confirm-selection');
      toggleAll.onclick = function() {
        const allSelected = uniqueOptionValues.length > 0 && uniqueOptionValues.every(function(value) { return selected.has(value); });
        applySelection(allSelected ? [] : uniqueOptionValues);
      };
      cancel.onclick = function() { closeDropdown(branchDropdown); };
      confirm.onclick = function() {
        const confirmedValues = Array.from(selected);
        branchDropdown.pendingSelection = confirmedValues.sort().join('\0');
        // Store 状态回传前不更新本地确认快照，避免未被扩展端接受的草稿污染回滚基准。
        branchDropdown.skipRestore = true;
        closeDropdown(branchDropdown);
        vscode.postMessage({ type: 'selectBranches', names: confirmedValues });
      };
    }
    if (canUpdateInPlace) {
      updateSelectionUi();
      bindBranchActions();
      return;
    }
    branchDropdown.options.innerHTML = '';
    entries.forEach(function(entry) {
      if (entry.group) {
        const group = document.createElement('div');
        group.className = 'dropdown-group';
        group.textContent = entry.group;
        branchDropdown.options.appendChild(group);
        return;
      }
      const option = document.createElement('label');
      option.className = 'dropdown-option' + (selected.has(entry.value) ? ' selected' : '');
      option.title = entry.title || entry.label;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = entry.value;
      checkbox.checked = selected.has(entry.value);
      checkbox.addEventListener('change', function() {
        if (checkbox.checked) selected.add(entry.value); else selected.delete(entry.value);
        updateSelectionUi();
      });
      option.appendChild(checkbox);
      option.appendChild(document.createTextNode(entry.label));
      branchDropdown.options.appendChild(option);
    });
    updateSelectionUi();
    bindBranchActions();
  }

  function updateTotalRepositoryList(repositories) {
    repositoryEntries = repositories.map(function(repo) {
      return { value: repo.path, label: repo.label, title: repo.path, path: repo.path, hasSubmodules: Boolean(repo.hasSubmodules) };
    });
    renderRepositoryOptions(repositoryEntries, selectedRepositoryPaths);
  }

  function updateTotalBranchesList(nextBranches) {
    totalBranches = nextBranches.slice();
    renderTotalBranchOptions();
  }

  function renderTotalBranchOptions() {
    branchDropdown.root.hidden = false;
    const currentBranches = totalBranches.filter(function(branch) { return branch.kind === 'current'; });
    const localBranches = totalBranches.filter(function(branch) { return branch.kind === 'local'; });
    const remoteBranches = totalBranches.filter(function(branch) { return branch.kind === 'remote'; });
    const branchEntries = [];
    if (currentBranches.length) {
      branchEntries.push({ group: '当前分支' });
      currentBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    if (localBranches.length) {
      branchEntries.push({ group: '本地分支' });
      localBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    if (remoteBranches.length) {
      branchEntries.push({ group: '远程分支' });
      remoteBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    renderBranchOptions(branchEntries, selectedBranches);
  }

  function renderSelectorState(msg) {
    selectedRepositoryPaths = msg.selectedRepositoryPaths || [];
    selectedBranches = msg.selectedBranches || [];
    renderRepositoryOptions(repositoryEntries, selectedRepositoryPaths);
    renderTotalBranchOptions();
  }

  function revealSelectedFile() {
    if (!selectedPath) return;
    const list = document.getElementById('filesList');
    const item = list.querySelector('.file-item.selected');
    if (!item) return;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const viewportTop = listRect.top + list.clientTop;
    const viewportBottom = viewportTop + list.clientHeight;
    const sectionHeader = item.closest('.working-tree-section')?.querySelector('.working-tree-section-header');
    const visibleTop = sectionHeader ? Math.max(viewportTop, sectionHeader.getBoundingClientRect().bottom) : viewportTop;
    if (itemRect.bottom > viewportBottom) list.scrollTop += itemRect.bottom - viewportBottom;
    else if (itemRect.top < visibleTop) list.scrollTop -= visibleTop - itemRect.top;
  }

  function updateFilesCommitHash() {
    const isCommit = selectedCommitHash && selectedCommitHash !== 'uncommitted';
    const isUncommitted = selectedCommitHash === 'uncommitted' && Boolean(selectedCommitRepositoryPath);
    const hashLabel = document.getElementById('filesCommitHash');
    if (hashLabel) hashLabel.textContent = isCommit ? selectedCommitHash.slice(0, 8) : '';
    document.getElementById('commitSplitGroup').hidden = !isUncommitted;
    document.querySelectorAll('#filesActions .commit-history-action-group').forEach(function(group) {
      group.hidden = !isCommit;
    });
    document.querySelectorAll('.commit-action').forEach(function(button) {
      button.hidden = !isCommit;
    });
    document.querySelectorAll('#filesTitle .action-group').forEach(function(group) {
      group.hidden = !isCommit;
    });
  }

  function workingTreeActionButton(action, section, path, icon, title) {
    return '<button type="button" class="working-tree-action" data-working-tree-action="' + action + '" data-section="' + section + '"' +
      (path ? ' data-path="' + escapeAttr(path) + '"' : '') + ' title="' + title + '" aria-label="' + title + '"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span></button>';
  }

  function workingTreeActionsHTML(actions) {
    return actions + '<span class="working-tree-actions-spacer" aria-hidden="true"></span>';
  }

  function workingTreeKindIconHTML(file, section) {
    if (section === 'staged') {
      return '<span class="working-tree-kind working-tree-kind-staged" title="Staged：已暂存" aria-label="Staged：已暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="m5.8 9 2.1 2.1 4.35-4.45" stroke-width="2"/></svg></span>';
    }
    if (file.isUntracked) {
      return '<span class="working-tree-kind working-tree-kind-untracked" title="Untracked：未跟踪" aria-label="Untracked：未跟踪"><svg viewBox="0 0 18 18" aria-hidden="true"><circle class="kind-file" cx="9" cy="9" r="6.25"/><path d="M7.15 7.15c.15-2.1 3.85-2.15 3.85.15 0 1.55-2 1.65-2 3.15M9 12.75v.1" stroke-width="1.7"/></svg></span>';
    }
    return '<span class="working-tree-kind working-tree-kind-unstaged" title="Unstaged：未暂存" aria-label="Unstaged：未暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="M9 5.25v4.5M9 12.4v.1" stroke-width="2"/></svg></span>';
  }

  function workingTreeFileHTML(file, section) {
    const lastSlash = file.path.lastIndexOf('/');
    const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
    const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
    const actions = section === 'staged'
      ? workingTreeActionButton('unstage', section, file.path, 'remove', '取消暂存当前文件（移回 Unstaged Changes）')
      : workingTreeActionButton('discard', section, file.path, 'discard', '放弃当前文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, file.path, 'add', '暂存当前文件（移入 Staged Changes）');
    const untracked = section === 'unstaged' && file.isUntracked ? ' untracked' : '';
    const diffKey = section + ':' + file.path;
    return '<div class="file-item' + (diffKey === selectedPath ? ' selected' : '') + untracked + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '" data-section="' + section + '" title="' + escapeAttr(file.path) + '">' +
      workingTreeKindIconHTML(file, section) + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>' +
      '<span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder) + '</span>' : '') + '</span><span class="file-actions">' + workingTreeActionsHTML(actions) + '</span></div>';
  }

  function workingTreeSectionFilesHTML(section, sectionFiles) {
    const orderedFiles = sectionFiles;
    if (filesMode !== 'tree') return orderedFiles.map(function(file) { return workingTreeFileHTML(file, section); }).join('');
    const byFolder = new Map();
    orderedFiles.forEach(function(file) {
      const lastSlash = file.path.lastIndexOf('/');
      const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash) : '';
      const folderFiles = byFolder.get(folder) || [];
      folderFiles.push(file);
      byFolder.set(folder, folderFiles);
    });
    let html = '';
    byFolder.forEach(function(folderFiles, folder) {
      const folderKey = 'working-tree:' + section + ':' + folder;
      if (folder) {
        const expanded = !collapsedFolders.has(folderKey);
        html += '<div class="folder-item" data-folder="' + escapeAttr(folderKey) + '" title="' + escapeAttr(folder) + '">';
        html += '<span class="tree-chevron codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="tree-folder-icon codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="file-path">' + escapeHtml(folder) + '</span></div>';
        if (!expanded) return;
      }
      folderFiles.forEach(function(file) {
        const lastSlash = file.path.lastIndexOf('/');
        const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
        const actions = section === 'staged'
          ? workingTreeActionButton('unstage', section, file.path, 'remove', '取消暂存当前文件（移回 Unstaged Changes）')
          : workingTreeActionButton('discard', section, file.path, 'discard', '放弃当前文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, file.path, 'add', '暂存当前文件（移入 Staged Changes）');
        const diffKey = section + ':' + file.path;
        const untracked = section === 'unstaged' && file.isUntracked ? ' untracked' : '';
        html += '<div class="file-item' + (diffKey === selectedPath ? ' selected' : '') + untracked + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '" data-section="' + section + '" style="padding-left:' + (folder ? 30 : 10) + 'px" title="' + escapeAttr(file.path) + '">';
        html += workingTreeKindIconHTML(file, section) + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span><span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span></span><span class="file-actions">' + workingTreeActionsHTML(actions) + '</span></div>';
      });
    });
    return html;
  }

  function workingTreeSectionHTML(section, label, sectionFiles) {
    if (section === 'staged' && sectionFiles.length === 0) return '';
    const disabled = sectionFiles.length === 0;
    const hasSelected = sectionFiles.some(function(file) { return section + ':' + file.path === selectedPath; });
    const actions = disabled ? '' : section === 'staged'
      ? workingTreeActionButton('unstage', section, '', 'remove', '取消暂存此分组的所有文件（全部移回 Unstaged Changes）')
      : workingTreeActionButton('discard', section, '', 'discard', '放弃此分组所有文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, '', 'add', '暂存此分组的所有文件（全部移入 Staged Changes）');
    return '<section class="working-tree-section' + (hasSelected ? ' has-selected' : '') + '" data-section="' + section + '">' +
      '<div class="working-tree-section-header' + (disabled ? ' disabled' : '') + '"><span class="working-tree-section-leading"><span class="working-tree-section-title">' + label + '</span><span class="working-tree-section-count">' + sectionFiles.length + '</span></span><span class="working-tree-section-actions">' + workingTreeActionsHTML(actions) + '</span></div>' +
      '<div class="working-tree-section-body">' + workingTreeSectionFilesHTML(section, sectionFiles) + '</div></section>';
  }

  // 文件夹折叠绑定同时服务普通提交与虚拟提交两个渲染分支。
  function bindFolderItems(list) {
    list.querySelectorAll('.folder-item').forEach(function(item) {
      item.addEventListener('pointerdown', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
      });
      item.addEventListener('pointerup', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        const folder = item.getAttribute('data-folder');
        if (!folder) return;
        if (collapsedFolders.has(folder)) collapsedFolders.delete(folder); else collapsedFolders.add(folder);
        renderFiles();
      });
    });
  }

  function renderFiles() {
    const list = document.getElementById('filesList');
    const modeButton = document.getElementById('filesModeBtn');
    const modeIcon = document.getElementById('filesModeIcon');
    const isTree = filesMode === 'tree';
    modeIcon.setAttribute('d', isTree ? 'M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6' : 'M3 4h10M3 8h10M3 12h10');
    modeButton.title = '显示方式（当前：' + (isTree ? '树状' : '平铺') + '）';
    if (selectedCommitHash === 'uncommitted') {
      list.innerHTML = '<div class="working-tree-content">' + workingTreeSectionHTML('staged', 'Staged Changes', stagedFiles) + workingTreeSectionHTML('unstaged', 'Unstaged Changes', unstagedFiles) + '</div>';
      bindWorkingTreeActions(list);
      bindFolderItems(list);
      bindFileItems(list);
      revealSelectedFile();
      return;
    }
    if (!files.length) {
      list.innerHTML = '<div id="filesEmpty">此提交没有变更文件</div>';
      return;
    }
    const ordered = files;
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
          html += '<span class="tree-chevron codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="tree-folder-icon codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="file-path">' + escapeHtml(folder) + '</span></div>';
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
        html += '<span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder) + '</span>' : '') + '</span></div>';
      }
    }
    list.innerHTML = html;
    revealSelectedFile();
    bindFolderItems(list);
    bindFileItems(list);
  }

  function bindWorkingTreeActions(list) {
    list.querySelectorAll('[data-working-tree-action]').forEach(function(button) {
      button.addEventListener('pointerdown', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('pointerup', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'workingTreeAction', action: button.getAttribute('data-working-tree-action'), section: button.getAttribute('data-section'), path: button.getAttribute('data-path') || undefined });
      });
    });
  }

  function bindFileItems(list) {
    list.querySelectorAll('.file-item').forEach(function(item) {
      item.addEventListener('pointerdown', function(event) {
        if (event.button !== 0 || event.target.closest('.working-tree-action')) return;
        event.preventDefault();
      });
      item.addEventListener('pointerup', function(event) {
        if (event.button !== 0 || event.target.closest('.working-tree-action')) return;
        event.preventDefault();
        document.getElementById('fileContextMenu').hidden = true;
        const path = item.getAttribute('data-path');
        const diffKey = item.getAttribute('data-diff-key') || path;
        if (!path || !diffKey) return;
        selectedPath = diffKey;
        list.querySelectorAll('.file-item.selected').forEach(function(s) { s.classList.remove('selected'); });
        item.classList.add('selected');
        vscode.postMessage({ type: 'selectFile', path: diffKey });
      });
      item.addEventListener('contextmenu', function(event) {
        event.preventDefault();
        const path = item.getAttribute('data-path');
        if (!path) return;
        const menu = document.getElementById('fileContextMenu');
        menu.hidden = true;
        contextFilePath = path;
        menu.hidden = false;
        menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4) + 'px';
        menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4) + 'px';
      });
    });
  }

  function refClass(ref) {
    if (ref === 'HEAD') return 'ref-head';
    if (ref.includes('/')) return 'ref-remote';
    if (ref.startsWith('tag: ')) return 'ref-tag';
    return 'ref-branch';
  }

  function renderCommitFooter() {
    const footer = document.getElementById('commitFooter');
    if (isCommitLoading) {
      footer.hidden = true;
      footer.textContent = '';
      if (commitLoadObserver) commitLoadObserver.disconnect();
      return;
    }
    if (!commits.length) {
      footer.hidden = true;
      if (commitLoadObserver) commitLoadObserver.disconnect();
      return;
    }
    footer.hidden = false;
    if (commitLoadObserver) commitLoadObserver.disconnect();
    if (commitPageError) {
      footer.innerHTML = '加载更多提交失败，<button type="button" id="retryLoadMore">点击重试</button>';
      document.getElementById('retryLoadMore').addEventListener('click', function() {
        commitPageError = '';
        vscode.postMessage({ type: 'loadMoreCommits' });
      });
      return;
    }
    if (isLoadingMoreCommits) {
      footer.textContent = '正在加载更多提交...';
      return;
    }
    if (!hasMoreCommits) {
      footer.textContent = '已加载全部 ' + commits.length + ' 条提交';
      return;
    }
    footer.textContent = '继续滚动以加载更多提交';
    if ('IntersectionObserver' in window) {
      var triggerIndex = Math.max(0, commits.length - 20);
      var graph = document.getElementById('graph');
      var triggerRow = graph.querySelector('.commit-row[data-row="' + triggerIndex + '"]');
      if (!triggerRow) return;
      commitLoadObserver = new IntersectionObserver(function(entries) {
        if (entries.some(function(entry) { return entry.isIntersecting; })) {
          vscode.postMessage({ type: 'loadMoreCommits' });
        }
      }, { root: document.getElementById('graph') });
      commitLoadObserver.observe(triggerRow);
    }
  }

  // 标签和轨道共用官方泳道索引，确保横线始终从当前提交点向右连接。
  function rowMaxSwimlane(c) {
    var inputCount = (c.inputSwimlanes || []).length;
    var outputCount = (c.outputSwimlanes || []).length;
    var inputIndex = (c.inputSwimlanes || []).findIndex(function(lane) { return lane.hash === c.hash; });
    var circleIndex = inputIndex >= 0 ? inputIndex : inputCount;
    return Math.max(circleIndex, inputCount - 1, outputCount - 1, 0);
  }

  // 单行 SVG 宽度 = 该行实际泳道所需宽度; 描述随每行泳道紧贴, 泳道少的行不再留全表最大空白。
  // 坐标系与 width 同值保证 1:1 不缩放; (max+1)*LANE_W + 10 含节点半径余量。
  function rowGraphW(c) {
    return (rowMaxSwimlane(c) + 1) * LANE_W + 10;
  }

  // 分支标签图标(可多个): 当前分支=靶子, 远程分支=云, 本地分支=显示器。图标类型由 branches 的 kind 决定,
  // 不按 ref 文本猜测。ref 文本 (git log %D 的 short 名) 与 branch.label (%(refname:short)) 同源可直接匹配。
  // 特例: 远程 HEAD 符号指针命名恒为 "<remote>/HEAD" (git 规范), %(refname:short) 会被简化成 "<remote>",
  // 与 %D 文本 "origin/HEAD" 对不上; 它既是该远程的 HEAD 指针(靶子)又是远程(云), 故返回 [target, cloud]。
  function refIconsFor(ref, repositoryPath) {
    if (/\\/HEAD$/.test(ref)) return ['target', 'cloud'];
    var match = branches.find(function(branch) {
      return branch.repoOption.path === repositoryPath && branch.label === ref;
    });
    if (!match) return [];
    // 当前分支同时也是本地分支: 靶子在前, 本地分支图标(显示器)在后。
    if (match.kind === 'current') return ['target', 'device-desktop'];
    if (match.kind === 'remote') return ['cloud'];
    if (match.kind === 'local') return ['device-desktop'];
    return [];
  }


  // 提交节点颜色由其所在泳道决定；分支图标签与描述标签共用该颜色。
  function commitLaneColor(c) {
    var inputSwimlanes = c.inputSwimlanes || [];
    var outputSwimlanes = c.outputSwimlanes || [];
    var inputIndex = inputSwimlanes.findIndex(function(lane) { return lane.hash === c.hash; });
    var circleIndex = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
    return (outputSwimlanes[circleIndex] || inputSwimlanes[circleIndex] || {}).color || c.laneColor || '#888';
  }

  // 描述列的分支标签: 仅标注当前分支 HEAD 与其 upstream 远程分支 HEAD。
  // upstream 取自 for-each-ref 的 %(upstream), 不按 origin/<name> 命名约定猜测。
  function headBranchLabels(c) {
    var repositoryPath = c.gitBranchOption.repoOption.path;
    var sameRepo = branches.filter(function(branch) {
      return branch.repoOption.path === repositoryPath;
    });
    var current = sameRepo.find(function(branch) { return branch.kind === 'current'; });
    if (!current) return [];
    // 当前分支由 HEAD watcher 提供时不带 upstream, 回落到同名 local ref 记录。
    var localRef = sameRepo.find(function(branch) {
      return branch.kind === 'local' && branch.name === current.name;
    });
    var upstreamName = current.upstreamName || (localRef && localRef.upstreamName);
    var upstream = upstreamName ? sameRepo.find(function(branch) {
      return branch.kind === 'remote' && branch.name === upstreamName;
    }) : undefined;
    // 当前分支用靶子图标, 远程分支用云图标, 图标由 kind 决定而非标签文本。
    var labels = [];
    if (current.hash === c.hash) labels.push({ label: current.label, icon: 'target' });
    if (upstream && upstream.hash === c.hash) labels.push({ label: upstream.label, icon: 'cloud' });
    return labels;
  }

  // 构建单行提交 HTML
  function buildCommitRowHTML(i, graphW) {
    var c = commits[i];
    var commitKey = c.gitBranchOption.repoOption.path + ':' + c.hash;
    var selected = selectedCommitHash === c.hash && c.gitBranchOption.repoOption.path === selectedCommitRepositoryPath;
    // 描述只能在当前高亮 commit 上显示。
    var expanded = selected && expandedCommits.has(commitKey);
    var html = '<div class="commit-row' + (expanded ? ' expanded' : '') + (selected ? ' selected' : '') + '" data-hash="' + escapeAttr(c.hash) + '" data-repository-path="' + escapeAttr(c.gitBranchOption.repoOption.path) + '" data-row="' + i + '" data-has-description="true">';
    var repositoryPath = c.gitBranchOption.repoOption.path;
    var branchList = (c.refs || []).join(', ');
    var authorPreview = c.authorEmail ? c.author + ' <' + c.authorEmail + '>' : c.author;
    var commitDate = c.authorDate ? new Date(c.authorDate).toString() : c.authorDateLabel;
    var descriptionText = [c.message, c.body || ''].filter(Boolean).join('\\n')
      .trim().replace(/\\n[ \\t]*\\n(?:[ \\t]*\\n)+/g, '\\n\\n');
    var hoverDescription = [
      branchList,
      branchList ? '────────────────' : '',
      descriptionText,
      '────────────────',
      'Author: ' + authorPreview,
      'Date: ' + commitDate,
    ].filter(Boolean).join('\\n');
    // 分支标签(全部 c.refs)以 chip 形式并入描述字段的摘要行; 图标按 kind 决定: 当前=靶子, 远程=云, 本地=分支; 可多个。
    var refChipsHtml = (c.refs || []).map(function(ref) {
      var iconHtml = refIconsFor(ref, repositoryPath).map(function(icon) {
        return '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span>';
      }).join('');
      return '<span class="col-message-head-ref" style="background:' + escapeAttr(commitLaneColor(c)) + '">'
        + iconHtml + escapeHtml(ref) + '</span>';
    }).join('');
    // col-main: SVG(仅泳道, 按本行泳道宽) + 摘要行(chip + 提交信息) + 展开后的描述, 同属一个字段。
    var rowW = rowGraphW(c);
    html += '<div class="col-main"' + (branchList ? ' title="' + escapeAttr(branchList) + '"' : '') + '>';
    html += '<svg class="graph-svg" width="' + rowW + '" height="' + ROW_H + '" viewBox="0 0 ' + rowW + ' ' + ROW_H + '"></svg>';
    html += '<div class="col-main-summary" title="' + escapeAttr(hoverDescription) + '">'
      + (refChipsHtml ? '<span class="col-message-head-refs">' + refChipsHtml + '</span>' : '')
      + '<span class="commit-message-text">' + escapeHtml(c.message) + '</span></div>';
    var committerPreview = c.committerEmail ? c.committer + ' <' + c.committerEmail + '>' : c.committer;
    var parentList = (c.parents || []).join(' ');
    var description = [
      descriptionText,
      '────────────────',
      'Author: ' + authorPreview,
      'Date: ' + commitDate,
      'Commit: ' + c.hash,
      'Parents: ' + parentList,
      'Committer: ' + committerPreview,
    ].filter(Boolean).join('\\n');
    html += '<div class="commit-description">' + escapeHtml(description) + '</div>';
    html += '</div>';
    html += '<div class="col-author" title="' + escapeAttr(authorPreview) + '">' + escapeHtml(authorPreview) + '</div>';
    html += '<div class="col-hash">' + escapeHtml(c.shortHash) + '</div>';
    html += '<div class="col-date" title="' + escapeAttr(c.authorDateLabel) + '">' + escapeHtml(c.authorDateLabel) + '</div>';
    html += '</div>';
    return html;
  }

  // 仅更新提交选择，避免无关状态改变时重绘整张提交图。
  function applyCommitSelection(hash, repositoryPath) {
    var selectedKey = (repositoryPath || '') + ':' + (hash || '');
    expandedCommits.forEach(function(key) {
      if (key !== selectedKey) expandedCommits.delete(key);
    });
    // 不重建列表，避免 Store 确认前的旧快照撤销乐观高亮。
    document.querySelectorAll('.commit-row.expanded').forEach(function(row) {
      var rowKey = (row.getAttribute('data-repository-path') || '') + ':' + (row.getAttribute('data-hash') || '');
      if (rowKey === selectedKey) return;
      row.classList.remove('expanded');
      var svg = row.querySelector('svg');
      var index = Number(row.getAttribute('data-row'));
      if (svg && Number.isInteger(index) && commits[index]) {
        var rowW = rowGraphW(commits[index]);
        svg.setAttribute('width', String(rowW));
        svg.setAttribute('height', String(ROW_H));
        svg.setAttribute('viewBox', '0 0 ' + rowW + ' ' + ROW_H);
        drawSvg(svg, index, rowW, ROW_H, LANE_W, DOT_R);
      }
    });
    document.querySelectorAll('.commit-row.selected').forEach(function(row) {
      var rowHash = row.getAttribute('data-hash');
      var rowRepositoryPath = row.getAttribute('data-repository-path') || '';
      if (rowHash !== hash || rowRepositoryPath !== repositoryPath) {
        row.classList.remove('selected');
      }
    });
    if (!hash) return;
    document.querySelectorAll('.commit-row').forEach(function(row) {
      if (row.getAttribute('data-hash') !== hash) return;
      var rowRepositoryPath = row.getAttribute('data-repository-path') || '';
      if (rowRepositoryPath === repositoryPath
          || (!repositoryPath && (hash === 'uncommitted'))) {
        row.classList.add('selected');
      }
    });
  }

  function applySelectedCommit() {
    applyCommitSelection(selectedCommitHash, selectedCommitRepositoryPath);
  }

  // 为单行设置 SVG 和点击监听

  function setupRow(row, graphW) {
    var svg = row.querySelector('svg');
    if (svg) {
      var idx = Number(row.getAttribute('data-row'));
      // 每行按自身泳道宽度绘制, 使描述紧贴泳道; graphW 仅作无对应 commit 时的兜底。
      var rowW = commits[idx] ? rowGraphW(commits[idx]) : graphW;
      svg.setAttribute('width', String(rowW));
      svg.setAttribute('height', String(ROW_H));
      svg.setAttribute('viewBox', '0 0 ' + rowW + ' ' + ROW_H);
      drawSvg(svg, idx, rowW, ROW_H, LANE_W, DOT_R);
    }
    row.addEventListener('click', function(event) {
      if (row.classList.contains('disabled')) return;
      if (event.target && event.target.closest('.commit-description')) return;
      var hash = row.getAttribute('data-hash');
      var repositoryPath = row.getAttribute('data-repository-path');
      var commitKey = repositoryPath + ':' + hash;
      var wasSelected = row.classList.contains('selected');
      var wasExpanded = expandedCommits.has(commitKey);
      // 展开属于本地展示细节；提交选择只通过 intent 更新 Store。
      if (!hash || !repositoryPath || row.dataset.hasDescription !== 'true') {
        if (hash === 'uncommitted') {
          var virtualRepositoryPath = row.getAttribute('data-repository-path') || selectedRepositoryPaths[0] || '';
          applyCommitSelection(hash, virtualRepositoryPath);
          vscode.postMessage({ type: 'selectCommit', hash: hash });
        } else if (hash && repositoryPath) {
          applyCommitSelection(hash, repositoryPath);
          vscode.postMessage({ type: 'selectCommit', hash: hash, repositoryPath: repositoryPath });
        }
        return;
      }
      if (wasSelected) {
        // 仅已高亮 commit 可单击切换描述。
        if (wasExpanded) {
          expandedCommits.delete(commitKey);
        } else {
          expandedCommits.add(commitKey);
        }
        render();
        return;
      }
      if (!wasSelected) {
        // 乐观反馈仅改变 DOM 表现；Store 快照仍是唯一业务状态来源。
        applyCommitSelection(hash, repositoryPath);
        vscode.postMessage({ type: 'selectCommit', hash: hash, repositoryPath: repositoryPath });
      }
    });
  }

  // 计算官方输入/输出泳道的最大列索引。
  function calcMaxLane(startIndex) {
    var maxLane = startIndex > 0 ? currentMaxLane : 0;
    for (var i = startIndex; i < commits.length; i++) {
      maxLane = Math.max(maxLane, rowMaxSwimlane(commits[i]));
    }
    return maxLane;
  }

  function updateCountLabel() {
    var label = document.getElementById('countLabel');
    if (isCommitLoading) {
      label.hidden = true;
      label.textContent = '';
      return;
    }
    var total = commits.length;
    if (selectedCommitHash && selectedCommitHash !== 'uncommitted') {
      var idx = commits.findIndex(function(c) { return c.hash === selectedCommitHash; });
      if (idx >= 0) {
        label.textContent = (idx + 1) + '/' + total + ' 条提交';
        return;
      }
    }
    label.textContent = '—/' + total + ' 条提交';
  }

  function workingTreeRowHTML(hash, label, enabled) {
    const selectedBranch = getSelectedCurrentBranch();
    const repositoryPath = selectedBranch?.repoOption.path || selectedCommitRepositoryPath || selectedRepositoryPaths[0] || '';
    const selected = selectedCommitHash === hash ? ' selected' : '';
    const disabled = enabled ? '' : ' disabled';
    return '<div class="commit-row working-tree' + selected + disabled + '" data-hash="' + hash + '" data-repository-path="' + escapeHtml(repositoryPath) + '" aria-disabled="' + String(!enabled) + '">' +
      '<div class="col-main"><span class="graph-svg"></span><div class="col-main-summary working-tree-label">' + label + '</div></div>' +
      '<div class="col-author"></div><div class="col-hash">—</div><div class="col-date"></div></div>';
  }

  function getSelectedCurrentBranch() {
    return branches.find(function(branch) {
      return branch.kind === 'current'
        && selectedBranches.includes(branch.name)
        && selectedRepositoryPaths.includes(branch.repoOption.path);
    });
  }

  function updateWorkingTreeRows() {
    const list = document.getElementById('commitList');
    if (!list) return;
    list.querySelectorAll('.working-tree').forEach(function(row) { row.remove(); });
    const branch = getSelectedCurrentBranch();
    if (!branch) return;
    list.insertAdjacentHTML('afterbegin', workingTreeRowHTML('uncommitted', 'Uncommitted Changes', uncommittedEnabled));
    list.querySelectorAll('.working-tree').forEach(function(row) { setupRow(row, currentGraphW); });
  }

  function captureVisibleCommitAnchor(graph, list) {
    if (!graph || !list) return null;
    var graphTop = graph.getBoundingClientRect().top;
    var rows = list.querySelectorAll('.commit-row[data-hash][data-repository-path]');
    for (var index = 0; index < rows.length; index++) {
      var row = rows[index];
      var top = row.getBoundingClientRect().top - graphTop;
      var bottom = row.getBoundingClientRect().bottom - graphTop;
      if (bottom > 0 && top < graph.clientHeight) {
        return {
          hash: row.getAttribute('data-hash'),
          repositoryPath: row.getAttribute('data-repository-path'),
          top: top
        };
      }
    }
    return null;
  }

  function restoreVisibleCommitAnchor(graph, list, anchor, fallbackScrollTop) {
    if (!graph) return;
    if (!anchor) {
      graph.scrollTop = fallbackScrollTop;
      return;
    }
    var selector = '.commit-row[data-hash="' + CSS.escape(anchor.hash || '') + '"][data-repository-path="' + CSS.escape(anchor.repositoryPath || '') + '"]';
    var row = list.querySelector(selector);
    if (!row) {
      graph.scrollTop = fallbackScrollTop;
      return;
    }
    var top = row.getBoundingClientRect().top - graph.getBoundingClientRect().top;
    graph.scrollTop = Math.max(0, graph.scrollTop + top - anchor.top);
  }

  function render() {
    if (isCommitLoading) {
      document.getElementById('commitList').style.display = 'none';
      document.getElementById('commitFooter').hidden = true;
      document.getElementById('countLabel').hidden = true;
      return;
    }
    const graph = document.getElementById('graph');
    const scrollTop = graph ? graph.scrollTop : 0;
    const list = document.getElementById('commitList');
    const visibleCommitAnchor = captureVisibleCommitAnchor(graph, list);
    const loading = document.getElementById('loading');
    if (commits.length === 0) {
      loading.style.display = 'none';
      list.style.display = 'block';
      list.innerHTML = '<div id="commitEmpty">暂无提交记录</div>';
      renderCommitFooter();
      return;
    }
    loading.style.display = 'none';
    list.style.display = 'block';

    // 分支图 SVG 宽度 = 全列表最大泳道数所需宽度; 分支标签已迁出 SVG 不参与。
    var laneCount = calcMaxLane(0) + 1;
    currentMaxLane = laneCount - 1;
    var naturalGraphW = laneCount * LANE_W + 10;
    graphViewportWidth = graph ? graph.clientWidth : 0;
    var graphW = naturalGraphW;
    currentGraphW = graphW;
    document.getElementById('commitHeader').innerHTML =
      headerCell('描述', 'main') +
      headerCell('作者', 'author') + headerCell('Commit ID', 'hash') + headerCell('时间', 'date');
    var html = '';
    var selectedBranch = getSelectedCurrentBranch();
    if (selectedBranch) html += workingTreeRowHTML('uncommitted', 'Uncommitted Changes', uncommittedEnabled);
    for (let i = 0; i < commits.length; i++) {
      html += buildCommitRowHTML(i, graphW);
    }
    // SVG 泳道子列宽随泳道数变化; col-main 总宽由 --main-width (默认 = 泳道宽 + 60ch) 决定。
    graph.style.setProperty('--graph-lane-width', naturalGraphW + 'px');
    list.style.setProperty('--graph-lane-width', naturalGraphW + 'px');
    updateColumnWidths(commits, 0);
    list.innerHTML = html;

    var rows = list.querySelectorAll('.commit-row');
    rows.forEach(function(row) {
      setupRow(row, graphW);
    });

    updateCountLabel();
    renderCommitFooter();
    restoreVisibleCommitAnchor(graph, list, visibleCommitAnchor, scrollTop);
  }

  function drawSvg(svg, idx, graphW, rowH, laneW, dotR) {
    const c = commits[idx];
    const expanded = selectedCommitHash === c.hash
      && selectedCommitRepositoryPath === c.gitBranchOption.repoOption.path
      && expandedCommits.has(c.gitBranchOption.repoOption.path + ':' + c.hash);
    const svgH = expanded ? svg.closest('.commit-row').getBoundingClientRect().height : rowH;
    const y = rowH / 2;
    const detailsBottom = Math.max(rowH, svgH);
    svg.setAttribute('height', String(svgH));
    svg.setAttribute('viewBox', '0 0 ' + graphW + ' ' + svgH);
    let content = '';

    const inputSwimlanes = c.inputSwimlanes || [];
    const outputSwimlanes = c.outputSwimlanes || [];
    const inputIndex = inputSwimlanes.findIndex(function(lane) { return lane.hash === c.hash; });
    const circleIndex = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
    const cx = circleIndex * laneW + laneW / 2 + 5;
    const commitColor = commitLaneColor(c);
    const laneX = function(index) { return index * laneW + laneW / 2 + 5; };

    let outputIndex = 0;

    // 主 lane 替换为第一父时才消耗输出槽位；同 hash 的其余 lane 在当前节点汇入。
    for (let index = 0; index < inputSwimlanes.length; index++) {
      const inputLane = inputSwimlanes[index];
      if (inputLane.hash === c.hash) {
        if (index === inputIndex) {
          if (c.parents.length > 0) { outputIndex++; }
        } else {
          const x1 = laneX(index);
          const curveHeight = y;
          content += '<path d="M ' + x1 + ' 0 C ' + x1 + ' ' + (curveHeight * 0.45) + ' ' + cx + ' ' + (curveHeight * 0.75) + ' ' + cx + ' ' + y + '" fill="none" stroke="' + inputLane.color + '" stroke-width="1.5" stroke-linecap="round"/>';
        }
        continue;
      }
      if (outputIndex >= outputSwimlanes.length || inputLane.hash !== outputSwimlanes[outputIndex].hash) {
        continue;
      }
      const x1 = laneX(index);
      const x2 = laneX(outputIndex);
      if (index === outputIndex) {
        content += '<path d="M ' + x1 + ' 0 V ' + detailsBottom + '" fill="none" stroke="' + inputLane.color + '" stroke-width="1.5" stroke-linecap="round"/>';
      } else {
        const radius = 5;
        const direction = x2 > x1 ? 1 : -1;
        content += '<path d="M ' + x1 + ' 0 V ' + (y - radius) + ' A ' + radius + ' ' + radius + ' 0 0 ' + (direction > 0 ? 1 : 0) + ' ' + (x1 + direction * radius) + ' ' + y + ' H ' + (x2 - direction * radius) + ' A ' + radius + ' ' + radius + ' 0 0 ' + (direction > 0 ? 0 : 1) + ' ' + x2 + ' ' + (y + radius) + ' V ' + detailsBottom + '" fill="none" stroke="' + inputLane.color + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
      outputIndex++;
    }

    // 当前节点到父提交的边：已在输入泳道的节点只连后续父；新分支首节点连全部父。
    // 后续父可能与既有轨道同 hash，按 VS Code 连接最后追加的输出泳道。
    const firstConnectedParent = inputIndex >= 0 ? 1 : 0;
    for (let parentIndex = firstConnectedParent; parentIndex < c.parents.length; parentIndex++) {
      let parentOutputIndex = -1;
      for (let index = outputSwimlanes.length - 1; index >= 0; index--) {
        if (outputSwimlanes[index].hash === c.parents[parentIndex]) {
          parentOutputIndex = index;
          break;
        }
      }
      if (parentOutputIndex < 0) { continue; }
      const parentX = laneX(parentOutputIndex);
      const color = inputIndex < 0 ? commitColor : outputSwimlanes[parentOutputIndex].color;
      if (parentX === cx) {
        content += '<path d="M ' + cx + ' ' + y + ' V ' + detailsBottom + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
      } else {
        const curveHeight = detailsBottom - y;
        content += '<path d="M ' + cx + ' ' + y + ' C ' + cx + ' ' + (y + curveHeight * 0.35) + ' ' + parentX + ' ' + (y + curveHeight * 0.65) + ' ' + parentX + ' ' + detailsBottom + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
    }

    if (inputIndex >= 0) {
      content += '<path d="M ' + cx + ' 0 V ' + y + '" fill="none" stroke="' + inputSwimlanes[inputIndex].color + '" stroke-width="1.5" stroke-linecap="round"/>';
      if (c.parents.length > 0) {
        content += '<path d="M ' + cx + ' ' + y + ' V ' + detailsBottom + '" fill="none" stroke="' + commitColor + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
    }

    if (cx !== undefined) {
      // 分支标签已迁至描述字段的摘要行(chip), SVG 只保留泳道与节点。
      const isHead = c.refs && c.refs.some(function(r) { return r === 'HEAD'; });
      const isJoin = (c.parents && c.parents.length > 1) || inputSwimlanes.filter(function(lane) { return lane.hash === c.hash; }).length > 1;
      const r = isHead ? dotR + 2 : dotR;
      if (isJoin) {
        const outerR = r + 1;
        const innerR = Math.max(2, r - 3);
        content += '<circle class="join-dot" cx="' + cx + '" cy="' + y + '" r="' + outerR + '" fill="var(--vscode-editor-background)" stroke="' + commitColor + '" stroke-width="1.5"/>';
        content += '<circle class="join-dot" cx="' + cx + '" cy="' + y + '" r="' + innerR + '" fill="' + commitColor + '" stroke="none"/>';
      } else {
        content += '<circle class="dot" cx="' + cx + '" cy="' + y + '" r="' + r + '" fill="' + commitColor + '"/>';
      }
      if (isHead) {
        content += '<circle class="dot" cx="' + cx + '" cy="' + y + '" r="' + (r + 3) + '" fill="none" stroke="' + commitColor + '" stroke-width="1.5"/>';
      }
    }

    svg.innerHTML = content;
  }

  function headerCell(label, key) {
    return '<div data-column="' + key + '">' + label + '<span class="resize-handle" data-column="' + key + '"></span></div>';
  }

  function updateColumnWidths(items, startIndex) {
    const list = document.getElementById('commitList');
    if (!list) return;
    for (let i = startIndex; i < items.length; i++) {
      const commit = items[i];
      columnWidthChars.hash = Math.max(columnWidthChars.hash, String(commit.shortHash || '').length);
      const author = commit.authorEmail ? commit.author + ' <' + commit.authorEmail + '>' : commit.author;
      columnWidthChars.author = Math.max(columnWidthChars.author, String(author || '').length);
      columnWidthChars.date = Math.max(columnWidthChars.date, String(commit.authorDateLabel || '').length);
    }
    setColumnWidth(list, 'hash', Math.max(columnWidthChars.hash, 1) + 2 + 'ch');
    setColumnWidth(list, 'author', Math.max(columnWidthChars.author, 1) + 2 + 'ch');
    setColumnWidth(list, 'date', Math.max(columnWidthChars.date, 1) + 2 + 'ch');
  }

  function setColumnWidth(list, key, width, force) {
    if (force || columnWidths[key] === undefined) {
      columnWidths[key] = width;
    }
    const graph = document.getElementById('graph');
    if (graph) graph.style.setProperty('--' + key + '-width', columnWidths[key]);
    list.style.setProperty('--' + key + '-width', columnWidths[key]);
  }

  function applyColumnWidths() {
    const list = document.getElementById('commitList');
    const graph = document.getElementById('graph');
    for (const key in columnWidths) {
      if (graph) graph.style.setProperty('--' + key + '-width', columnWidths[key]);
      if (list) list.style.setProperty('--' + key + '-width', columnWidths[key]);
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
      const minimumWidths = { main: LANE_W + 170, author: 80, hash: 80, date: 100 };
      const width = Math.max(minimumWidths[resizing.key] || 40, resizing.startWidth + event.clientX - resizing.startX);
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
