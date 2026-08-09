import * as vscode from 'vscode';
import { ChangeSetMode, CommitFile, GitBranchOption, GitCommit, GitRepositoryOption, GraphState, WorkingTreeChanges, getCommitFiles, getCommitHashes, getFirstRepoPath, getGitCommitsByHashes, getGitRepositoryState, getWorkingTreeChanges, buildGraph, getGitBranches, getGitCommits, getGitRepositories, invalidateGitRefsCache, invalidateGitRepositoriesCache, runGitCommand, runGitSync, searchCommits } from './gitLogProvider';
import { CustomDiffPanel } from './customDiffPanel';

interface GitApiRepository {
    rootUri: vscode.Uri;
    state: { onDidChange: vscode.Event<void> };
}

interface GitApi {
    repositories: GitApiRepository[];
    onDidOpenRepository?: vscode.Event<GitApiRepository>;
    onDidCloseRepository?: vscode.Event<GitApiRepository>;
}

interface GitExtensionApi {
    getAPI(version: 1): GitApi;
}

interface RepositoryCommit extends GitCommit {
    repositoryPath: string;
}

const COMMIT_PAGE_SIZE = 100;
const COMMIT_PAGE_REQUEST_SIZE = COMMIT_PAGE_SIZE + 1;

const RefreshPriority = {
    RepositoryState: 1,
    Lifecycle: 2,
    RepositorySelection: 3,
} as const;

type RefreshPriorityValue = typeof RefreshPriority[keyof typeof RefreshPriority];

interface QueuedRefresh {
    priority: RefreshPriorityValue;
    skipSelectors: boolean;
    resolvers: Array<() => void>;
    rejecters: Array<(reason: unknown) => void>;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every(value => right.includes(value));
}

// Webview 视图提供器: 渲染 gitk 风格的提交图 (div flex 布局, 避免 table 高度塌陷)
export class GitkViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vscode-gitk.panelView';
    private view?: vscode.WebviewView;
    private commits: RepositoryCommit[] = [];
    private rawCommits: GitCommit[] = [];
    private graphState: GraphState = { activeLanes: [], visibleHashes: new Set(), nextColor: 0 };
    private allCommitHashes: string[] = [];
    private prefetchAbortController?: AbortController;
    private refreshAbortController?: AbortController;
    private searchAbortController?: AbortController;
    private commitFilesAbortController?: AbortController;
    private loadMoreAbortController?: AbortController;
    private prefetchPromise: Promise<GitCommit[]> | null = null;
    private prefetchGeneration = 0;
    private hasMoreCommits = false;
    private isLoadingMoreCommits = false;
    private readonly repositoryStateSignatures = new Map<string, string>();
    private commitPageGeneration = 0;
    private isLoading = true;
    private isFocused = false;
    private refreshInFlight?: Promise<void>;
    private refreshInFlightGeneration = 0;
    private refreshGeneration = 0;
    private refreshQueueRunning = false;
    private activeRefreshPriority = 0;
    private queuedRefresh?: QueuedRefresh;
    private repositoryRefreshDirty = false;
    private repositoryRefreshQueued = false;
    private repositoryStateDebounceTimer?: ReturnType<typeof setTimeout>;
    private lifecycleRefreshDirty = false;
    private lifecycleRefreshQueued = false;
    private lifecycleRefreshRequiresSelectorRefresh = false;
    private readonly pendingStateRefInvalidations = new Set<string>();
    private viewGeneration = 0;
    private initializingViewGeneration = 0;
    private gitLifecycleDisposables: vscode.Disposable[] = [];
    private viewDisposables: vscode.Disposable[] = [];
    private branchRefreshGeneration = 0;
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
    private selectedRepositoryPaths: string[] = [];
    private hasRepositorySelection = false;
    private selectedBranches: string[] = [];
    private hasBranchSelection = false;
    private currentRepositoryPath?: string;
    private repositoryStateSubscriptions: vscode.Disposable[] = [];
    private gitApi?: GitApi;
    private searchKeywords: string[] = [];
    private searchGeneration = 0;
    private searchBackupCommits: RepositoryCommit[] | null = null;
    private readonly customDiffPanel: CustomDiffPanel;

    private get selectedRepositoryPath(): string | undefined {
        return this.selectedRepositoryPaths.length === 1 ? this.selectedRepositoryPaths[0] : undefined;
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        this.customDiffPanel = new CustomDiffPanel(context, path => this.syncFileHighlightFromPath(path));
        context.subscriptions.push(
            this.onDidChangeDiffAvailabilityEmitter,
            this.customDiffPanel,
            new vscode.Disposable(() => {
                this.repositoryRefreshQueued = false;
                this.repositoryRefreshDirty = false;
                if (this.repositoryStateDebounceTimer) {
                    clearTimeout(this.repositoryStateDebounceTimer);
                    this.repositoryStateDebounceTimer = undefined;
                }
                this.pendingStateRefInvalidations.clear();
                this.lifecycleRefreshQueued = false;
                this.lifecycleRefreshDirty = false;
                this.lifecycleRefreshRequiresSelectorRefresh = false;
                this.resolveQueuedRefresh();
                this.cancelActiveRequests();
                this.repositoryStateSubscriptions.forEach(subscription => subscription.dispose());
                this.repositoryStateSubscriptions = [];
                this.gitLifecycleDisposables.forEach(disposable => disposable.dispose());
                this.gitLifecycleDisposables = [];
                this.viewDisposables.forEach(disposable => disposable.dispose());
                this.viewDisposables = [];
            }),
        );
    }

    canShowMultiDiff(): boolean {
        return !this.isLoading && this.view?.visible === true && !!this.currentHash;
    }

    isGitkLoading(): boolean {
        return this.isLoading;
    }

    async selectCommit(hash: string, repositoryPath?: string): Promise<void> {
        this.currentRepositoryPath = repositoryPath;
        this.currentChangeSet = 'commit';
        this.view?.webview.postMessage({ type: 'selectedCommit', hash, repositoryPath });
        this.commitFilesAbortController?.abort();
        const abortController = new AbortController();
        this.commitFilesAbortController = abortController;
        try {
            await this.setCommitFiles(hash, repositoryPath, abortController.signal);
        } catch (error: any) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.commitFilesAbortController === abortController) {
                this.commitFilesAbortController = undefined;
            }
        }
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

    private isAbortError(error: unknown): boolean {
        const candidate = error as { name?: string; code?: string } | undefined;
        return candidate?.name === 'AbortError' || candidate?.code === 'ABORT_ERR';
    }

    private cancelActiveRequests(): void {
        this.refreshAbortController?.abort();
        this.searchAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.loadMoreAbortController?.abort();
        this.invalidatePrefetch();
        this.refreshAbortController = undefined;
        this.searchAbortController = undefined;
        this.commitFilesAbortController = undefined;
        this.loadMoreAbortController = undefined;
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
        const viewGeneration = ++this.viewGeneration;
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };
        view.webview.html = this.getHtml();
        // 视图级订阅单独管理, onDidDispose 时一并释放, 避免反复创建累积泄漏
        this.viewDisposables.forEach(d => d.dispose());
        this.viewDisposables = [
            view.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            view.onDidChangeVisibility(() => {
                this.updateMultiDiffVisibility();
                if (!view.visible) {
                    this.invalidatePrefetch();
                }
            }),
            view.onDidDispose(() => {
                if (this.view === view) {
                    this.view = undefined;
                    ++this.viewGeneration;
                    this.repositoryRefreshQueued = false;
                    this.repositoryRefreshDirty = false;
                    if (this.repositoryStateDebounceTimer) {
                        clearTimeout(this.repositoryStateDebounceTimer);
                        this.repositoryStateDebounceTimer = undefined;
                    }
                    this.pendingStateRefInvalidations.clear();
                    this.lifecycleRefreshQueued = false;
                    this.lifecycleRefreshDirty = false;
                    this.lifecycleRefreshRequiresSelectorRefresh = false;
                    this.resolveQueuedRefresh();
                    this.cancelActiveRequests();
                    this.repositoryStateSubscriptions.forEach(subscription => subscription.dispose());
                    this.repositoryStateSubscriptions = [];
                    this.gitLifecycleDisposables.forEach(subscription => subscription.dispose());
                    this.gitLifecycleDisposables = [];
                    this.invalidatePrefetch();
                    this.refreshInFlight = undefined;
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
            await this.loadGitApi(viewGeneration);
            if (this.viewGeneration !== viewGeneration || !this.view) { return; }
            await this.refreshWithRetry(false, RefreshPriority.Lifecycle);
        } finally {
            if (this.initializingViewGeneration === viewGeneration) {
                this.initializingViewGeneration = 0;
                // 首轮完整刷新已覆盖 Git API 初始化中发现的仓库变化，无需再重复刷新。
                this.lifecycleRefreshQueued = false;
                this.lifecycleRefreshDirty = false;
                this.lifecycleRefreshRequiresSelectorRefresh = false;
            }
        }
    }

    private async loadGitApi(viewGeneration: number): Promise<void> {
        try {
            const extension = vscode.extensions.getExtension<GitExtensionApi>('vscode.git');
            if (!extension) { return; }
            const gitApi = extension.isActive
                ? extension.exports.getAPI(1)
                : (await extension.activate()).getAPI(1);
            if (this.viewGeneration !== viewGeneration || !this.view) { return; }
            this.gitApi = gitApi;
            this.gitLifecycleDisposables.forEach(disposable => disposable.dispose());
            this.gitLifecycleDisposables = [];
            const refreshRepositories = () => this.queueLifecycleRefresh(true);
            const refreshWorkspaceRepositories = () => {
                invalidateGitRepositoriesCache();
                this.queueLifecycleRefresh(true);
            };
            if (gitApi.onDidOpenRepository) {
                this.gitLifecycleDisposables.push(gitApi.onDidOpenRepository(refreshRepositories));
            }
            if (gitApi.onDidCloseRepository) {
                this.gitLifecycleDisposables.push(gitApi.onDidCloseRepository(refreshRepositories));
            }
            this.gitLifecycleDisposables.push(vscode.workspace.onDidChangeWorkspaceFolders(refreshWorkspaceRepositories));
            const gitmodulesWatcher = vscode.workspace.createFileSystemWatcher('**/.gitmodules');
            this.gitLifecycleDisposables.push(
                gitmodulesWatcher,
                gitmodulesWatcher.onDidCreate(refreshWorkspaceRepositories),
                gitmodulesWatcher.onDidChange(refreshWorkspaceRepositories),
                gitmodulesWatcher.onDidDelete(refreshWorkspaceRepositories),
            );
            this.updateRepositoryStateSubscriptions();
        } catch {
            // Git API 不可用时，状态快照仍会在手动刷新和已绑定监听的路径中保守处理。
        }
    }

    private queueLifecycleRefresh(requiresSelectorRefresh = false): void {
        this.lifecycleRefreshDirty = true;
        this.lifecycleRefreshRequiresSelectorRefresh ||= requiresSelectorRefresh;
        invalidateGitRefsCache();
        if (this.lifecycleRefreshQueued || this.initializingViewGeneration === this.viewGeneration) { return; }
        this.lifecycleRefreshQueued = true;
        void this.flushLifecycleRefresh();
    }

    private async flushLifecycleRefresh(): Promise<void> {
        try {
            while (this.lifecycleRefreshDirty) {
                this.lifecycleRefreshDirty = false;
                const requiresSelectorRefresh = this.lifecycleRefreshRequiresSelectorRefresh;
                this.lifecycleRefreshRequiresSelectorRefresh = false;
                if (requiresSelectorRefresh) {
                    const repositories = await getGitRepositories();
                    const repositoryPaths = repositories.map(repository => repository.path);
                    const currentRepositoryPaths = this.repositories.map(repository => repository.path);
                    if (sameStringSet(repositoryPaths, currentRepositoryPaths)) {
                        await this.refreshWithRetry(true, RefreshPriority.Lifecycle);
                    } else {
                        this.repositories = repositories;
                        await this.refreshWithRetry(false, RefreshPriority.Lifecycle);
                    }
                } else {
                    await this.refreshWithRetry(true, RefreshPriority.Lifecycle);
                }
                this.updateRepositoryStateSubscriptions();
            }
        } finally {
            this.lifecycleRefreshQueued = false;
            if (this.lifecycleRefreshDirty) {
                this.queueLifecycleRefresh(this.lifecycleRefreshRequiresSelectorRefresh);
            }
        }
    }

    // 统一调度刷新，仓库选择优先于生命周期与状态刷新。
    private refreshWithRetry(skipSelectorsOverride?: boolean, priority: RefreshPriorityValue = RefreshPriority.RepositoryState): Promise<void> {
        const skipSelectors = skipSelectorsOverride ?? this.hasBranchSelection;
        return this.queueRefresh(priority, skipSelectors);
    }

    private queueRefresh(priority: RefreshPriorityValue, skipSelectors: boolean): Promise<void> {
        ++this.refreshGeneration;
        this.refreshAbortController?.abort();
        this.searchAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.loadMoreAbortController?.abort();
        this.invalidatePrefetch();
        return new Promise<void>((resolve, reject) => {
            if (!this.queuedRefresh || priority > this.queuedRefresh.priority) {
                this.resolveQueuedRefresh();
                this.queuedRefresh = { priority, skipSelectors, resolvers: [resolve], rejecters: [reject] };
            } else {
                this.queuedRefresh.skipSelectors &&= skipSelectors;
                this.queuedRefresh.resolvers.push(resolve);
                this.queuedRefresh.rejecters.push(reject);
            }
            if (!this.refreshQueueRunning) {
                void this.flushRefreshQueue();
            }
        });
    }

    private resolveQueuedRefresh(): void {
        const queuedRefresh = this.queuedRefresh;
        this.queuedRefresh = undefined;
        queuedRefresh?.resolvers.forEach(resolve => resolve());
    }

    private isRefreshCurrent(generation: number): boolean {
        return generation === this.refreshGeneration && !!this.view;
    }

    private async flushRefreshQueue(): Promise<void> {
        this.refreshQueueRunning = true;
        try {
            while (this.queuedRefresh && this.view) {
                const queuedRefresh = this.queuedRefresh;
                this.queuedRefresh = undefined;
                this.activeRefreshPriority = queuedRefresh.priority;
                try {
                    await this.refresh(queuedRefresh.skipSelectors);
                    queuedRefresh.resolvers.forEach(resolve => resolve());
                } catch (error) {
                    queuedRefresh.rejecters.forEach(reject => reject(error));
                } finally {
                    this.activeRefreshPriority = 0;
                }
            }
        } finally {
            this.refreshQueueRunning = false;
            if (this.queuedRefresh && this.view) {
                void this.flushRefreshQueue();
            }
        }
    }

    // 刷新: 重新读取 git log 并更新 webview
    async refresh(skipSelectors = false): Promise<void> {
        // 只复用当前 generation 的请求；新仓库/Checkout 切换必须立即替换过期查询。
        if (this.refreshInFlight && this.refreshInFlightGeneration === this.refreshGeneration) {
            return this.refreshInFlight;
        }
        const generation = this.refreshGeneration;
        const abortController = new AbortController();
        this.refreshAbortController = abortController;
        const refreshPromise = this.refreshInternal(skipSelectors, abortController.signal);
        this.refreshInFlight = refreshPromise;
        this.refreshInFlightGeneration = generation;
        try {
            await refreshPromise;
        } catch (error) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.refreshAbortController === abortController) {
                this.refreshAbortController = undefined;
            }
            if (this.refreshInFlight === refreshPromise) {
                this.refreshInFlight = undefined;
                this.refreshInFlightGeneration = 0;
            }
        }
    }

    private async refreshIfChanged(): Promise<void> {
        try {
            if (this.repositoryStateSignatures.size === 0) {
                return this.refreshWithRetry(undefined, RefreshPriority.RepositoryState);
            }
            const nextSignatures = await this.getRepositoryStateSignatures();
            if (this.sameRepositoryStateSignatures(nextSignatures)) {
                this.view?.webview.postMessage({ type: 'refreshUnchanged' });
                return;
            }
            this.repositoryStateSignatures.clear();
            for (const [path, signature] of nextSignatures) {
                this.repositoryStateSignatures.set(path, signature);
            }
            return this.refreshWithRetry(undefined, RefreshPriority.RepositoryState);
        } catch {
            // 状态判断异常时回退全量刷新，避免错误跳过真实变化。
            return this.refreshWithRetry(undefined, RefreshPriority.RepositoryState);
        }
    }

    private async getRepositoryStateSignatures(signal?: AbortSignal): Promise<Map<string, string>> {
        const signatures = new Map<string, string>();
        await Promise.all(this.selectedRepositoryPaths.map(async repositoryPath => {
            try {
                const state = await getGitRepositoryState(vscode.Uri.parse(repositoryPath), signal);
                signatures.set(repositoryPath, `${state.head}\u0000${state.branch}\u0000${state.refs}\u0000${state.status}`);
            } catch (error) {
                if (this.isAbortError(error)) { throw error; }
                // 无法可靠读取状态时必须刷新，避免性能优化错误跳过真实变化。
                signatures.set(repositoryPath, `unavailable\u0000${Date.now()}\u0000${Math.random()}`);
            }
        }));
        return signatures;
    }

    private sameRepositoryStateSignatures(nextSignatures: Map<string, string>): boolean {
        if (nextSignatures.size !== this.repositoryStateSignatures.size) { return false; }
        for (const [path, signature] of nextSignatures) {
            if (this.repositoryStateSignatures.get(path) !== signature) { return false; }
        }
        return true;
    }

    private async updateRepositoryStateSignatures(signal?: AbortSignal): Promise<void> {
        const signatures = await this.getRepositoryStateSignatures(signal);
        this.repositoryStateSignatures.clear();
        for (const [path, signature] of signatures) {
            this.repositoryStateSignatures.set(path, signature);
        }
    }

    private updateRepositoryStateSubscriptions(): void {
        for (const subscription of this.repositoryStateSubscriptions) {
            subscription.dispose();
        }
        this.repositoryStateSubscriptions = [];
        if (!this.gitApi) { return; }
        for (const repository of this.gitApi.repositories) {
            const repositoryPath = vscode.Uri.file(repository.rootUri.fsPath).toString();
            if (!this.selectedRepositoryPaths.includes(repositoryPath) || !repository.state.onDidChange) { continue; }
            this.repositoryStateSubscriptions.push(repository.state.onDidChange(() => {
                this.pendingStateRefInvalidations.add(repository.rootUri.fsPath);
                this.queueRepositoryStateRefresh();
            }));
        }
    }

    private queueRepositoryStateRefresh(): void {
        // 当前刷新结束前会重新采集状态签名，初始化期间的状态事件无需额外启动一轮提交读取。
        if (this.isLoading) { return; }
        this.repositoryRefreshDirty = true;
        if (this.repositoryStateDebounceTimer) {
            clearTimeout(this.repositoryStateDebounceTimer);
        }
        this.repositoryStateDebounceTimer = setTimeout(() => {
            this.repositoryStateDebounceTimer = undefined;
            if (this.repositoryRefreshQueued) { return; }
            for (const repositoryPath of this.pendingStateRefInvalidations) {
                invalidateGitRefsCache(vscode.Uri.file(repositoryPath));
            }
            this.pendingStateRefInvalidations.clear();
            this.repositoryRefreshQueued = true;
            void this.flushRepositoryStateRefresh();
        }, 300);
    }

    private async flushRepositoryStateRefresh(): Promise<void> {
        try {
            while (this.repositoryRefreshDirty) {
                this.repositoryRefreshDirty = false;
                await this.refreshIfChanged();
            }
        } finally {
            this.repositoryRefreshQueued = false;
            if (this.repositoryRefreshDirty) {
                this.queueRepositoryStateRefresh();
            }
        }
    }

    private async loadRefreshDetails(rootUris: vscode.Uri[], refreshGen: number, commitPageGeneration: number, signal?: AbortSignal): Promise<void> {
        try {
            const [changesResults] = await Promise.all([
                Promise.allSettled(rootUris.map(rootUri => getWorkingTreeChanges(rootUri, signal))),
                this.updateRepositoryStateSignatures(signal),
            ]);
            if (signal?.aborted || refreshGen !== this.refreshGeneration || commitPageGeneration !== this.commitPageGeneration) { return; }
            this.updateRepositoryStateSubscriptions();
            if (rootUris.length !== 1) { return; }
            const changes = changesResults[0];
            if (changes.status !== 'fulfilled') { return; }
            this.stagedFiles = changes.value.staged;
            this.changeFiles = changes.value.changes;
            this.view?.webview.postMessage({
                type: 'workingTreeChanges',
                stagedCount: this.stagedFiles.length,
                changesCount: this.changeFiles.length,
            });
        } catch (error) {
            if (!this.isAbortError(error)) { console.error('无法补充仓库信息', error); }
        }
    }

    private async refreshInternal(skipSelectors = false, signal?: AbortSignal): Promise<void> {
        if (!this.view || signal?.aborted) { return; }
        const refreshGen = this.refreshGeneration;
        this.setLoading(true);
        // 1. 初始化环境
        if (!skipSelectors && !this.hasRepositorySelection) {
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'start', message: '初始化环境...', current: 0, total: 0 });
            const firstRepoPath = await getFirstRepoPath();
            if (refreshGen !== this.refreshGeneration) { return; }
            if (firstRepoPath) {
                this.selectedRepositoryPaths = [firstRepoPath];
            }
        }
        // 仓库发现仅在首次加载或明确全量刷新时执行；切换/提交操作只更新目标仓库分支。
        try {
            if (skipSelectors) {
                await this.refreshSelectedRepositoryBranches(signal);
            } else {
                await this.refreshSelectors(signal);
            }
        } catch (error) {
            if (refreshGen === this.refreshGeneration) {
                this.setLoading(false);
            }
            if (!this.isAbortError(error) && refreshGen === this.refreshGeneration) {
                this.view.webview.postMessage({
                    type: 'error',
                    message: `无法加载仓库或分支: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
            return;
        }
        if (refreshGen !== this.refreshGeneration) { return; }
        if (this.repositories.length === 0) {
            this.setLoading(false);
            this.view.webview.postMessage({ type: 'loading', message: '当前工作区未找到 Git 仓库' });
            return;
        }
        const rootUris = this.getSelectedRepositoryUris();
        if (rootUris.length === 0) {
            this.commits = [];
            this.rawCommits = [];
            this.allCommitHashes = [];
            this.invalidatePrefetch();
            this.hasMoreCommits = false;
            this.isLoadingMoreCommits = false;
            ++this.commitPageGeneration;
            this.stagedFiles = [];
            this.changeFiles = [];
            this.setLoading(false);
            this.view.webview.postMessage({ type: 'commits', commits: [], stagedCount: 0, changesCount: 0, totalCommits: 0 });
            return;
        }
        const totalRepos = rootUris.length;
        let commitProgress = 0;
        this.view?.webview.postMessage({
            type: 'loadingProgress',
            phase: 'commit',
            message: totalRepos === 1 ? '正在读取提交历史与工作区变更...' : `正在读取 ${totalRepos} 个仓库的提交历史与工作区变更...`,
            current: 0,
            total: 0,
        });
        const commitPageGeneration = ++this.commitPageGeneration;
        try {
            const isSingleRepository = rootUris.length === 1;
            // 首屏只依赖提交日志；工作区与状态信息在列表显示后再补充。
            const results = await Promise.allSettled(rootUris.map(async rootUri => {
                const refs = isSingleRepository && this.hasBranchSelection ? this.selectedBranches : [];
                const raw = await getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, refs, 0, (current, total) => {
                    if (totalRepos === 1) {
                        this.view?.webview.postMessage({
                            type: 'loadingProgress',
                            phase: 'commit',
                            message: current === 0 ? '正在解析分支指向的提交...' : '正在读取提交历史...',
                            current,
                            total,
                        });
                    }
                }, signal);
                commitProgress++;
                if (totalRepos > 1) {
                    this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: `已读取 ${commitProgress} / ${totalRepos} 个仓库的提交历史...`, current: commitProgress, total: totalRepos });
                }
                return { rootUri, raw };
            }));
            if (commitPageGeneration !== this.commitPageGeneration || refreshGen !== this.refreshGeneration) { return; }
            const successful = results.filter((result): result is PromiseFulfilledResult<{ rootUri: vscode.Uri; raw: GitCommit[] }> => result.status === 'fulfilled').map(result => result.value);
            this.rawCommits = isSingleRepository ? (successful[0]?.raw.slice(0, COMMIT_PAGE_SIZE) ?? []) : [];
            this.hasMoreCommits = isSingleRepository && (successful[0]?.raw.length ?? 0) > COMMIT_PAGE_SIZE;
            this.allCommitHashes = [];
            this.graphState = { activeLanes: [], visibleHashes: new Set(), nextColor: 0 };
            const commits = successful.flatMap(({ rootUri, raw }) => buildGraph(isSingleRepository ? raw.slice(0, COMMIT_PAGE_SIZE) : raw).map(commit => ({ ...commit, repositoryPath: rootUri.toString() })));
            if (commits.length === 0) {
                const failureMessages = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
                throw new Error(failureMessages[0] || '当前分支暂无可显示的提交');
            }
            this.commits = commits;
            this.stagedFiles = [];
            this.changeFiles = [];
            const selectedCommit = this.commits.find(commit => commit.hash === this.currentHash && commit.repositoryPath === this.currentRepositoryPath) ?? this.commits[0];
            this.view.webview.postMessage({ type: 'commits', commits: this.commits, stagedCount: 0, changesCount: 0, hasMoreCommits: this.hasMoreCommits, isLoadingMoreCommits: false, totalCommits: 0 });
            this.setLoading(false);
            if (selectedCommit) { void this.selectCommit(selectedCommit.hash, selectedCommit.repositoryPath); }
            void this.loadRefreshDetails(rootUris, refreshGen, commitPageGeneration, signal);
            // 后台预取全量 hash
            if (isSingleRepository) {
                const refs = this.hasBranchSelection ? this.selectedBranches : [];
                getCommitHashes(successful[0].rootUri, refs, 10000, signal).then(hashes => {
                    if (signal?.aborted || commitPageGeneration !== this.commitPageGeneration) { return; }
                    this.allCommitHashes = hashes;
                    this.hasMoreCommits = hashes.length > this.rawCommits.length;
                    this.view?.webview.postMessage({ type: 'commitPageState', hasMoreCommits: this.hasMoreCommits, isLoadingMoreCommits: false });
                    this.view?.webview.postMessage({ type: 'updateTotalCommits', totalCommits: hashes.length });
                    this.startPrefetch();
                }).catch(() => {});
            }
        } catch (error) {
            if (refreshGen === this.refreshGeneration) {
                this.setLoading(false);
            }
            if (!this.isAbortError(error) && refreshGen === this.refreshGeneration) {
                this.view.webview.postMessage({ type: 'loading', message: error instanceof Error ? error.message : '加载中, 请稍候...' });
            }
        }
    }

    private async refreshBranchCommits(): Promise<void> {
        this.refreshAbortController?.abort();
        this.searchAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.invalidatePrefetch();
        const abortController = new AbortController();
        this.refreshAbortController = abortController;
        const signal = abortController.signal;
        const rootUri = this.getRepoRootUri();
        if (!this.view || !rootUri || this.selectedRepositoryPaths.length !== 1) { return; }
        const generation = ++this.branchRefreshGeneration;
        this.setLoading(true);
        this.view.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: '正在按所选分支读取提交历史...', current: 0, total: 0 });
        try {
            const commitPageGeneration = ++this.commitPageGeneration;
            // 仅 git log 阻塞, getCommitHashes 后台异步
            const page = await (this.hasBranchSelection
                ? getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, this.selectedBranches, 0, (current, total) => {
                    this.view!.webview.postMessage({
                        type: 'loadingProgress',
                        phase: 'commit',
                        message: current === 0 ? '正在解析所选分支...' : '正在读取所选分支的提交历史...',
                        current,
                        total,
                    });
                }, signal)
                : Promise.resolve([]));
            if (generation !== this.branchRefreshGeneration || commitPageGeneration !== this.commitPageGeneration) { return; }
            this.rawCommits = page.slice(0, COMMIT_PAGE_SIZE);
            this.hasMoreCommits = page.length > COMMIT_PAGE_SIZE;
            this.allCommitHashes = [];
            this.isLoadingMoreCommits = false;
            this.graphState = { activeLanes: [], visibleHashes: new Set(), nextColor: 0 };
            this.commits = buildGraph(this.rawCommits, this.graphState).map(commit => ({ ...commit, repositoryPath: rootUri.toString() }));
            const selectedCommit = this.commits.find(commit => commit.hash === this.currentHash && commit.repositoryPath === this.currentRepositoryPath) ?? this.commits[0];
            this.view.webview.postMessage({
                type: 'commits',
                commits: this.commits,
                stagedCount: this.stagedFiles.length,
                changesCount: this.changeFiles.length,
                hasMoreCommits: this.hasMoreCommits,
                isLoadingMoreCommits: false,
                totalCommits: 0,
            });
            if (selectedCommit) {
                void this.selectCommit(selectedCommit.hash, selectedCommit.repositoryPath);
            }
            // 后台预取全量 hash
            if (this.hasBranchSelection) {
                getCommitHashes(rootUri, this.selectedBranches, 10000, signal).then(hashes => {
                    if (signal.aborted || generation !== this.branchRefreshGeneration || commitPageGeneration !== this.commitPageGeneration) { return; }
                    this.allCommitHashes = hashes;
                    this.hasMoreCommits = hashes.length > this.rawCommits.length;
                    this.view?.webview.postMessage({ type: 'commitPageState', hasMoreCommits: this.hasMoreCommits, isLoadingMoreCommits: false });
                    this.view?.webview.postMessage({ type: 'updateTotalCommits', totalCommits: hashes.length });
                    this.startPrefetch();
                }).catch(() => {});
            }
        } catch (error) {
            if (!this.isAbortError(error) && generation === this.branchRefreshGeneration) {
                this.view.webview.postMessage({ type: 'error', message: `无法刷新提交: ${error instanceof Error ? error.message : String(error)}` });
            }
        } finally {
            if (this.refreshAbortController === abortController) {
                this.refreshAbortController = undefined;
            }
            if (generation === this.branchRefreshGeneration) {
                this.setLoading(false);
            }
        }
    }

    private async loadMoreCommits(): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!this.view || !this.view.visible || !rootUri || this.selectedRepositoryPaths.length !== 1 || !this.hasBranchSelection || !this.hasMoreCommits || this.isLoadingMoreCommits) { return; }

        const generation = this.commitPageGeneration;
        const abortController = new AbortController();
        this.loadMoreAbortController = abortController;
        const signal = abortController.signal;
        const skip = this.rawCommits.length;
        this.isLoadingMoreCommits = true;
        this.view.webview.postMessage({ type: 'commitPageState', hasMoreCommits: true, isLoadingMoreCommits: true });
        try {
            let page: GitCommit[];
            // 优先用后台预取的数据 (无 git 进程等待)
            if (this.prefetchPromise) {
                page = await this.prefetchPromise;
                this.prefetchPromise = null;
                // 预取被失效或失败时回退
                if (page.length === 0 && this.allCommitHashes.length > skip) {
                    const pageHashes = this.allCommitHashes.slice(skip, skip + COMMIT_PAGE_REQUEST_SIZE);
                    page = await getGitCommitsByHashes(rootUri, pageHashes, signal);
                }
            } else if (this.allCommitHashes.length > skip) {
                const pageHashes = this.allCommitHashes.slice(skip, skip + COMMIT_PAGE_REQUEST_SIZE);
                page = await getGitCommitsByHashes(rootUri, pageHashes, signal);
            } else {
                page = await getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, this.selectedBranches, skip, undefined, signal);
            }
            if (signal.aborted || generation !== this.commitPageGeneration) { return; }
            const knownHashes = new Set(this.rawCommits.map(commit => commit.hash));
            const nextCommits = page.slice(0, COMMIT_PAGE_SIZE).filter(commit => !knownHashes.has(commit.hash));
            const prevCount = this.rawCommits.length;
            this.rawCommits.push(...nextCommits);
            this.hasMoreCommits = this.allCommitHashes.length > this.rawCommits.length || page.length > COMMIT_PAGE_SIZE;
            // 增量构建: 只处理新追加的提交
            buildGraph(this.rawCommits, this.graphState, prevCount);
            const newCommits = this.rawCommits.slice(prevCount).map(commit => ({ ...commit, repositoryPath: rootUri.toString() }));
            this.commits.push(...newCommits);
            // 只发送新提交, 避免全量序列化
            this.view.webview.postMessage({
                type: 'appendCommits',
                newCommits: newCommits,
                hasMoreCommits: this.hasMoreCommits,
                isLoadingMoreCommits: false,
            });
            // 预取下一页
            this.startPrefetch();
        } catch (error) {
            if (!this.isAbortError(error) && generation === this.commitPageGeneration) {
                this.view.webview.postMessage({
                    type: 'commitPageState',
                    hasMoreCommits: true,
                    isLoadingMoreCommits: false,
                    commitPageError: `无法加载更多提交: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        } finally {
            if (this.loadMoreAbortController === abortController) {
                this.loadMoreAbortController = undefined;
            }
            if (generation === this.commitPageGeneration) {
                this.isLoadingMoreCommits = false;
            }
        }
    }

    private async refreshSelectedRepositoryBranches(signal?: AbortSignal): Promise<void> {
        const generation = this.refreshGeneration;
        const repositoryPaths = [...this.selectedRepositoryPaths];
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '加载分支...', current: 0, total: 1 });
        const rootUri = this.getRepoRootUri();
        const branches = rootUri ? await getGitBranches(rootUri, signal) : [];
        if (signal?.aborted || !this.isRefreshCurrent(generation) || !sameStringSet(repositoryPaths, this.selectedRepositoryPaths)) { return; }
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '加载分支...', current: 1, total: 1 });
        this.branches = repositoryPaths.length === 1 ? branches : [];
        this.selectedBranches = this.selectedBranches.filter(name => this.branches.some(branch => branch.name === name));
        if (this.selectedBranches.length === 0) {
            this.selectedBranches = this.branches.map(branch => branch.name);
        }
        this.hasBranchSelection = true;
        this.view?.webview.postMessage({
            type: 'selectors',
            repositories: this.repositories,
            branches: this.branches,
            selectedRepositoryPaths: repositoryPaths,
            selectedBranches: this.selectedBranches,
            isMultiRepository: repositoryPaths.length !== 1,
        });
    }

    private async refreshSelectors(signal?: AbortSignal): Promise<void> {
        const generation = this.refreshGeneration;
        // 2. 初始化仓库 + 3. 扫描子模块 (getGitRepositories 内部投递进度)
        const repositories = await getGitRepositories((current, total, message) => {
            if (!signal?.aborted && this.isRefreshCurrent(generation)) {
                this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'repository', message: message || '初始化仓库...', current, total });
            }
        }, signal);
        if (signal?.aborted || !this.isRefreshCurrent(generation)) { return; }
        this.repositories = repositories;
        this.selectedRepositoryPaths = this.selectedRepositoryPaths.filter(path => this.repositories.some(repo => repo.path === path));
        if (!this.hasRepositorySelection && this.selectedRepositoryPaths.length === 0 && this.repositories[0]) {
            this.selectedRepositoryPaths = [this.repositories[0].path];
        }
        this.hasRepositorySelection = true;
        // 4. 加载分支
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '加载分支...', current: 0, total: 1 });
        const rootUri = this.getRepoRootUri();
        const branches = rootUri ? await getGitBranches(rootUri, signal) : [];
        if (signal?.aborted || !this.isRefreshCurrent(generation)) { return; }
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '加载分支...', current: 1, total: 1 });
        this.branches = this.selectedRepositoryPaths.length === 1 ? branches : [];
        this.selectedBranches = this.selectedBranches.filter(name => this.branches.some(branch => branch.name === name));
        if (!this.hasBranchSelection) {
            this.selectedBranches = this.branches.map(branch => branch.name);
            this.hasBranchSelection = true;
        }
        this.view?.webview.postMessage({
            type: 'selectors',
            repositories: this.repositories,
            branches: this.branches,
            selectedRepositoryPaths: this.selectedRepositoryPaths,
            selectedBranches: this.selectedBranches,
            isMultiRepository: this.selectedRepositoryPaths.length !== 1,
        });
    }

    private async performSearch(): Promise<void> {
        this.searchAbortController?.abort();
        const abortController = new AbortController();
        this.searchAbortController = abortController;
        const signal = abortController.signal;
        const gen = ++this.searchGeneration;
        const rootUri = this.getRepoRootUri();
        if (!rootUri || this.searchKeywords.length === 0) { return; }
        // 备份原始提交列表, 搜索清除时恢复
        if (this.searchBackupCommits === null) {
            this.searchBackupCommits = this.commits;
        }
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'search', message: '搜索提交...', current: 0, total: 0 });
        try {
            const refs = this.selectedBranches.length > 0 ? this.selectedBranches : [];
            const results = await searchCommits(rootUri, this.searchKeywords, refs, signal);
            if (signal.aborted || gen !== this.searchGeneration) { return; }
            const graphState: GraphState = { activeLanes: [], visibleHashes: new Set(), nextColor: 0 };
            this.commits = buildGraph(results, graphState).map(c => ({ ...c, repositoryPath: rootUri.toString() }));
            this.view?.webview.postMessage({
                type: 'commits',
                commits: this.commits,
                stagedCount: this.stagedFiles.length,
                changesCount: this.changeFiles.length,
                hasMoreCommits: false,
                isLoadingMoreCommits: false,
                isSearchResult: true,
                searchMatchCount: this.commits.length,
                totalCommits: this.commits.length,
            });
            // 搜索结果默认选中第一个
            const firstSearchResult = this.commits[0];
            if (firstSearchResult) {
                await this.selectCommit(firstSearchResult.hash, firstSearchResult.repositoryPath);
            }
        } catch (error) {
            if (this.isAbortError(error) || gen !== this.searchGeneration) { return; }
            this.view?.webview.postMessage({ type: 'error', message: `搜索失败: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            if (this.searchAbortController === abortController) {
                this.searchAbortController = undefined;
            }
        }
    }

    private async refreshSearchCleared(): Promise<void> {
        if (this.searchBackupCommits !== null) {
            this.commits = this.searchBackupCommits;
            this.searchBackupCommits = null;
        }
        this.view?.webview.postMessage({
            type: 'commits',
            commits: this.commits,
            stagedCount: this.stagedFiles.length,
            changesCount: this.changeFiles.length,
            hasMoreCommits: this.hasMoreCommits,
            isLoadingMoreCommits: false,
            isSearchResult: false,
            totalCommits: this.allCommitHashes.length,
        });
        // 清除搜索后默认选中第一个
        const firstCommit = this.commits[0];
        if (firstCommit) {
            await this.selectCommit(firstCommit.hash, firstCommit.repositoryPath);
        }
    }

    private getRepoRootUri(repositoryPath = this.currentRepositoryPath): vscode.Uri | undefined {
        const path = repositoryPath ?? this.selectedRepositoryPath;
        return path ? vscode.Uri.parse(path) : undefined;
    }

    private getSelectedRepositoryUris(): vscode.Uri[] {
        return this.selectedRepositoryPaths.map(path => vscode.Uri.parse(path));
    }

    private beginCommitReload(message: string): void {
        ++this.commitPageGeneration;
        this.loadMoreAbortController?.abort();
        this.searchAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.invalidatePrefetch();
        this.commits = [];
        this.rawCommits = [];
        this.allCommitHashes = [];
        this.graphState = { activeLanes: [], visibleHashes: new Set(), nextColor: 0 };
        this.hasMoreCommits = false;
        this.isLoadingMoreCommits = false;
        this.files = [];
        this.stagedFiles = [];
        this.changeFiles = [];
        this.currentHash = undefined;
        this.currentRepositoryPath = undefined;
        this.selectedPath = undefined;
        this.searchKeywords = [];
        this.searchGeneration++;
        this.searchBackupCommits = null;
        this.customDiffPanel.hide();
        this.view?.webview.postMessage({ type: 'commitsLoading', message });
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'start', message, current: 0, total: 0 });
        this.view?.webview.postMessage({ type: 'files', files: [], mode: this.displayMode, selectedPath: undefined });
    }

    // 后台预取下一页: 首页/加载更多完成后立即在后台获取下一批提交, 用户触发"加载更多"时数据已就绪
    private startPrefetch(): void {
        if (this.prefetchPromise) { return; }
        const rootUri = this.getRepoRootUri();
        if (!this.view?.visible || !rootUri || this.selectedRepositoryPaths.length !== 1 || !this.hasMoreCommits) { return; }
        const skip = this.rawCommits.length;
        if (skip === 0 || this.allCommitHashes.length <= skip) { return; }
        const generation = this.prefetchGeneration;
        const pageHashes = this.allCommitHashes.slice(skip, skip + COMMIT_PAGE_REQUEST_SIZE);
        const abortController = new AbortController();
        this.prefetchAbortController = abortController;
        this.prefetchPromise = getGitCommitsByHashes(rootUri, pageHashes, abortController.signal)
            .then(page => generation !== this.prefetchGeneration ? [] : page)
            .catch(() => [] as GitCommit[])
            .finally(() => {
                if (this.prefetchAbortController === abortController) {
                    this.prefetchAbortController = undefined;
                }
            });
    }

    private invalidatePrefetch(): void {
        this.prefetchAbortController?.abort();
        this.prefetchAbortController = undefined;
        this.prefetchPromise = null;
        ++this.prefetchGeneration;
    }

    private async selectRepositories(paths: string[]): Promise<void> {
        this.selectedRepositoryPaths = paths;
        this.hasRepositorySelection = true;
        this.selectedBranches = [];
        this.hasBranchSelection = false;
        this.updateRepositoryStateSubscriptions();
        this.view?.webview.postMessage({ type: 'branchesLoading' });
        this.beginCommitReload('正在加载...');
        // 下拉列表已含目标仓库；切换时只读取该仓库的分支与提交，避免重复扫描所有嵌套子模块。
        void this.refreshWithRetry(true, RefreshPriority.RepositorySelection);
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
                void this.refreshIfChanged();
                break;
            case 'selectRepositories':
                if (Array.isArray(msg.paths) && msg.paths.every((path: unknown) => typeof path === 'string' && this.repositories.some(repo => repo.path === path))) {
                    const paths = [...new Set(msg.paths as string[])];
                    if (paths.length === this.selectedRepositoryPaths.length && paths.every(path => this.selectedRepositoryPaths.includes(path))) { break; }
                    void this.selectRepositories(paths);
                }
                break;
            case 'selectBranches':
                if (Array.isArray(msg.names) && msg.names.every((name: unknown) => typeof name === 'string' && this.branches.some(branch => branch.name === name))) {
                    const names = [...new Set(msg.names as string[])];
                    if (names.length === this.selectedBranches.length && names.every(name => this.selectedBranches.includes(name))) { break; }
                    this.selectedBranches = names;
                    this.hasBranchSelection = names.length > 0;
                    this.beginCommitReload('正在加载...');
                    void this.refreshBranchCommits();
                }
                break;
            case 'loadMoreCommits':
                void this.loadMoreCommits();
                break;
            case 'gitSync':
                if (msg.action === 'fetch' || msg.action === 'pull' || msg.action === 'push') {
                    this.syncRepository(msg.action);
                }
                break;
            case 'commitAction':
                if (typeof msg.action === 'string' && typeof msg.hash === 'string' && typeof msg.repositoryPath === 'string') {
                    this.runCommitAction(msg.action, msg.hash, msg.repositoryPath);
                }
                break;
            case 'selectCommit':
                if (msg.hash === 'staged' || msg.hash === 'changes') {
                    void this.selectWorkingTreeChanges(msg.hash);
                } else if (typeof msg.hash === 'string' && typeof msg.repositoryPath === 'string') {
                    void this.selectCommit(msg.hash, msg.repositoryPath);
                }
                break;
            case 'selectFile':
                this.openDiff(msg.path);
                break;
            case 'toggleFilesMode':
                this.displayMode = this.displayMode === 'tree' ? 'flat' : 'tree';
                this.renderFiles();
                break;
            case 'search':
                if (typeof msg.keywords === 'string') {
                    const keywords = msg.keywords.trim().split(/\s+/).filter((k: string) => k.length > 0);
                    if (keywords.join('\0') === this.searchKeywords.join('\0')) { break; }
                    if (keywords.length === 0) {
                        this.searchKeywords = [];
                        this.searchGeneration++;
                        void this.refreshSearchCleared();
                    } else {
                        this.searchKeywords = keywords;
                        void this.performSearch();
                    }
                }
                break;
        }
    }

    private async runCommitAction(action: string, hash: string, repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        if (action === 'copyHash') {
            await vscode.env.clipboard.writeText(hash);
            void vscode.window.showInformationMessage('已复制提交 Hash');
            return;
        }
        let didMutateRepository = false;
        try {
            switch (action) {
                case 'addTag': {
                    const tagName = await vscode.window.showInputBox({ prompt: '输入新标签名称', validateInput: value => value.trim() ? undefined : '标签名称不能为空' });
                    if (!tagName) { return; }
                    await runGitCommand(rootUri, ['tag', '-a', tagName.trim(), hash, '-m', `Tag ${tagName.trim()}`]);
                    didMutateRepository = true;
                    break;
                }
                case 'createBranch': {
                    const branchName = await vscode.window.showInputBox({ prompt: '输入新分支名称', validateInput: value => value.trim() ? undefined : '分支名称不能为空' });
                    if (!branchName) { return; }
                    await runGitCommand(rootUri, ['branch', branchName.trim(), hash]);
                    didMutateRepository = true;
                    break;
                }
                case 'checkout':
                    await runGitCommand(rootUri, ['checkout', hash]);
                    didMutateRepository = true;
                    break;
                case 'cherryPick':
                    await runGitCommand(rootUri, ['cherry-pick', hash]);
                    didMutateRepository = true;
                    break;
                case 'revert':
                    await runGitCommand(rootUri, ['revert', '--no-edit', hash]);
                    didMutateRepository = true;
                    break;
                case 'drop':
                    await vscode.window.showWarningMessage('Drop 需要交互式 rebase，当前扩展不自动改写提交历史。', { modal: true });
                    return;
                case 'merge':
                    await runGitCommand(rootUri, ['merge', '--no-edit', hash]);
                    didMutateRepository = true;
                    break;
                case 'rebase':
                    await runGitCommand(rootUri, ['rebase', hash]);
                    didMutateRepository = true;
                    break;
                case 'reset': {
                    const choice = await vscode.window.showWarningMessage('将当前分支重置到所选提交。', { modal: true }, 'Soft', 'Mixed', 'Hard');
                    if (!choice) { return; }
                    await runGitCommand(rootUri, ['reset', `--${choice.toLowerCase()}`, hash]);
                    didMutateRepository = true;
                    break;
                }
                default:
                    return;
            }
            if (!didMutateRepository) { return; }
            invalidateGitRefsCache(rootUri);
            // 提交操作只影响当前仓库的 refs/HEAD，复用仓库列表，避免重新扫描所有子模块。
            await this.refreshWithRetry(true, RefreshPriority.Lifecycle);
        } catch (error) {
            void vscode.window.showErrorMessage(`Git 操作失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async syncRepository(action: 'fetch' | 'pull' | 'push'): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        try {
            await runGitSync(rootUri, action);
            vscode.window.showInformationMessage(`Git ${action} 完成`);
            invalidateGitRefsCache(rootUri);
            // 提交操作只影响当前仓库的 refs/HEAD，复用仓库列表，避免重新扫描所有子模块。
            await this.refreshWithRetry(true, RefreshPriority.Lifecycle);
        } catch (error) {
            vscode.window.showErrorMessage(`Git ${action} 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async setCommitFiles(hash: string, repositoryPath?: string, signal?: AbortSignal): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
            this.currentHash = hash;
            this.currentChangeSet = 'commit';
            this.selectedPath = undefined;
        this.files = [];
        this.view?.webview.postMessage({ type: 'filesLoading' });
        try {
            const files = await getCommitFiles(rootUri, hash, signal);
            if (signal?.aborted || this.currentHash !== hash || this.currentRepositoryPath !== repositoryPath) { return; }
            this.files = files;
            this.renderFiles();
            if (files.length > 0 && this.canShowMultiDiff()) {
                await this.openDiff();
            }
        } catch (error) {
            if (!this.isAbortError(error) && this.currentHash === hash) {
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
  .selector { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .selector-prefix { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .dropdown { position: relative; flex: 0 1 auto; min-width: 0; }
  #repositoryDropdown, #branchDropdown { width: 20ch; }
  .dropdown-current { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
  .dropdown-current:hover:not(:disabled), .dropdown.open .dropdown-current { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .dropdown-current:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-current:disabled { cursor: default; opacity: .6; }
  .dropdown-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repository-icon { display: inline-flex; flex: 0 0 auto; width: 16px; height: 16px; margin-right: 4px; vertical-align: -3px; color: var(--vscode-icon-foreground, currentColor); }
  .repository-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .repository-icon.has-submodules { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-icon-foreground, currentColor)); }
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
  #repositoryDropdown .dropdown-option, #branchDropdown .dropdown-option { display: flex; align-items: center; gap: 6px; }
  #repositoryDropdown .dropdown-option.selected::before, #branchDropdown .dropdown-option.selected::before { display: none; }
  #repositoryDropdown .dropdown-option input { display: none; }
  #branchDropdown .dropdown-option input { flex: 0 0 auto; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); }
  .dropdown-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 4px 2px 0; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
  .dropdown-actions button { padding: 2px 4px; color: var(--vscode-textLink-foreground); background: transparent; border: 0; cursor: pointer; font: inherit; font-size: 11px; }
  .dropdown-group { padding-bottom: 1px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; cursor: default; }
  .dropdown-empty { padding: 8px 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #toolbarActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .locator-icon { flex: 0 0 auto; width: 24px; height: 24px; }
  .toolbar-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; }
  .toolbar-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .toolbar-icon.refresh-unchanged { animation: refresh-unchanged 550ms ease-out; }
  @keyframes refresh-unchanged { 0%, 100% { color: var(--vscode-icon-foreground); } 45% { color: var(--vscode-descriptionForeground); } }
  #header .count { opacity: 0.7; font-size: 11px; white-space: nowrap; }
  #workspace { display: grid; grid-template-columns: minmax(180px, 1fr) 5px minmax(180px, 1fr); flex: 1; min-height: 0; }
  #graph { --graph-width: 30ch; --hash-width: max-content; --message-width: 60ch; --author-width: max-content; --date-width: max-content; min-width: 0; min-height: 0; overflow: auto; }
  #panelResizeHandle { cursor: col-resize; background: var(--vscode-panel-border); }
  #panelResizeHandle:hover, #panelResizeHandle.resizing { background: var(--vscode-focusBorder); }
  #filesSection { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  #filesHeader { height: 30px; padding: 0 10px; display: flex; align-items: center; flex: 0 0 auto; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-weight: 600; }
  #filesTitle { display: flex; align-items: center; min-width: 0; gap: 6px; white-space: nowrap; }
  #filesCommitHash { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 400; }
  #filesActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  #filesActions .action-group { display: flex; align-items: center; gap: 2px; }
  #filesActions .action-group + .action-group:not([hidden])::before { content: ''; display: inline-block; width: 1px; height: 14px; margin: 0 4px; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.3)); }
  #filesHeader [hidden] { display: none !important; }
  #filesHeader .toolbar-icon { width: 24px; height: 24px; border: 1px solid transparent; border-radius: 4px; transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease; }
  #filesHeader .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-toolbar-hoverOutline, transparent); }
  #filesHeader .toolbar-icon:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  #filesHeader .toolbar-icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #filesHeader .toolbar-icon svg { width: 16px; height: 16px; stroke-width: 1.5; }
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
  .commit-header, .commit-row { display: grid; grid-template-columns: var(--graph-width) var(--message-width) var(--author-width) var(--hash-width) var(--date-width); align-items: center; min-width: max-content; }
  .commit-header { position: sticky; top: 0; z-index: 1; height: 30px; margin: 0; padding: 0 10px; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-weight: 600; }
  .commit-row { min-height: 26px; height: auto; cursor: pointer; border-bottom: 1px solid transparent; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.expanded { align-items: start; }
  .commit-row.expanded .col-graph { grid-row: span 2; }
  .commit-description { display: none; grid-column: 2 / -1; grid-row: 2; padding: 0 5px 7px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); line-height: 17px; cursor: text; }
  .commit-row.expanded .commit-description { display: block; }
  .commit-description:empty { display: none; }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground, #094771); }
  .commit-row.located { animation: locate-commit 900ms ease-out; }
  @keyframes locate-commit { 0% { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; } 100% { outline-color: transparent; outline-offset: -4px; } }
  .commit-row.working-tree:hover { background: var(--vscode-list-hoverBackground); }
  .working-tree-label { color: var(--vscode-textLink-foreground); font-weight: 600; }
  .working-tree-count { color: var(--vscode-descriptionForeground); }
  .commit-header > div { position: relative; min-width: 0; padding: 5px 14px 5px 0; overflow: hidden; white-space: nowrap; text-align: left; }
  .commit-header .resize-handle { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
  .commit-header .resize-handle:hover { background: var(--vscode-focusBorder); }
  .col-graph, .col-hash, .col-message, .col-author, .col-date { min-width: 0; overflow: hidden; white-space: nowrap; padding: 0 5px; text-align: left; }
  .col-graph { display: flex; align-self: stretch; align-items: flex-start; justify-content: flex-start; padding-left: 0; overflow: hidden; }
  .graph-svg { flex: 0 0 auto; }
  .graph-ref { font-family: var(--vscode-editor-font-family, sans-serif); font-size: 12px; dominant-baseline: middle; }
  .col-message { text-overflow: ellipsis; }
  .col-hash { width: max-content; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85; color: var(--vscode-descriptionForeground, inherit); }
  .col-author, .col-date { width: max-content; text-overflow: clip; }
  .col-message { color: var(--vscode-foreground, inherit); }
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
    <button class="toolbar-icon" id="refreshBtn" title="刷新提交" aria-label="刷新提交"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6A5 5 0 1 0 13 10M13 2v4H9"/></svg></button>
    <div class="selector"><span class="selector-prefix">repo:</span><div class="dropdown" id="repositoryDropdown">
      <button class="dropdown-current" type="button" title="切换仓库或子仓库" aria-expanded="false" disabled><span class="dropdown-label">加载仓库...</span><span class="dropdown-chevron">⌄</span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选仓库" aria-label="筛选仓库"><div class="dropdown-options"></div></div>
    </div></div><button class="toolbar-icon locator-icon" id="locateCommitBtn" title="定位当前提交" aria-label="定位当前提交"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/></svg></button>
    <div class="selector" id="branchSelector"><span class="selector-prefix">branchs:</span><div class="dropdown" id="branchDropdown">
      <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label">加载分支...</span><span class="dropdown-chevron">⌄</span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选分支" aria-label="筛选分支"><div class="dropdown-options"></div><div class="dropdown-actions"><button type="button" class="select-all">全选</button><button type="button" class="clear-all">清空</button></div></div>
    </div></div>
    <div class="selector" id="searchBox"><svg id="searchIcon" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 .96-.96l3.04 3.03-1.06 1.06-2.94-3.13z"/></svg><input type="text" id="searchInput" placeholder="搜索提交..." title="输入关键词搜索, 支持作者/邮箱/消息/Hash/日期, 多个关键词用空格隔开, 回车开始搜索"><button id="searchClear" title="清除搜索">&times;</button></div>
    <span class="count" id="countLabel"></span>
    <div id="toolbarActions">
      <button class="toolbar-icon" id="fetchBtn" title="获取" aria-label="获取"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 0 1 9-3M12 2v3H9M8 5v7M5.5 9.5 8 12l2.5-2.5"/></svg></button>
      <button class="toolbar-icon" id="pullBtn" title="拉取" aria-label="拉取"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v8m0 0-2-2m2 2 2-2M12 13V5m0 0-2 2m2-2 2 2M4 5h5a3 3 0 0 1 3 3"/></svg></button>
      <button class="toolbar-icon" id="pushBtn" title="推送" aria-label="推送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 13V5m0 0-2 2m2-2 2 2M12 3v8m0 0-2-2m2 2 2-2M12 11H7a3 3 0 0 1-3-3"/></svg></button>
    </div>
  </div>
  <main id="workspace">
    <div id="graph">
      <div id="commitHeader" class="commit-header"><div>分支图</div><div>描述</div><div>作者</div><div>Commit ID</div><div>时间</div></div>
      <div id="loading">
        <div id="loadingText">加载中...</div>
        <div id="progressBar"><div id="progressBarFill"></div></div>
        <div id="progressStep"></div>
      </div>
      <div id="commitList" style="display:none;"></div>
      <div id="commitFooter" hidden></div>
    </div>
    <div id="panelResizeHandle" role="separator" aria-label="调整提交图与变更文件宽度" aria-orientation="vertical"></div>
    <section id="filesSection">
      <div id="filesHeader"><div id="filesTitle"><span>Changed Files</span><span id="filesCommitHash"></span><span class="action-group" aria-label="复制操作"><button class="toolbar-icon commit-action" data-action="copyHash" title="Copy Commit Hash to Clipboard" aria-label="Copy Commit Hash to Clipboard"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1"/><path d="M3 10.5v-7A1.5 1.5 0 0 1 4.5 2H10"/></svg></button></span></div><div id="filesActions"><div class="action-group" aria-label="提交操作"><button class="toolbar-icon commit-action" data-action="addTag" title="Add Tag..." aria-label="Add Tag"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.75 7.25 3h5.75v5.75L8.25 13.5 2.5 7.75Z"/><circle cx="10.25" cy="5.75" r=".75" fill="currentColor" stroke="none"/></svg></button><button class="toolbar-icon commit-action" data-action="createBranch" title="Create Branch..." aria-label="Create Branch"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 5.5c0 2.1 1.4 3.5 3.5 3.5H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="9" r="1.25"/></svg></button><button class="toolbar-icon commit-action" data-action="checkout" title="Checkout..." aria-label="Checkout"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v8m0 0-2-2m2 2 2-2M4 11h4.5A3.5 3.5 0 0 0 12 7.5V5"/><path d="m10 6 2-2 2 2"/></svg></button><button class="toolbar-icon commit-action" data-action="cherryPick" title="Cherry Pick..." aria-label="Cherry Pick"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.25"/><circle cx="12" cy="12" r="1.25"/><path d="M4 5.25v2.5A3.25 3.25 0 0 0 7.25 11H12M6 3h3"/></svg></button><button class="toolbar-icon commit-action" data-action="revert" title="Revert..." aria-label="Revert"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 3 6.5 5.5 9M3.5 6.5h6A3.5 3.5 0 1 1 6 10"/></svg></button><button class="toolbar-icon commit-action" data-action="drop" title="Drop..." aria-label="Drop"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 6.5v6h6v-6M7 8.5v2.5M9 8.5v2.5"/></svg></button></div><div class="action-group" aria-label="分支操作"><button class="toolbar-icon commit-action" data-action="merge" title="Merge into current branch..." aria-label="Merge into current branch"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 10c0-2.5 1.75-4 4.25-4H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="6" r="1.25"/></svg></button><button class="toolbar-icon commit-action" data-action="rebase" title="Rebase current branch on this Commit..." aria-label="Rebase current branch on this Commit"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h7M8.5 2 11 4 8.5 6M13 12H6M7.5 10 5 12l2.5 2"/></svg></button><button class="toolbar-icon commit-action" data-action="reset" title="Reset current branch to this Commit..." aria-label="Reset current branch to this Commit"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="5.5" width="8" height="8" rx="1"/><path d="M2.5 6A4.5 4.5 0 0 1 7 2.5h2M7 2.5l2 2-2 2"/></svg></button></div><div class="action-group"><button class="toolbar-icon" id="filesModeBtn" title="显示方式（当前：树状）" aria-label="显示方式"><svg viewBox="0 0 16 16" aria-hidden="true"><path id="filesModeIcon" d="M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6"/></svg></button></div></div></div>
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
  let selectedCommitHash = '';
  let selectedCommitRepositoryPath = '';
  let hasMoreCommits = false;
  let isLoadingMoreCommits = false;
  let commitPageError = '';
  let commitLoadObserver = null;
  let isSearchResult = false;
  let searchMatchCount = 0;
  let totalCommits = 0;
  const collapsedFolders = new Set();
  const columnWidths = {};
  const columnWidthChars = { hash: 0, author: 0, date: 0 };
  let resizing = null;
  let panelResizing = null;

    const ROW_H = 26;
    const LANE_W = 20;
    const expandedCommits = new Set();
  const DOT_R = 5;
  let graphViewportWidth = 0;
  // 增量渲染状态
  let currentMaxLane = 0;
  let currentGraphW = 280;
  const REF_GAP = 3 * 7;

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
  function showLoadingProgress(phase, message, current, total) {
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
    // 刷新进度不清空已渲染的提交。后续刷新若取消或失败，仍保留最后一次有效结果。
    if (commits.length === 0) {
      document.getElementById('progressBar').style.display = 'block';
      document.getElementById('loading').style.display = 'block';
      document.getElementById('commitList').style.display = 'none';
    }
  }
  document.getElementById('refreshBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('locateCommitBtn').addEventListener('click', function() {
    if (!selectedCommitHash) return;
    var row = document.querySelector('.commit-row.selected') || document.querySelector('.commit-row[data-hash="' + CSS.escape(selectedCommitHash) + '"]');
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('located');
      void row.offsetWidth;
      row.classList.add('located');
    }
  });
  document.addEventListener('animationend', function(event) {
    var target = event.target;
    if (target && target.classList && target.classList.contains('located')) target.classList.remove('located');
    if (target && target.id === 'refreshBtn') target.classList.remove('refresh-unchanged');
  });
  document.addEventListener('animationcancel', function(event) {
    var target = event.target;
    if (target && target.classList && target.classList.contains('located')) target.classList.remove('located');
    if (target && target.id === 'refreshBtn') target.classList.remove('refresh-unchanged');
  });
  ['fetch', 'pull', 'push'].forEach(function(action) {
    document.getElementById(action + 'Btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'gitSync', action: action });
    });
  });
  document.querySelectorAll('.commit-action').forEach(function(button) {
    button.addEventListener('click', function() {
      if (!selectedCommitHash || selectedCommitHash === 'changes' || selectedCommitHash === 'staged' || !selectedCommitRepositoryPath) return;
      vscode.postMessage({ type: 'commitAction', action: button.dataset.action, hash: selectedCommitHash, repositoryPath: selectedCommitRepositoryPath });
    });
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
    }, 300);
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

  const repositoryDropdown = createDropdown('repositoryDropdown', function() {});
  const branchDropdown = createDropdown('branchDropdown', function() {});

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
    } else if (msg.type === 'branchesLoading') {
      closeDropdown(branchDropdown);
      branchDropdown.current.disabled = true;
      branchDropdown.label.textContent = '加载分支...';
      branchDropdown.current.title = '加载分支...';
      branchDropdown.options.innerHTML = '';
    } else if (msg.type === 'commitsLoading') {
      commits = [];
      hasMoreCommits = false;
      isLoadingMoreCommits = false;
      commitPageError = '';
      selectedCommitHash = '';
      selectedCommitRepositoryPath = '';
      document.getElementById('commitList').innerHTML = '';
      document.getElementById('countLabel').textContent = '加载中...';
      renderCommitFooter();
      showLoadingProgress('start', msg.message || '正在读取提交历史...', 0, 0);
    } else if (msg.type === 'commits') {
      var previousCommits = commits;
      commits = msg.commits;
      stagedCount = Number(msg.stagedCount) || 0;
      changesCount = Number(msg.changesCount) || 0;
      hasMoreCommits = Boolean(msg.hasMoreCommits);
      isLoadingMoreCommits = Boolean(msg.isLoadingMoreCommits);
      commitPageError = '';
      currentMaxLane = 0;
      currentGraphW = 280;
      columnWidthChars.hash = 0;
      columnWidthChars.author = 0;
      columnWidthChars.date = 0;
      isSearchResult = Boolean(msg.isSearchResult);
      searchMatchCount = Number(msg.searchMatchCount) || 0;
      totalCommits = Number(msg.totalCommits) || 0;
      // 确保有且仅有一个选中: 如果当前选中的不在列表中, 默认选第一个
      var hasValidSelection = selectedCommitHash && commits.some(function(c) {
        return c.hash === selectedCommitHash && c.repositoryPath === selectedCommitRepositoryPath;
      });
      if (!hasValidSelection && commits.length > 0) {
        selectedCommitHash = commits[0].hash;
        selectedCommitRepositoryPath = commits[0].repositoryPath;
      }
      var listChanged = previousCommits.length !== commits.length || previousCommits.some(function(commit, index) {
        var nextCommit = commits[index];
        return !nextCommit || commit.hash !== nextCommit.hash || commit.repositoryPath !== nextCommit.repositoryPath;
      });
      if (listChanged) expandedCommits.clear();
      render();
    } else if (msg.type === 'appendCommits') {
      var prevCount = commits.length;
      commits.push.apply(commits, msg.newCommits || []);
      hasMoreCommits = Boolean(msg.hasMoreCommits);
      isLoadingMoreCommits = Boolean(msg.isLoadingMoreCommits);
      commitPageError = '';
      appendRows(prevCount);
    } else if (msg.type === 'commitPageState') {
      hasMoreCommits = Boolean(msg.hasMoreCommits);
      isLoadingMoreCommits = Boolean(msg.isLoadingMoreCommits);
      commitPageError = msg.commitPageError || '';
      renderCommitFooter();
    } else if (msg.type === 'updateTotalCommits') {
      totalCommits = Number(msg.totalCommits) || 0;
      updateCountLabel();
    } else if (msg.type === 'workingTreeChanges') {
      stagedCount = Number(msg.stagedCount) || 0;
      changesCount = Number(msg.changesCount) || 0;
      updateWorkingTreeRows();
    } else if (msg.type === 'loadingProgress') {
      showLoadingProgress(msg.phase || 'start', msg.message || '加载中...', msg.current, msg.total);
    } else if (msg.type === 'refreshUnchanged') {
      var refreshButton = document.getElementById('refreshBtn');
      if (refreshButton) {
        refreshButton.classList.remove('refresh-unchanged');
        void refreshButton.offsetWidth;
        refreshButton.classList.add('refresh-unchanged');
      }
    } else if (msg.type === 'refreshing') {
      showLoadingProgress('start', msg.message || '正在刷新...', 0, 0);
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
      selectedCommitHash = msg.hash || '';
      updateFilesCommitHash();
      selectedCommitRepositoryPath = msg.repositoryPath || '';
      selectedPath = '';
      render();
    } else if (msg.type === 'loading') {
      showLoadingProgress('start', msg.message || '加载中...', 0, 0);
    } else if (msg.type === 'error') {
      document.getElementById('loadingText').textContent = '错误: ' + msg.message;
      document.getElementById('progressBarFill').classList.remove('indeterminate');
      document.getElementById('progressBarFill').style.width = '0%';
      document.getElementById('progressStep').textContent = '';
      document.getElementById('loading').style.display = 'block';
      document.getElementById('commitList').style.display = 'none';
    }
  });

  function selectedLabel(entries, selectedValues, emptyLabel, allLabel) {
    const selected = new Set(selectedValues || []);
    const selectedEntries = entries.filter(function(entry) { return selected.has(entry.value); });
    if (entries.length > 0 && selectedEntries.length === entries.length) return allLabel;
    const label = selectedEntries.map(function(entry) { return entry.label; }).join(', ') || emptyLabel;
    return label.length > 20 ? label.slice(0, 20) + '...' : label;
  }

  function selectedTitle(entries, selectedValues, emptyLabel) {
    const selected = new Set(selectedValues || []);
    return entries.filter(function(entry) { return selected.has(entry.value); }).map(function(entry) { return entry.label; }).join(', ') || emptyLabel;
  }

  function repositoryIcon(hasSubmodules) {
    return hasSubmodules
      ? '<span class="repository-icon has-submodules" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/><rect x="5" y="7.5" width="6" height="3.5" rx="0.5"/></svg></span>'
      : '<span class="repository-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/></svg></span>';
  }
  function setRepositoryLabel(entry) {
    repositoryDropdown.label.innerHTML = entry ? repositoryIcon(entry.hasSubmodules) + escapeHtml(entry.label) : '未选择仓库';
    repositoryDropdown.current.title = entry ? (entry.title || entry.label) : '未选择仓库';
  }
  function renderRepositoryOptions(entries, selectedValues) {
    const selectedValue = (selectedValues || []).find(function(value) {
      return entries.some(function(entry) { return entry.value === value; });
    }) || '';
    repositoryDropdown.current.disabled = entries.length === 0;
    const selectedEntry = entries.find(function(entry) { return entry.value === selectedValue; });
    setRepositoryLabel(selectedEntry);
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
        setRepositoryLabel(entry);
        closeDropdown(repositoryDropdown);
        vscode.postMessage({ type: 'selectRepositories', paths: [entry.value] });
      });
      option.appendChild(radio);
      option.insertAdjacentHTML('beforeend', repositoryIcon(entry.hasSubmodules));
      option.appendChild(document.createTextNode(entry.label));
      repositoryDropdown.options.appendChild(option);
    });
  }

  function renderBranchOptions(entries, selectedValues) {
    const options = entries.filter(function(entry) { return !entry.group; });
    const selected = new Set(selectedValues || []);
    const hasSelection = selected.size > 0;
    branchDropdown.current.disabled = options.length === 0;
    branchDropdown.label.textContent = hasSelection ? selectedLabel(options, selected, '未选择分支', '全部分支') : '未选择分支';
    branchDropdown.current.title = hasSelection ? selectedTitle(options, selected, '未选择分支') : '未选择分支';
    branchDropdown.options.innerHTML = '';
    function applySelection(values) {
      selected.clear();
      values.forEach(function(value) { selected.add(value); });
      const showingAll = selected.size === 0;
      branchDropdown.label.textContent = showingAll ? '未选择分支' : selectedLabel(options, selected, '未选择分支', '全部分支');
      branchDropdown.current.title = showingAll ? '未选择分支' : selectedTitle(options, selected, '未选择分支');
      branchDropdown.options.querySelectorAll('input').forEach(function(checkbox) {
        checkbox.checked = selected.has(checkbox.value);
        checkbox.parentElement.classList.toggle('selected', checkbox.checked);
      });
      vscode.postMessage({ type: 'selectBranches', names: Array.from(selected) });
    }
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
        option.classList.toggle('selected', checkbox.checked);
        const hasSelection = selected.size > 0;
        branchDropdown.label.textContent = hasSelection ? selectedLabel(options, selected, '未选择分支', '全部分支') : '未选择分支';
        branchDropdown.current.title = hasSelection ? selectedTitle(options, selected, '未选择分支') : '未选择分支';
        vscode.postMessage({ type: 'selectBranches', names: Array.from(selected) });
      });
      option.appendChild(checkbox);
      option.appendChild(document.createTextNode(entry.label));
      branchDropdown.options.appendChild(option);
    });
    branchDropdown.menu.querySelector('.select-all').onclick = function() { applySelection(options.map(function(entry) { return entry.value; })); };
    branchDropdown.menu.querySelector('.clear-all').onclick = function() { applySelection([]); };
  }

  function renderSelectors(msg) {
    const repositories = msg.repositories || [];
    if (repositories.length > 0) {
      renderRepositoryOptions(repositories.map(function(repo) {
        return { value: repo.path, label: repo.label, title: repo.path, hasSubmodules: Boolean(repo.hasSubmodules) };
      }), msg.selectedRepositoryPaths || []);
    }
    const branches = msg.branches || [];
    branchDropdown.root.hidden = false;
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
    renderBranchOptions(branchEntries, msg.selectedBranches || []);
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

  function updateFilesCommitHash() {
    const isCommit = selectedCommitHash && selectedCommitHash !== 'changes' && selectedCommitHash !== 'staged';
    const hashLabel = document.getElementById('filesCommitHash');
    if (hashLabel) hashLabel.textContent = isCommit ? selectedCommitHash.slice(0, 8) : '';
    document.querySelectorAll('.commit-action').forEach(function(button) {
      button.hidden = !isCommit;
    });
    document.querySelectorAll('#filesTitle .action-group').forEach(function(group) {
      group.hidden = !isCommit;
    });
  }

  function renderFiles() {
    const list = document.getElementById('filesList');
    const modeButton = document.getElementById('filesModeBtn');
    const modeIcon = document.getElementById('filesModeIcon');
    const isTree = filesMode === 'tree';
    modeIcon.setAttribute('d', isTree ? 'M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6' : 'M3 4h10M3 8h10M3 12h10');
    modeButton.title = '显示方式（当前：' + (isTree ? '树状' : '平铺') + '）';
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

  function renderCommitFooter() {
    const footer = document.getElementById('commitFooter');
    if (!commits.length) {
      footer.hidden = true;
      if (commitLoadObserver) commitLoadObserver.disconnect();
      return;
    }
    footer.hidden = false;
    if (commitLoadObserver) commitLoadObserver.disconnect();
    if (isSearchResult) {
      footer.textContent = '找到 ' + commits.length + ' 条匹配';
      return;
    }
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
      commitLoadObserver = new IntersectionObserver(function(entries) {
        if (entries.some(function(entry) { return entry.isIntersecting; })) {
          vscode.postMessage({ type: 'loadMoreCommits' });
        }
      }, { root: document.getElementById('graph'), rootMargin: '0px 0px 800px 0px' });
      commitLoadObserver.observe(footer);
    }
  }

  // 全局: 计算行 ref 列起始 X
  function rowRefX(c) {
    var rowMaxLane = c.lane || 0;
    (c.lanes || []).forEach(function(l) {
      rowMaxLane = Math.max(rowMaxLane, l.fromLane, l.toLane);
    });
    return (rowMaxLane + 1) * LANE_W + 5 + REF_GAP;
  }

  // 构建单行提交 HTML
  function buildCommitRowHTML(i, graphW) {
    var c = commits[i];
    var commitKey = c.repositoryPath + ':' + c.hash;
    var expanded = expandedCommits.has(commitKey);
    var selected = selectedCommitHash === c.hash && selectedCommitRepositoryPath === c.repositoryPath;
    var html = '<div class="commit-row' + (expanded ? ' expanded' : '') + (selected ? ' selected' : '') + '" data-hash="' + escapeAttr(c.hash) + '" data-repository-path="' + escapeAttr(c.repositoryPath) + '" data-row="' + i + '" data-has-description="true">';
    var branchList = (c.refs || []).join(', ');
    html += '<div class="col-graph"' + (branchList ? ' title="' + escapeAttr(branchList) + '"' : '') + '><svg class="graph-svg" width="' + graphW + '" height="' + ROW_H + '" viewBox="0 0 ' + graphW + ' ' + ROW_H + '"></svg></div>';
    html += '<div class="col-message" title="' + escapeAttr(c.message) + '">' + escapeHtml(c.message) + '</div>';
    var authorPreview = c.authorEmail ? c.author + ' <' + c.authorEmail + '>' : c.author;
    html += '<div class="col-author" title="' + escapeAttr(authorPreview) + '">' + escapeHtml(authorPreview) + '</div>';
    html += '<div class="col-hash">' + escapeHtml(c.shortHash) + '</div>';
    html += '<div class="col-date" title="' + escapeAttr(c.authorDateLabel) + '">' + escapeHtml(c.authorDateLabel) + '</div>';
    var committerPreview = c.committerEmail ? c.committer + ' <' + c.committerEmail + '>' : c.committer;
    var parentList = (c.parents || []).join(' ');
    var commitDate = c.authorDate ? new Date(c.authorDate).toString() : c.authorDateLabel;
    var description = [
      'Commit: ' + c.hash,
      'Parents: ' + parentList,
      'Author: ' + authorPreview,
      'Committer: ' + committerPreview,
      'Date: ' + commitDate,
      '',
      c.message,
      c.body || '',
    ].filter(function(line, index) {
      return line || index < 7;
    }).join('\\n');
    html += '<div class="commit-description">' + escapeHtml(description) + '</div>';
    html += '</div>';
    return html;
  }

  // 为单行设置 SVG 和点击监听

  function setupRow(row, graphW) {
    var svg = row.querySelector('svg');
    if (svg) {
      var idx = Number(row.getAttribute('data-row'));
      svg.setAttribute('height', String(ROW_H));
      svg.setAttribute('viewBox', '0 0 ' + graphW + ' ' + ROW_H);
      drawSvg(svg, idx, graphW, ROW_H, LANE_W, DOT_R, rowRefX(commits[idx]));
    }
    row.addEventListener('click', function(event) {
      if (event.target && event.target.closest('.commit-description')) return;
      var hash = row.getAttribute('data-hash');
      var repositoryPath = row.getAttribute('data-repository-path');
      var commitKey = repositoryPath + ':' + hash;
      var wasSelected = row.classList.contains('selected');
      var wasExpanded = expandedCommits.has(commitKey);
      // 收起所有描述, 清除所有高亮
      expandedCommits.clear();
      document.querySelectorAll('.commit-row').forEach(function(r) { r.classList.remove('selected'); });
      row.classList.add('selected');
      selectedCommitHash = hash;
      updateFilesCommitHash();
      // 工作区行 (无描述)
      if (!hash || !repositoryPath || row.dataset.hasDescription !== 'true') {
        if (hash === 'changes' || hash === 'staged') {
          vscode.postMessage({ type: 'selectCommit', hash: hash });
        } else if (hash && repositoryPath) {
          selectedCommitRepositoryPath = repositoryPath;
          vscode.postMessage({ type: 'selectCommit', hash: hash, repositoryPath: repositoryPath });
        }
        updateCountLabel();
        render();
        return;
      }
      // 提交行: 已高亮且未展开 → 展开; 否则仅选中 (收起)
      if (wasSelected && !wasExpanded) {
        expandedCommits.add(commitKey);
      }
      selectedCommitRepositoryPath = repositoryPath;
      if (!wasSelected) {
        vscode.postMessage({ type: 'selectCommit', hash: hash, repositoryPath: repositoryPath });
      }
      updateCountLabel();
      render();
    });
  }

  // 计算 maxLane (从 startIndex 起, 与 currentMaxLane 取大)
  function calcMaxLane(startIndex) {
    var maxLane = startIndex > 0 ? currentMaxLane : 0;
    for (var i = startIndex; i < commits.length; i++) {
      var c = commits[i];
      if (c.lane > maxLane) maxLane = c.lane;
      if (c.lanes) for (var j = 0; j < c.lanes.length; j++) {
        var l = c.lanes[j];
        if (l.fromLane > maxLane) maxLane = l.fromLane;
        if (l.toLane > maxLane) maxLane = l.toLane;
      }
    }
    return maxLane;
  }

  // 计算最宽 ref 行宽
  function calcWidestRefRow(naturalGraphW) {
    return commits.reduce(function(width, c) {
      if (!c.refs || c.refs.length === 0) return width;
      var labelsWidth = c.refs.reduce(function(total, ref) {
        var label = ref.length > 18 ? ref.slice(0, 17) + '…' : ref;
        return total + Math.max(30, label.length * 7 + 12) + 4;
      }, 0);
      return Math.max(width, rowRefX(c) + labelsWidth + 8);
    }, naturalGraphW);
  }

  function updateCountLabel() {
    var label = document.getElementById('countLabel');
    if (isSearchResult) {
      label.textContent = '搜索: ' + commits.length + ' 条匹配';
      return;
    }
    var total = totalCommits || commits.length;
    if (selectedCommitHash && selectedCommitHash !== 'changes' && selectedCommitHash !== 'staged') {
      var idx = commits.findIndex(function(c) { return c.hash === selectedCommitHash; });
      if (idx >= 0) {
        label.textContent = (idx + 1) + '/' + total + ' 条提交';
        return;
      }
    }
    label.textContent = '—/' + total + ' 条提交';
  }

  function workingTreeRowHTML(hash, label, count) {
    const selected = selectedCommitHash === hash ? ' selected' : '';
    return '<div class="commit-row working-tree' + selected + '" data-hash="' + hash + '">' +
      '<div class="col-graph"></div><div class="col-message working-tree-label">' + label + '</div>' +
      '<div class="col-author working-tree-count">' + count + ' 个文件</div><div class="col-hash">—</div><div class="col-date"></div></div>';
  }

  function updateWorkingTreeRows() {
    const list = document.getElementById('commitList');
    if (!list || commits.length === 0) return;
    list.querySelectorAll('.working-tree').forEach(function(row) { row.remove(); });
    let html = '';
    if (changesCount > 0) html += workingTreeRowHTML('changes', 'Changes', changesCount);
    if (stagedCount > 0) html += workingTreeRowHTML('staged', 'Staged Changes', stagedCount);
    if (!html) return;
    list.insertAdjacentHTML('afterbegin', html);
    list.querySelectorAll('.working-tree').forEach(function(row) { setupRow(row, currentGraphW); });
  }

  function render() {
    const graph = document.getElementById('graph');
    const scrollTop = graph ? graph.scrollTop : 0;
    const list = document.getElementById('commitList');
    const loading = document.getElementById('loading');
    if (commits.length === 0) {
      document.getElementById('loadingText').textContent = '无提交记录';
      document.getElementById('progressBarFill').classList.remove('indeterminate');
      document.getElementById('progressBarFill').style.width = '0%';
      document.getElementById('progressStep').textContent = '';
      loading.style.display = 'block';
      list.style.display = 'none';
      renderCommitFooter();
      return;
    }
    loading.style.display = 'none';
    list.style.display = 'block';

    var maxLane = calcMaxLane(0);
    currentMaxLane = maxLane;
    var naturalGraphW = (maxLane + 1) * LANE_W + 10;
    var widestRefRow = calcWidestRefRow(naturalGraphW);
    graphViewportWidth = graph ? graph.clientWidth : 0;
    var graphW = Math.max(widestRefRow, 280);
    currentGraphW = graphW;
    var graphColumnW = 'max(30ch, ' + naturalGraphW + 'px)';
    document.getElementById('commitHeader').innerHTML =
      headerCell('分支图', 'graph') + headerCell('描述', 'message') +
      headerCell('作者', 'author') + headerCell('Commit ID', 'hash') + headerCell('时间', 'date');
    var html = '';
    function workingTreeRow(hash, label, count) {
      const selected = selectedCommitHash === hash ? ' selected' : '';
      return '<div class="commit-row working-tree' + selected + '" data-hash="' + hash + '">' +
        '<div class="col-graph"></div><div class="col-message working-tree-label">' + label + '</div>' +
        '<div class="col-author working-tree-count">' + count + ' 个文件</div><div class="col-hash">—</div><div class="col-date"></div></div>';
    }
    if (changesCount > 0) html += workingTreeRow('changes', 'Changes', changesCount);
    if (stagedCount > 0) html += workingTreeRow('staged', 'Staged Changes', stagedCount);
    for (let i = 0; i < commits.length; i++) {
      html += buildCommitRowHTML(i, graphW);
    }
    setColumnWidth(list, 'graph', graphColumnW);
    setColumnWidth(list, 'message', '60ch');
    updateColumnWidths(commits, 0);
    list.innerHTML = html;

    var rows = list.querySelectorAll('.commit-row');
    rows.forEach(function(row) {
      setupRow(row, graphW);
    });

    updateCountLabel();
    renderCommitFooter();
    if (graph) graph.scrollTop = scrollTop;
  }

  // 增量追加行: 只构建/渲染新行, maxLane 或 graphW 变化时回退全量 render
  function appendRows(startIndex) {
    var list = document.getElementById('commitList');
    var newMaxLane = calcMaxLane(startIndex);
    if (newMaxLane > currentMaxLane) {
      currentMaxLane = newMaxLane;
      render();
      return;
    }
    var naturalGraphW = (currentMaxLane + 1) * LANE_W + 10;
    var newGraphW = Math.max(calcWidestRefRow(naturalGraphW), 280);
    if (newGraphW > currentGraphW) {
      currentGraphW = newGraphW;
      render();
      return;
    }
    // 增量: 只构建新行
    var html = '';
    for (var i = startIndex; i < commits.length; i++) {
      html += buildCommitRowHTML(i, currentGraphW);
    }
    var beforeCount = list.children.length;
    list.insertAdjacentHTML('beforeend', html);
    var newCount = commits.length - startIndex;
    for (var j = 0; j < newCount; j++) {
      var row = list.children[beforeCount + j];
      if (row) setupRow(row, currentGraphW);
    }
    // 列宽可能因新提交增宽；仅扫描本批新增提交。
    updateColumnWidths(commits, startIndex);
    updateCountLabel();
    renderCommitFooter();
  }

  function drawSvg(svg, idx, graphW, rowH, laneW, dotR, refColumnX) {
    const c = commits[idx];
    const expanded = expandedCommits.has(c.repositoryPath + ':' + c.hash);
    const svgH = expanded ? svg.closest('.commit-row').getBoundingClientRect().height : rowH;
    const y = rowH / 2;
    const detailsBottom = Math.max(rowH, svgH - 1);
    svg.setAttribute('height', String(svgH));
    svg.setAttribute('viewBox', '0 0 ' + graphW + ' ' + svgH);
    let content = '';

    const cx = c.lane === undefined ? undefined : c.lane * laneW + laneW / 2 + 5;
    const commitColor = c.laneColor || (c.lanes && c.lanes.length > 0 ? c.lanes[0].color : '#888');
    if (c.lanes) {
      for (const l of c.lanes) {
        if (l.isCommit) { continue; }
        const x1 = l.fromLane * laneW + laneW / 2 + 5;
        const x2 = l.toLane * laneW + laneW / 2 + 5;
        if (l.fromLane === c.lane && cx !== undefined) {
          if (x1 === x2) {
            content += '<line x1="' + cx + '" y1="' + y + '" x2="' + x2 + '" y2="' + detailsBottom + '" stroke="' + l.color + '" stroke-width="1.5"/>';
          } else {
            const curveHeight = detailsBottom - y;
            content += '<path d="M' + cx + ',' + y + ' C' + cx + ',' + (y + curveHeight * 0.35) + ' ' + x2 + ',' + (y + curveHeight * 0.65) + ' ' + x2 + ',' + detailsBottom + '" fill="none" stroke="' + l.color + '" stroke-width="1.5"/>';
          }
        } else if (x1 === x2) {
          content += '<line x1="' + x1 + '" y1="0" x2="' + x2 + '" y2="' + detailsBottom + '" stroke="' + l.color + '" stroke-width="1.5"/>';
        } else {
          content += '<path d="M' + x1 + ',0 C' + x1 + ',' + (detailsBottom * 0.45) + ' ' + x2 + ',' + (detailsBottom * 0.55) + ' ' + x2 + ',' + detailsBottom + '" fill="none" stroke="' + l.color + '" stroke-width="1.5"/>';
        }
      }
    }

    if (cx !== undefined) {
      if (!c.laneStartsHere) {
        content += '<line x1="' + cx + '" y1="0" x2="' + cx + '" y2="' + y + '" stroke="' + commitColor + '" stroke-width="1.5"/>';
      }
      if (c.refs && c.refs.length > 0) {
        const lineStart = cx + dotR;
        let refX = refColumnX;
        const labels = c.refs.map(function(ref) {
          const label = ref.length > 18 ? ref.slice(0, 17) + '…' : ref;
          return { ref: ref, label: label, width: Math.max(30, label.length * 7 + 12) };
        });
        content += '<line x1="' + lineStart + '" y1="' + y + '" x2="' + (refX - 5) + '" y2="' + y + '" stroke="' + commitColor + '" stroke-width="1.5"/>';
        for (const item of labels) {
          content += '<rect x="' + refX + '" y="4" width="' + item.width + '" height="18" rx="5" ry="5" fill="' + commitColor + '"/>';
          content += '<text class="graph-ref" x="' + (refX + 6) + '" y="' + y + '" fill="var(--vscode-editor-background)" title="' + escapeAttr(item.ref) + '">' + escapeHtml(item.label) + '</text>';
          refX += item.width + 4;
        }
      }
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
      const minimumWidths = { graph: 120, message: 160, author: 80, hash: 80, date: 100 };
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
