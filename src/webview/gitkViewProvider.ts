import * as vscode from 'vscode';
import type { ChangeSetMode, ChangedFile, CommitFile, GitBranchOption, GitBranchVirtualCommit, GitCommit, GitkIntent, GitRepositoryOption, RepositoryCommit } from '../types';
import { getCommitFilesWithLineStats, getWorkingTreeChanges, buildGraph, getCurrentGitHeadHash, getGitBranches, getGitCommits, getGitRepositories, invalidateGitRefsCache, invalidateGitRepositoriesCache, searchCommits } from '../git/gitLogProvider';
import { CustomDiffPanel } from './customDiffPanel';
import { DiffReader } from '../git/diffReader';
import { GitActionRunner } from '../services/gitActions';
import { store, type StoreEffect } from '../state/store';

const COMMIT_PAGE_SIZE = 100;
const COMMIT_PAGE_REQUEST_SIZE = COMMIT_PAGE_SIZE + 1;
const VIRTUAL_STAGED_HASH = 'staged';
const VIRTUAL_CHANGES_HASH = 'changes';

// Webview 视图提供器: 渲染 gitk 风格的提交图 (div flex 布局, 避免 table 高度塌陷)
export class GitkViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vscode-gitk.panelView';
    private view?: vscode.WebviewView;
    // 异步控制 / 内部状态 (不存入 Store)
    private refreshAbortController?: AbortController;
    private searchAbortController?: AbortController;
    private commitFilesAbortController?: AbortController;
    private commitFilesGeneration = 0;
    private loadMoreAbortController?: AbortController;
    private commitPageGeneration = 0;
    private refreshGeneration = 0;
    private viewGeneration = 0;
    private initializingViewGeneration = 0;
    private viewDisposables: vscode.Disposable[] = [];
    private readonly onDidChangeDiffAvailabilityEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDiffAvailability = this.onDidChangeDiffAvailabilityEmitter.event;
    private repositoryStateDebounceTimer?: ReturnType<typeof setTimeout>;
    private headChangeDebounceTimer?: ReturnType<typeof setTimeout>;
    private searchGeneration = 0;
    private storeUnsubscribe?: () => void;
    private pushStatePending = false;
    private gitWatchDisposables: vscode.Disposable[] = [];
    private readonly customDiffPanel: CustomDiffPanel;
    private readonly diffReader: DiffReader;
    private readonly gitActions: GitActionRunner;

    // 单一数据源: 所有业务数据存入 Store, getter/setter 直接读写
    private get commits(): RepositoryCommit[] { return store.getState().commits; }
    private set commits(value: RepositoryCommit[]) { store.setState({ commits: value }); }
    private get rawCommits(): GitCommit[] { return store.getState().rawCommits; }
    private set rawCommits(value: GitCommit[]) { store.setState({ rawCommits: value }); }
    private get hasMoreCommits(): boolean { return store.getState().hasMoreCommits; }
    private set hasMoreCommits(value: boolean) { store.setState({ hasMoreCommits: value }); }
    private get isLoadingMoreCommits(): boolean { return store.getState().isLoadingMoreCommits; }
    private set isLoadingMoreCommits(value: boolean) { store.setState({ isLoadingMoreCommits: value }); }
    private get commitPageError(): string { return store.getState().commitPageError; }
    private set commitPageError(value: string) { store.setState({ commitPageError: value }); }
    private get isLoading(): boolean { return store.getState().isLoading; }
    private set isLoading(value: boolean) { store.setState({ isLoading: value }); }
    private get loadingMessage(): string | undefined { return store.getState().loadingMessage; }
    private set loadingMessage(value: string | undefined) { store.setState({ loadingMessage: value }); }
    private get files(): ChangedFile[] { return store.getState().files; }
    private set files(value: ChangedFile[]) { store.setState({ files: value }); }
    private get filesLoading(): boolean { return store.getState().filesLoading; }
    private set filesLoading(value: boolean) { store.setState({ filesLoading: value }); }
    private get currentHash(): string | undefined { return store.getState().currentHash; }
    private set currentHash(value: string | undefined) { store.setState({ currentHash: value }); }
    private get currentChangeSet(): ChangeSetMode { return store.getState().currentChangeSet; }
    private set currentChangeSet(value: ChangeSetMode) { store.setState({ currentChangeSet: value }); }
    private get stagedFiles(): CommitFile[] { return store.getState().stagedFiles; }
    private set stagedFiles(value: CommitFile[]) { store.setState({ stagedFiles: value }); }
    private get changeFiles(): CommitFile[] { return store.getState().changeFiles; }
    private set changeFiles(value: CommitFile[]) { store.setState({ changeFiles: value }); }
    private get displayMode(): 'tree' | 'flat' { return store.getState().displayMode; }
    private set displayMode(value: 'tree' | 'flat') { store.setState({ displayMode: value }); }
    private get selectedPath(): string | undefined { return store.getState().selectedPath; }
    private set selectedPath(value: string | undefined) { store.setState({ selectedPath: value }); }
    private get repositories(): GitRepositoryOption[] { return store.getState().repositories; }
    private set repositories(value: GitRepositoryOption[]) { store.setState({ repositories: value }); }
    private get branches(): GitBranchOption[] { return store.getState().branches; }
    private set branches(value: GitBranchOption[]) { store.setState({ branches: value }); }
    private get selectedRepositoryPaths(): string[] { return store.getState().selectedRepositoryPaths; }
    private set selectedRepositoryPaths(value: string[]) { store.setState({ selectedRepositoryPaths: value }); }
    private get hasRepositorySelection(): boolean { return store.getState().hasRepositorySelection; }
    private set hasRepositorySelection(value: boolean) { store.setState({ hasRepositorySelection: value }); }
    private get selectedBranches(): string[] { return store.getState().selectedBranches; }
    private set selectedBranches(value: string[]) { store.setState({ selectedBranches: value }); }
    private get hasBranchSelection(): boolean { return store.getState().hasBranchSelection; }
    private set hasBranchSelection(value: boolean) { store.setState({ hasBranchSelection: value }); }
    private get currentRepositoryPath(): string | undefined { return store.getState().currentRepositoryPath; }
    private set currentRepositoryPath(value: string | undefined) { store.setState({ currentRepositoryPath: value }); }
    private get searchKeywords(): string[] { return store.getState().searchKeywords; }
    private set searchKeywords(value: string[]) { store.setState({ searchKeywords: value }); }
    private updateViewVisible(): void { store.setState({ isViewVisible: this.view?.visible === true }); }

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
        this.view.webview.postMessage({
            type: 'stateUpdate',
            state: {
                commits: s.commits,
                stagedCount: s.stagedFiles.length,
                changesCount: s.changeFiles.length,
                hasMoreCommits: s.hasMoreCommits,
                isLoadingMoreCommits: s.isLoadingMoreCommits,
                commitPageError: s.commitPageError,
                repositories: s.repositories,
                branches: s.branches,
                selectedRepositoryPaths: s.selectedRepositoryPaths,
                selectedBranches: s.selectedBranches,
                isMultiRepository: s.selectedRepositoryPaths.length > 1,
                files,
                filesLoading: s.filesLoading,
                diffLoading: s.diffLoading,
                diffProgress: s.diffProgress,
                filesMode: s.displayMode,
                selectedPath: s.selectedPath,
                selectedCommit: s.currentHash ? {
                    hash: s.currentHash,
                    repositoryPath: s.currentRepositoryPath ?? '',
                } : null,
                isLoading: s.isLoading,
                loadingMessage: s.loadingMessage,
                reposLoading: s.reposLoading,
                branchesLoading: s.branchesLoading,
            },
        });
    }

    private get selectedRepositoryPath(): string | undefined {
        return this.selectedRepositoryPaths.length === 1 ? this.selectedRepositoryPaths[0] : undefined;
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        this.displayMode = context.workspaceState.get<'tree' | 'flat'>('gitk.filesDisplayMode', 'flat');
        this.customDiffPanel = new CustomDiffPanel(
            (path, generation) => this.syncFileHighlightFromDiffPanel(path, generation),
        );
        this.diffReader = new DiffReader();
        this.gitActions = new GitActionRunner(
            repositoryPath => this.getRepoRootUri(repositoryPath),
            () => this.refresh(),
        );
        context.subscriptions.push(
            this.onDidChangeDiffAvailabilityEmitter,
            this.customDiffPanel,
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
        return !this.isLoading && !!this.currentHash;
    }

    isGitkLoading(): boolean {
        return this.isLoading;
    }

    async selectCommit(hash: string, repositoryPath?: string): Promise<void> {
        const generation = ++this.commitFilesGeneration;
        this.commitFilesAbortController?.abort();
        this.diffReader.stop();
        this.customDiffPanel.cancelPending();
        // 清空数据, changefiles 和 multi-diff 同时进入加载态
        store.batch(() => {
            this.currentRepositoryPath = repositoryPath;
            this.currentChangeSet = 'commit';
            this.currentHash = hash;
            this.selectedPath = undefined;
            this.files = [];
            this.filesLoading = true;
        });
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

    private async selectWorkingTreeChanges(mode: Extract<ChangeSetMode, 'staged' | 'changes'>): Promise<void> {
        const generation = ++this.commitFilesGeneration;
        this.commitFilesAbortController?.abort();
        this.diffReader.stop();
        this.customDiffPanel.cancelPending();
        store.batch(() => {
            this.currentChangeSet = mode;
            this.currentHash = mode;
            this.selectedPath = undefined;
            this.files = mode === 'staged' ? this.stagedFiles : this.changeFiles;
            this.filesLoading = true;
        });
        await this.completeChangedFilesSelection(generation);
        if (generation !== this.commitFilesGeneration) { return; }
        if (this.files.length === 0) {
            this.customDiffPanel.hide();
            store.batch(() => {
                this.filesLoading = false;
                store.setState({ diffLoading: false });
            });
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
        this.refreshAbortController = undefined;
        this.searchAbortController = undefined;
        this.commitFilesAbortController = undefined;
        this.loadMoreAbortController = undefined;
    }

    private setLoading(value: boolean): void {
        if (this.isLoading !== value) {
            this.isLoading = value;
            if (!value) { this.loadingMessage = undefined; }
            this.onDidChangeDiffAvailabilityEmitter.fire();
        }
    }

    private updateMultiDiffVisibility(): void {
        if (this.view?.visible && !this.isLoading && this.currentHash && this.files.length > 0) {
            // 宿主视图的临时隐藏不能取消独立 Multi-Diff 面板的数据。
            void this.openDiff(this.selectedPath);
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        const viewGeneration = ++this.viewGeneration;
        this.view = view;
        this.updateViewVisible();
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
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
            } else {
                await this.refresh();
            }
        } finally {
            if (this.initializingViewGeneration === viewGeneration) {
                this.initializingViewGeneration = 0;
            }
        }
    }

    private hasPreparedInitialData(): boolean {
        const state = store.getState();
        return state.repositories.length > 0
            && state.branches.length > 0
            && state.commits.length > 0
            && !state.isLoading;
    }

    private initializeGitWatchers(): void {
        if (this.gitWatchDisposables.some(disposable => disposable === this.gitWatcherSentinel)) { return; }
        const refreshWorkspaceRepositories = () => {
            invalidateGitRepositoriesCache();
            this.queueLifecycleRefresh();
        };
        const refreshRepositoryState = () => this.queueRepositoryStateRefresh();
        const refreshHeadState = () => this.queueHeadChangeRefresh();
        const gitmodulesWatcher = vscode.workspace.createFileSystemWatcher('**/.gitmodules');
        const gitHeadWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
        const gitRefsWatcher = vscode.workspace.createFileSystemWatcher('**/.git/refs/**');
        const gitIndexWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
        this.gitWatchDisposables.push(
            this.gitWatcherSentinel,
            vscode.workspace.onDidChangeWorkspaceFolders(refreshWorkspaceRepositories),
            gitmodulesWatcher,
            gitmodulesWatcher.onDidCreate(refreshWorkspaceRepositories),
            gitmodulesWatcher.onDidChange(refreshWorkspaceRepositories),
            gitmodulesWatcher.onDidDelete(refreshWorkspaceRepositories),
            gitHeadWatcher,
            gitHeadWatcher.onDidCreate(refreshHeadState),
            gitHeadWatcher.onDidChange(refreshHeadState),
            gitRefsWatcher,
            gitRefsWatcher.onDidCreate(refreshRepositoryState),
            gitRefsWatcher.onDidChange(refreshRepositoryState),
            gitRefsWatcher.onDidDelete(refreshRepositoryState),
            gitIndexWatcher,
            gitIndexWatcher.onDidCreate(refreshRepositoryState),
            gitIndexWatcher.onDidChange(refreshRepositoryState),
            gitIndexWatcher.onDidDelete(refreshRepositoryState),
        );
    }

    private readonly gitWatcherSentinel = new vscode.Disposable(() => undefined);

    private queueLifecycleRefresh(): void {
        invalidateGitRefsCache();
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
        this.searchAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.loadMoreAbortController?.abort();
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
            // 工作树、暂存区和 refs 变化不改变仓库集合，禁止重扫子模块。
            void this.refresh(false);
        }, 300);
    }

    private queueHeadChangeRefresh(): void {
        if (this.headChangeDebounceTimer) {
            clearTimeout(this.headChangeDebounceTimer);
        }
        this.headChangeDebounceTimer = setTimeout(() => {
            this.headChangeDebounceTimer = undefined;
            void this.refreshCurrentHeadBranch();
        }, 100);
    }

    private async refreshCurrentHeadBranch(): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri || this.selectedRepositoryPaths.length !== 1) { return; }
        const headHash = await getCurrentGitHeadHash(rootUri).catch(() => undefined);
        if (!headHash) {
            await this.refresh(false);
            return;
        }
        this.refreshAbortController?.abort();
        this.commitFilesAbortController?.abort();
        const abortController = new AbortController();
        this.refreshAbortController = abortController;
        const signal = abortController.signal;
        const generation = ++this.commitPageGeneration;
        this.setLoading(true);
        try {
            this.view?.webview.postMessage({ type: 'branchesLoading' });
            store.setState({ branchesLoading: true });
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '切换当前分支...', current: 0, total: 1 });
            const branches = await this.loadBranchesWithVirtualCommits(rootUri, signal, headHash);
            if (signal.aborted || generation !== this.commitPageGeneration) { return; }
            const currentBranch = branches.find(branch => branch.kind === 'current');
            if (!currentBranch) {
                await this.refresh(false);
                return;
            }
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '切换当前分支...', current: 1, total: 1 });
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: '正在读取当前分支提交历史...', current: 0, total: 0 });
            const selectedBranches = [currentBranch.name];
            const page = await getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, selectedBranches, 0, (current, total) => {
                this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: current === 0 ? '正在解析分支指向的提交...' : '正在读取提交历史...', current, total });
            }, signal);
            if (signal.aborted || generation !== this.commitPageGeneration) { return; }
            const rawCommits = page.slice(0, COMMIT_PAGE_SIZE);
            const commits = buildGraph(rawCommits).map(commit => ({ ...commit, repositoryPath: rootUri.toString() }));
            store.batch(() => {
                this.branches = branches;
                this.selectedBranches = selectedBranches;
                this.hasBranchSelection = true;
                this.rawCommits = rawCommits;
                this.commits = commits;
                this.hasMoreCommits = page.length > COMMIT_PAGE_SIZE;
                this.isLoadingMoreCommits = false;
                this.commitPageError = '';
                this.stagedFiles = currentBranch.virtualCommits?.find(commit => commit.mode === 'staged')?.files ?? [];
                this.changeFiles = currentBranch.virtualCommits?.find(commit => commit.mode === 'changes')?.files ?? [];
                store.setState({ branchesLoading: false });
            });
            const selectedCommit = commits.find(commit => commit.hash === headHash && commit.repositoryPath === rootUri.toString()) ?? commits[0];
            if (selectedCommit) { await this.selectCommit(selectedCommit.hash, selectedCommit.repositoryPath); }
        } catch (error) {
            if (!this.isAbortError(error) && generation === this.commitPageGeneration) {
                store.batch(() => { this.isLoading = true; this.loadingMessage = `错误: 无法切换当前分支: ${error instanceof Error ? error.message : String(error)}`; });
            }
        } finally {
            if (this.refreshAbortController === abortController) { this.refreshAbortController = undefined; }
            if (generation === this.commitPageGeneration) {
                store.setState({ branchesLoading: false });
                this.setLoading(false);
            }
        }
    }

    private async refreshInternal(refreshGen: number, signal?: AbortSignal, reloadSelectors = true): Promise<void> {
        if (signal?.aborted) { return; }
        const isInitialRepositoryDiscovery = !this.hasRepositorySelection;
        if (!isInitialRepositoryDiscovery) {
            this.setLoading(true);
        }
        if (isInitialRepositoryDiscovery) {
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'start', message: '初始化环境...', current: 0, total: 0 });
        }
        let preparedSelectors: Awaited<ReturnType<typeof this.refreshSelectors>>;
        try {
            preparedSelectors = await this.refreshSelectors(signal, reloadSelectors);
        } catch (error) {
            if (this.isRefreshCurrent(refreshGen)) {
                this.setLoading(false);
                store.setState({ reposLoading: false, branchesLoading: false });
                if (!this.isAbortError(error)) {
                    store.batch(() => { this.isLoading = true; this.loadingMessage = `错误: 无法加载仓库或分支: ${error instanceof Error ? error.message : String(error)}`; });
                }
            }
            return;
        }
        if (!preparedSelectors || !this.isRefreshCurrent(refreshGen)) { return; }
        if (preparedSelectors.repositories.length === 0) {
            this.setLoading(false);
            store.batch(() => { this.isLoading = true; this.loadingMessage = '当前工作区未找到 Git 仓库'; });
            return;
        }
        const rootUris = preparedSelectors.selectedRepositoryPaths.map(path => vscode.Uri.parse(path));
        if (rootUris.length === 0) {
            store.batch(() => {
                this.repositories = preparedSelectors.repositories;
                this.branches = preparedSelectors.branches;
                this.selectedRepositoryPaths = preparedSelectors.selectedRepositoryPaths;
                this.selectedBranches = preparedSelectors.selectedBranches;
                this.hasRepositorySelection = preparedSelectors.hasRepositorySelection;
                this.hasBranchSelection = preparedSelectors.hasBranchSelection;
                this.commits = [];
                this.rawCommits = [];
                this.hasMoreCommits = false;
                this.isLoadingMoreCommits = false;
                this.stagedFiles = [];
                this.changeFiles = [];
                store.setState({ reposLoading: false, branchesLoading: false });
            });
            ++this.commitPageGeneration;
            this.setLoading(false);
            return;
        }
        const totalRepos = rootUris.length;
        let commitProgress = 0;
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: totalRepos === 1 ? '正在读取提交历史...' : `正在读取 ${totalRepos} 个仓库的提交历史...`, current: 0, total: 0 });
        const commitPageGeneration = ++this.commitPageGeneration;
        try {
            const isSingleRepository = rootUris.length === 1;
            const results = await Promise.allSettled(rootUris.map(async rootUri => {
                const refs = isSingleRepository && preparedSelectors.hasBranchSelection ? preparedSelectors.selectedBranches : [];
                const raw = await getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, refs, 0, (current, total) => {
                    if (totalRepos === 1) {
                        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: current === 0 ? '正在解析分支指向的提交...' : '正在读取提交历史...', current, total });
                    }
                }, signal);
                commitProgress++;
                if (totalRepos > 1) {
                    this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: `已读取 ${commitProgress} / ${totalRepos} 个仓库的提交历史...`, current: commitProgress, total: totalRepos });
                }
                return { rootUri, raw };
            }));
            if (commitPageGeneration !== this.commitPageGeneration || !this.isRefreshCurrent(refreshGen)) { return; }
            const successful = results.filter((result): result is PromiseFulfilledResult<{ rootUri: vscode.Uri; raw: GitCommit[] }> => result.status === 'fulfilled').map(result => result.value);
            const rawCommits = isSingleRepository ? (successful[0]?.raw.slice(0, COMMIT_PAGE_SIZE) ?? []) : [];
            const commits = successful.flatMap(({ rootUri, raw }) => buildGraph(isSingleRepository ? rawCommits : raw).map(commit => ({ ...commit, repositoryPath: rootUri.toString() })));
            if (commits.length === 0) {
                const failureMessages = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
                throw new Error(failureMessages[0] || '当前分支暂无可显示的提交');
            }
            const currentBranchFiles = isSingleRepository
                ? this.getCurrentBranchWorkingTreeFiles(preparedSelectors.branches)
                : { staged: [], changes: [] };
            store.batch(() => {
                this.repositories = preparedSelectors.repositories;
                this.branches = preparedSelectors.branches;
                this.selectedRepositoryPaths = preparedSelectors.selectedRepositoryPaths;
                this.selectedBranches = preparedSelectors.selectedBranches;
                this.hasRepositorySelection = preparedSelectors.hasRepositorySelection;
                this.hasBranchSelection = preparedSelectors.hasBranchSelection;
                this.rawCommits = rawCommits;
                this.hasMoreCommits = isSingleRepository && (successful[0]?.raw.length ?? 0) > COMMIT_PAGE_SIZE;
                this.isLoadingMoreCommits = false;
                this.commits = commits;
                this.stagedFiles = currentBranchFiles.staged;
                this.changeFiles = currentBranchFiles.changes;
                store.setState({ reposLoading: false, branchesLoading: false });
            });
            const selectedCommit = this.commits.find(commit => commit.hash === this.currentHash && commit.repositoryPath === this.currentRepositoryPath) ?? this.commits[0];
            this.setLoading(false);
            if (selectedCommit) { void this.selectCommit(selectedCommit.hash, selectedCommit.repositoryPath); }
        } catch (error) {
            if (this.isRefreshCurrent(refreshGen)) {
                this.setLoading(false);
                if (!this.isAbortError(error)) {
                    store.batch(() => { this.isLoading = true; this.loadingMessage = error instanceof Error ? error.message : '加载中, 请稍候...'; });
                }
            }
        }
        this.updateViewVisible();
    }

    private async refreshBranchCommits(): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri || this.selectedRepositoryPaths.length !== 1) { return; }
        this.refreshAbortController?.abort();
        this.commitFilesAbortController?.abort();
        const abortController = new AbortController();
        this.refreshAbortController = abortController;
        const signal = abortController.signal;
        const generation = ++this.commitPageGeneration;
        this.setLoading(true);
        try {
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '刷新分支...', current: 0, total: 1 });
            const branches = await this.loadBranchesWithVirtualCommits(rootUri, signal);
            if (signal.aborted || generation !== this.commitPageGeneration) { return; }
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '刷新分支...', current: 1, total: 1 });
            const selectedBranches = this.selectedBranches.filter(name => branches.some(branch => branch.name === name));
            this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: '正在读取提交历史...', current: 0, total: 0 });
            const page = selectedBranches.length > 0
                ? await getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, selectedBranches, 0, (current, total) => {
                    this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'commit', message: current === 0 ? '正在解析分支指向的提交...' : '正在读取提交历史...', current, total });
                }, signal)
                : [];
            if (signal.aborted || generation !== this.commitPageGeneration) { return; }
            const rawCommits = page.slice(0, COMMIT_PAGE_SIZE);
            const commits = buildGraph(rawCommits).map(commit => ({ ...commit, repositoryPath: rootUri.toString() }));
            const currentBranchFiles = this.getCurrentBranchWorkingTreeFiles(branches);
            store.batch(() => {
                this.branches = branches;
                this.selectedBranches = selectedBranches;
                this.hasBranchSelection = selectedBranches.length > 0;
                this.rawCommits = rawCommits;
                this.commits = commits;
                this.hasMoreCommits = page.length > COMMIT_PAGE_SIZE;
                this.isLoadingMoreCommits = false;
                this.commitPageError = '';
                this.stagedFiles = currentBranchFiles.staged;
                this.changeFiles = currentBranchFiles.changes;
                store.setState({ branchesLoading: false });
            });
            const selectedCommit = commits.find(commit => commit.hash === this.currentHash && commit.repositoryPath === this.currentRepositoryPath) ?? commits[0];
            if (selectedCommit) { await this.selectCommit(selectedCommit.hash, selectedCommit.repositoryPath); }
        } catch (error) {
            if (!this.isAbortError(error) && generation === this.commitPageGeneration) {
                store.batch(() => { this.isLoading = true; this.loadingMessage = `错误: 无法刷新提交: ${error instanceof Error ? error.message : String(error)}`; });
            }
        } finally {
            if (this.refreshAbortController === abortController) { this.refreshAbortController = undefined; }
            if (generation === this.commitPageGeneration) {
                store.setState({ branchesLoading: false });
                this.setLoading(false);
            }
        }
    }

    // 保留分页体验；每一页返回后从完整当前分页快照重建图，避免增量图状态。
    private async loadMoreCommits(): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!this.view || !this.view.visible || !rootUri || this.selectedRepositoryPaths.length !== 1 || !this.hasBranchSelection || !this.hasMoreCommits || this.isLoadingMoreCommits) { return; }
        const generation = this.commitPageGeneration;
        const abortController = new AbortController();
        this.loadMoreAbortController = abortController;
        const signal = abortController.signal;
        const skip = this.rawCommits.length;
        this.isLoadingMoreCommits = true;
        try {
            const page = await getGitCommits(rootUri, COMMIT_PAGE_REQUEST_SIZE, this.selectedBranches, skip, undefined, signal);
            if (signal.aborted || generation !== this.commitPageGeneration) { return; }
            const knownHashes = new Set(this.rawCommits.map(commit => commit.hash));
            const nextCommits = page.slice(0, COMMIT_PAGE_SIZE).filter(commit => !knownHashes.has(commit.hash));
            const rawCommits = [...this.rawCommits, ...nextCommits];
            store.batch(() => {
                this.rawCommits = rawCommits;
                this.commits = buildGraph(rawCommits).map(commit => ({ ...commit, repositoryPath: rootUri.toString() }));
                this.hasMoreCommits = page.length > COMMIT_PAGE_SIZE;
                this.commitPageError = '';
            });
        } catch (error) {
            if (!this.isAbortError(error) && generation === this.commitPageGeneration) {
                this.commitPageError = `无法加载更多提交: ${error instanceof Error ? error.message : String(error)}`;
            }
        } finally {
            if (this.loadMoreAbortController === abortController) { this.loadMoreAbortController = undefined; }
            if (generation === this.commitPageGeneration) { this.isLoadingMoreCommits = false; }
        }
    }

    private withCurrentBranchVirtualCommits(branches: GitBranchOption[], changes: { staged: CommitFile[]; changes: CommitFile[] }, headHash?: string): GitBranchOption[] {
        const virtualCommits: GitBranchVirtualCommit[] = [];
        if (changes.changes.length > 0) {
            virtualCommits.push({ mode: 'changes', hash: VIRTUAL_CHANGES_HASH, label: 'Changes', files: changes.changes });
        }
        if (changes.staged.length > 0) {
            virtualCommits.push({ mode: 'staged', hash: VIRTUAL_STAGED_HASH, label: 'Staged Changes', files: changes.staged });
        }
        const currentBranch = (headHash ? branches.find(branch => branch.hash === headHash) : undefined)
            ?? branches.find(branch => branch.kind === 'current');
        if (!currentBranch) { return branches.map(branch => ({ ...branch, virtualCommits: undefined })); }
        return branches.map(branch => branch === currentBranch
            ? { ...branch, kind: 'current', virtualCommits }
            : { ...branch, kind: branch.kind === 'current' ? 'local' : branch.kind, virtualCommits: undefined });
    }

    private async loadBranchesWithVirtualCommits(rootUri: vscode.Uri, signal?: AbortSignal, headHash?: string): Promise<GitBranchOption[]> {
        const [branches, changes] = await Promise.all([getGitBranches(rootUri, signal), getWorkingTreeChanges(rootUri, signal)]);
        return this.withCurrentBranchVirtualCommits(branches, changes, headHash);
    }

    private getCurrentBranchWorkingTreeFiles(branches: GitBranchOption[]): { staged: CommitFile[]; changes: CommitFile[] } {
        const currentBranch = branches.find(branch => branch.kind === 'current');
        return {
            staged: currentBranch?.virtualCommits?.find(commit => commit.mode === 'staged')?.files ?? [],
            changes: currentBranch?.virtualCommits?.find(commit => commit.mode === 'changes')?.files ?? [],
        };
    }

    private async refreshSelectors(signal?: AbortSignal, reloadRepositories = true): Promise<{
        repositories: GitRepositoryOption[];
        selectedRepositoryPaths: string[];
        branches: GitBranchOption[];
        selectedBranches: string[];
        hasRepositorySelection: boolean;
        hasBranchSelection: boolean;
    } | undefined> {
        const generation = this.refreshGeneration;
        let repositories = this.repositories;
        let selectedRepositoryPaths = [...this.selectedRepositoryPaths];
        // 仓库与分支先后台加载，待提交历史一起完成后再原子替换业务数据。
        if (reloadRepositories) {
            this.view?.webview.postMessage({ type: 'reposLoading' });
            this.view?.webview.postMessage({ type: 'branchesLoading' });
            store.setState({ reposLoading: true, branchesLoading: true });
            // 2. 初始化仓库 + 3. 扫描子模块 (getGitRepositories 内部投递进度)
            repositories = await getGitRepositories((current, total, message) => {
                if (!signal?.aborted && this.isRefreshCurrent(generation)) {
                    this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'repository', message: message || '初始化仓库...', current, total });
                }
            }, signal);
            if (signal?.aborted || !this.isRefreshCurrent(generation)) { if (this.isRefreshCurrent(generation)) { store.setState({ reposLoading: false, branchesLoading: false }); } return undefined; }
            selectedRepositoryPaths = selectedRepositoryPaths.filter(path => repositories.some(repo => repo.path === path));
            if (selectedRepositoryPaths.length === 0) {
                const mainRepository = repositories.find(repo => repo.description !== 'subrepo') ?? repositories[0];
                if (mainRepository) {
                    selectedRepositoryPaths = [mainRepository.path];
                }
            }
        }
        // 4. 加载分支
        this.view?.webview.postMessage({ type: 'branchesLoading' });
        store.setState({ branchesLoading: true });
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '加载分支...', current: 0, total: 1 });
        const rootUri = selectedRepositoryPaths[0] ? vscode.Uri.parse(selectedRepositoryPaths[0]) : undefined;
        const loadedBranches = rootUri ? await this.loadBranchesWithVirtualCommits(rootUri, signal) : [];
        if (signal?.aborted || !this.isRefreshCurrent(generation)) { if (this.isRefreshCurrent(generation)) { store.setState({ branchesLoading: false }); } return undefined; }
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'branch', message: '加载分支...', current: 1, total: 1 });
        const branches = selectedRepositoryPaths.length === 1 ? loadedBranches : [];
        let selectedBranches = this.selectedBranches.filter(name => branches.some(branch => branch.name === name));
        if (!this.hasBranchSelection) {
            selectedBranches = branches.map(branch => branch.name);
        }
        return {
            repositories,
            selectedRepositoryPaths,
            branches,
            selectedBranches,
            hasRepositorySelection: true,
            hasBranchSelection: true,
        };
    }

    private async performSearch(): Promise<void> {
        this.searchAbortController?.abort();
        const abortController = new AbortController();
        this.searchAbortController = abortController;
        const signal = abortController.signal;
        const gen = ++this.searchGeneration;
        const rootUri = this.getRepoRootUri();
        if (!rootUri || this.searchKeywords.length === 0) { return; }
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'search', message: '搜索提交...', current: 0, total: 0 });
        try {
            const refs = this.selectedBranches.length > 0 ? this.selectedBranches : [];
            const results = await searchCommits(rootUri, this.searchKeywords, refs, signal);
            if (signal.aborted || gen !== this.searchGeneration) { return; }
            store.batch(() => {
                this.commits = buildGraph(results).map(c => ({ ...c, repositoryPath: rootUri.toString() }));
                this.hasMoreCommits = false;
                this.isLoadingMoreCommits = false;
                this.commitPageError = '';
            });
            const firstSearchResult = this.commits[0];
            if (firstSearchResult) { await this.selectCommit(firstSearchResult.hash, firstSearchResult.repositoryPath); }
        } catch (error) {
            if (this.isAbortError(error) || gen !== this.searchGeneration) { return; }
            store.batch(() => { this.isLoading = true; this.loadingMessage = `错误: 搜索失败: ${error instanceof Error ? error.message : String(error)}`; });
        } finally {
            if (this.searchAbortController === abortController) { this.searchAbortController = undefined; }
        }
    }

    private async refreshSearchCleared(): Promise<void> {
        await this.refresh();
    }

    private getRepoRootUri(repositoryPath = this.currentRepositoryPath): vscode.Uri | undefined {
        const path = repositoryPath ?? this.selectedRepositoryPath;
        return path ? vscode.Uri.parse(path) : undefined;
    }

    private beginCommitReload(message: string): void {
        ++this.commitPageGeneration;
        this.loadMoreAbortController?.abort();
        this.searchAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.searchGeneration++;
        this.diffReader.stop();
        this.customDiffPanel.cancelPending();
        store.batch(() => {
            this.commits = [];
            this.rawCommits = [];
            this.hasMoreCommits = false;
            this.isLoadingMoreCommits = false;
            this.files = [];
            this.stagedFiles = [];
            this.changeFiles = [];
            this.currentHash = '';
            this.currentRepositoryPath = undefined;
            this.selectedPath = '';
            this.searchKeywords = [];
            this.isLoading = true;
            this.loadingMessage = message;
        });
        this.view?.webview.postMessage({ type: 'loadingProgress', phase: 'start', message, current: 0, total: 0 });
    }

    private async selectRepositories(_paths: string[]): Promise<void> {
        this.beginCommitReload('正在加载...');
        await this.refresh();
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
            case 'refresh':
                void this.refresh();
                break;
            case 'selectRepositories':
                if (Array.isArray(effect.paths) && effect.paths.every((path): path is string => typeof path === 'string' && this.repositories.some(repo => repo.path === path))) {
                    void this.selectRepositories([...new Set(effect.paths)]);
                }
                break;
            case 'reloadBranches':
                if (this.searchKeywords.length > 0) {
                    void this.performSearch();
                } else {
                    void this.refreshBranchCommits();
                }
                break;
            case 'loadMoreCommits':
                void this.loadMoreCommits();
                break;
            case 'gitSync':
                if (effect.action === 'fetch' || effect.action === 'pull' || effect.action === 'push') {
                    this.gitActions.syncRepository(effect.action);
                }
                break;
            case 'commitAction':
                if (typeof effect.action === 'string' && typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    this.gitActions.runCommitAction(effect.action, effect.hash, effect.repositoryPath);
                }
                break;
            case 'selectCommit':
                if (effect.hash === 'staged' || effect.hash === 'changes') {
                    void this.selectWorkingTreeChanges(effect.hash);
                } else if (typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    void this.selectCommit(effect.hash, effect.repositoryPath);
                }
                break;
            case 'selectFile':
                if (typeof effect.path === 'string') {
                    void this.selectChangedFile(effect.path);
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
            case 'persistFilesDisplayMode':
                void this.context.workspaceState.update('gitk.filesDisplayMode', effect.displayMode);
                break;
            case 'search':
                if (typeof effect.keywords !== 'string') { break; }
                const keywords = effect.keywords.trim().split(/\s+/).filter(k => k.length > 0);
                if (keywords.join('\0') === this.searchKeywords.join('\0')) { break; }
                if (keywords.length === 0) {
                    this.searchKeywords = [];
                    this.searchGeneration++;
                    void this.refreshSearchCleared();
                } else {
                    this.searchKeywords = keywords;
                    void this.performSearch();
                }
                break;
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
            const files = await getCommitFilesWithLineStats(rootUri, hash, signal, reportProgress);
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            this.files = files;
            await this.completeChangedFilesSelection(generation, signal);
            if (generation !== this.commitFilesGeneration || signal?.aborted) { return; }
            if (files.length === 0) {
                // 无文件, 直接移除两边 loading
                this.customDiffPanel.hide();
                store.batch(() => {
                    this.filesLoading = false;
                    store.setState({ diffLoading: false });
                });
            }
        } catch (error: any) {
            if (!this.isAbortError(error) && generation === this.commitFilesGeneration) {
                this.view?.webview.postMessage({ type: 'filesError', hash, repositoryPath, message: error instanceof Error ? error.message : String(error) });
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

    private async completeChangedFilesSelection(generation: number, signal?: AbortSignal): Promise<void> {
        if (this.files.length === 0 || !this.currentHash) { return; }
        const selectedPath = this.resolveSelectedChangedFile();
        await this.loadDiffData();
        if (generation !== this.commitFilesGeneration || signal?.aborted) { return; }
        this.filesLoading = false;
        if (this.canShowMultiDiff()) {
            await this.openDiff(selectedPath);
        }
    }

    private resolveSelectedChangedFile(preferredPath?: string): string | undefined {
        const selectedPath = preferredPath ?? this.selectedPath;
        const resolvedPath = selectedPath && this.files.some(file => file.path === selectedPath)
            ? selectedPath
            : this.files[0]?.path;
        this.selectedPath = resolvedPath;
        return resolvedPath;
    }

    private async selectChangedFile(filePath: string): Promise<void> {
        const selectedPath = this.resolveSelectedChangedFile(filePath);
        if (!selectedPath || selectedPath !== filePath || !this.canShowMultiDiff()) { return; }
        await this.openDiff(selectedPath);
    }

    // 后台加载 diff 数据到 Store (单一数据源), 不依赖面板可见性
    // cancelPending 已设置 diffGeneration/diffLoading, 此处复用并启动 DiffReader
    private async loadDiffData(): Promise<void> {
        if (!this.currentHash) { return; }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) {
            store.setState({ diffLoading: false, diffError: '无法确定当前提交所属的 Git 仓库。' });
            return;
        }
        this.diffReader.stop();
        const generation = store.getState().diffGeneration;
        store.setState({
            diffError: undefined,
            diffProgress: { completed: 0, total: this.files.length },
            diffLoading: true,
        });
        await this.diffReader.prepare(rootUri, this.currentHash, this.files, this.currentChangeSet, generation);
    }

    private async openDiff(filePath?: string): Promise<void> {
        if (this.isLoading || !this.currentHash) {
            this.customDiffPanel.cancelPending();
            return;
        }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        if (filePath) { this.selectedPath = filePath; }
        // 只显示面板, 数据由 loadDiffData() 在后台加载到 Store
        await this.customDiffPanel.show(rootUri, this.currentHash, this.files, filePath, this.currentChangeSet);
    }

    private syncFileHighlightFromDiffPanel(filePath: string, generation: number): void {
        if (generation !== store.getState().diffGeneration || !this.files.some(file => file.path === filePath)) { return; }
        this.selectedPath = filePath;
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
  #fileContextMenu { position: fixed; z-index: 20; min-width: 168px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  #fileContextMenu[hidden] { display: none; }
  #fileContextMenu button { display: block; width: 100%; border: 0; border-radius: 3px; padding: 5px 8px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; font: inherit; }
  #fileContextMenu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground)); }
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
  .file-line-counts { display: inline-flex; flex: 0 0 auto; gap: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-variant-numeric: tabular-nums; }
  .file-lines-added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-lines-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .file-path { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .file-folder { opacity: 0.55; }
  #filesEmpty { padding: 8px 10px; color: var(--vscode-descriptionForeground); }
  #filesEmpty:has(.files-loading-spinner) { display: flex; align-items: center; gap: 7px; }
  .files-loading-spinner { width: 12px; height: 12px; flex: 0 0 auto; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: files-loading-spin .8s linear infinite; }
  @keyframes files-loading-spin { to { transform: rotate(360deg); } }
  .commit-header, .commit-row { display: grid; grid-template-columns: var(--graph-width) var(--message-width) var(--author-width) var(--hash-width) var(--date-width); align-items: center; min-width: max-content; }
  .commit-header { position: sticky; top: 0; z-index: 1; height: 30px; margin: 0; padding: 0 10px; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-weight: 600; }
  .commit-row { min-height: 26px; height: auto; cursor: pointer; border-bottom: 1px solid transparent; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
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
    <button class="toolbar-icon" id="refreshBtn" title="刷新提交" aria-label="刷新提交"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6A5 5 0 1 0 13 10M13 2v4H9"/></svg></button>
    <div class="selector"><span class="selector-prefix">repo:</span><div class="dropdown" id="repositoryDropdown">
      <button class="dropdown-current" type="button" title="切换仓库或子仓库" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner"></span>加载仓库...</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选仓库" aria-label="筛选仓库"><div class="dropdown-options"></div></div>
    </div></div><button class="toolbar-icon locator-icon" id="locateCommitBtn" title="定位当前提交" aria-label="定位当前提交"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/></svg></button>
    <div class="selector" id="branchSelector"><span class="selector-prefix">branchs:</span><div class="dropdown" id="branchDropdown">
      <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner"></span>加载分支...</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
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
      <div id="filesHeader"><div id="filesTitle"><span>Changed Files</span><span id="filesCommitHash"></span><span class="action-group" aria-label="复制操作"><button class="toolbar-icon commit-action" data-action="copyHash" title="Copy Commit Hash to Clipboard" aria-label="Copy Commit Hash to Clipboard"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1"/><path d="M3 10.5v-7A1.5 1.5 0 0 1 4.5 2H10"/></svg></button></span></div><div id="filesActions"><div class="action-group" aria-label="提交操作"><button class="toolbar-icon commit-action" data-action="addTag" title="Add Tag..." aria-label="Add Tag"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.75 7.25 3h5.75v5.75L8.25 13.5 2.5 7.75Z"/><circle cx="10.25" cy="5.75" r=".75" fill="currentColor" stroke="none"/></svg></button><button class="toolbar-icon commit-action" data-action="createBranch" title="Create Branch..." aria-label="Create Branch"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 5.5c0 2.1 1.4 3.5 3.5 3.5H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="9" r="1.25"/></svg></button><button class="toolbar-icon commit-action" data-action="checkout" title="Checkout..." aria-label="Checkout"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v8m0 0-2-2m2 2 2-2M4 11h4.5A3.5 3.5 0 0 0 12 7.5V5"/><path d="m10 6 2-2 2 2"/></svg></button><button class="toolbar-icon commit-action" data-action="cherryPick" title="Cherry Pick..." aria-label="Cherry Pick"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.25"/><circle cx="12" cy="12" r="1.25"/><path d="M4 5.25v2.5A3.25 3.25 0 0 0 7.25 11H12M6 3h3"/></svg></button><button class="toolbar-icon commit-action" data-action="revert" title="Revert..." aria-label="Revert"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 3 6.5 5.5 9M3.5 6.5h6A3.5 3.5 0 1 1 6 10"/></svg></button><button class="toolbar-icon commit-action" data-action="drop" title="Drop..." aria-label="Drop"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 6.5v6h6v-6M7 8.5v2.5M9 8.5v2.5"/></svg></button></div><div class="action-group" aria-label="分支操作"><button class="toolbar-icon commit-action" data-action="merge" title="Merge into current branch..." aria-label="Merge into current branch"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 10c0-2.5 1.75-4 4.25-4H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="6" r="1.25"/></svg></button><button class="toolbar-icon commit-action" data-action="rebase" title="Rebase current branch on this Commit..." aria-label="Rebase current branch on this Commit"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h7M8.5 2 11 4 8.5 6M13 12H6M7.5 10 5 12l2.5 2"/></svg></button><button class="toolbar-icon commit-action" data-action="reset" title="Reset current branch to this Commit..." aria-label="Reset current branch to this Commit"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="5.5" width="8" height="8" rx="1"/><path d="M2.5 6A4.5 4.5 0 0 1 7 2.5h2M7 2.5l2 2-2 2"/></svg></button></div><div class="action-group"><button class="toolbar-icon" id="filesModeBtn" title="显示方式（当前：树状）" aria-label="显示方式"><svg viewBox="0 0 16 16" aria-hidden="true"><path id="filesModeIcon" d="M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6"/></svg></button></div></div></div>
      <div id="filesList"><div id="filesEmpty">选择一个提交以查看变更文件</div></div>
      <div id="fileContextMenu" hidden><button type="button" data-copy-path="relative">复制相对路径</button><button type="button" data-copy-path="absolute">复制完整路径</button></div>
    </section>
  </main>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  let commits = [];
  let branches = [];
  let selectedBranches = [];
  let stagedCount = 0;
  let changesCount = 0;
  let files = [];
  let filesLoading = false;
  let filesMode = 'flat';
  let contextFilePath = '';
  let selectedPath = '';
  let selectedCommitHash = '';
  let selectedCommitRepositoryPath = '';
  let hasMoreCommits = false;
  let isLoadingMoreCommits = false;
  let commitPageError = '';
  let commitLoadObserver = null;
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
    repositoryDropdown.label.innerHTML = '<span class="dropdown-spinner"></span>加载仓库...';
    repositoryDropdown.options.innerHTML = '';
    branchDropdown.current.disabled = true;
    branchDropdown.label.innerHTML = '<span class="dropdown-spinner"></span>加载分支...';
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
    dropdown.menu.style.maxHeight = Math.floor(panelHeight * 3 / 4) + 'px';
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
      var previousCommits = commits;
      var previousVirtualCommits = JSON.stringify(getCurrentBranchVirtualCommits());
      commits = state.commits || [];
      branches = state.branches || [];
      selectedBranches = state.selectedBranches || [];
      stagedCount = Number(state.stagedCount) || 0;
      changesCount = Number(state.changesCount) || 0;
      var workingTreeRowsChanged = previousVirtualCommits !== JSON.stringify(getCurrentBranchVirtualCommits());
      hasMoreCommits = Boolean(state.hasMoreCommits);
      isLoadingMoreCommits = Boolean(state.isLoadingMoreCommits);
      commitPageError = state.commitPageError || '';
      files = state.files || [];
      filesMode = state.filesMode || 'tree';
      filesLoading = Boolean(state.filesLoading);
      selectedPath = state.selectedPath || '';
      selectedCommitHash = state.selectedCommit ? state.selectedCommit.hash : '';
      selectedCommitRepositoryPath = state.selectedCommit ? state.selectedCommit.repositoryPath : '';
      currentMaxLane = 0;
      currentGraphW = 280;
      columnWidthChars.hash = 0;
      columnWidthChars.author = 0;
      columnWidthChars.date = 0;
      var listChanged = previousCommits.length !== commits.length || previousCommits.some(function(commit, index) {
        var nextCommit = commits[index];
        return !nextCommit || commit.hash !== nextCommit.hash || commit.repositoryPath !== nextCommit.repositoryPath;
      });
      if (listChanged) expandedCommits.clear();
      if (filesMode === 'tree' && selectedPath) {
        const slash = selectedPath.lastIndexOf('/');
        if (slash >= 0) collapsedFolders.delete(selectedPath.slice(0, slash));
      }
      renderSelectors(state);
      if (listChanged) {
        render();
      } else {
        if (workingTreeRowsChanged) updateWorkingTreeRows();
        applySelectedCommit();
        updateCountLabel();
      }
      updateFilesCommitHash();
      if (filesLoading) {
        document.getElementById('filesList').innerHTML = '<div id="filesEmpty"><span class="files-loading-spinner"></span><span>正在加载变更文件...</span></div>';
      } else {
        renderFiles();
      }
      if (state.isLoading) {
        showLoadingProgress('start', state.loadingMessage || '加载中...', 0, 0);
      } else {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('commitList').style.display = 'block';
      }
    } else if (msg.type === 'reposLoading') {
      closeDropdown(repositoryDropdown);
      repositoryDropdown.current.disabled = true;
      repositoryDropdown.label.innerHTML = '<span class="dropdown-spinner"></span>加载仓库...';
      repositoryDropdown.current.title = '加载仓库...';
      repositoryDropdown.options.innerHTML = '';
    } else if (msg.type === 'branchesLoading') {
      closeDropdown(branchDropdown);
      branchDropdown.current.disabled = true;
      branchDropdown.label.innerHTML = '<span class="dropdown-spinner"></span>加载分支...';
      branchDropdown.current.title = '加载分支...';
      branchDropdown.options.innerHTML = '';
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
    // 持久化 selected Set, 避免 stateUpdate 重建时旧 change handler 引用过期 Set
    if (!branchDropdown.selected) branchDropdown.selected = new Set();
    const selected = branchDropdown.selected;
    // 分支列表未变时只更新 checkbox 状态, 不销毁 DOM (避免 stateUpdate 导致点击丢失)
    var existingInputs = branchDropdown.options.querySelectorAll('input[type="checkbox"]');
    var canUpdateInPlace = existingInputs.length === options.length &&
      Array.from(existingInputs).every(function(input, i) { return input.value === options[i].value; });
    const serverSelection = (selectedValues || []).slice().sort().join('\0');
    const keepPendingSelection = branchDropdown.pendingSelection && canUpdateInPlace && branchDropdown.pendingSelection !== serverSelection;
    if (!keepPendingSelection) {
      selected.clear();
      (selectedValues || []).forEach(function(v) { selected.add(v); });
      branchDropdown.pendingSelection = undefined;
    }
    const hasSelection = selected.size > 0;
    branchDropdown.current.disabled = options.length === 0;
    branchDropdown.label.textContent = hasSelection ? selectedLabel(options, selected, '未选择分支', '全部分支') : '未选择分支';
    branchDropdown.current.title = hasSelection ? selectedTitle(options, selected, '未选择分支') : '未选择分支';
    function applySelection(values) {
      selected.clear();
      values.forEach(function(value) { selected.add(value); });
      branchDropdown.pendingSelection = Array.from(selected).sort().join('\0');
      const showingAll = selected.size === 0;
      branchDropdown.label.textContent = showingAll ? '未选择分支' : selectedLabel(options, selected, '未选择分支', '全部分支');
      branchDropdown.current.title = showingAll ? '未选择分支' : selectedTitle(options, selected, '未选择分支');
      branchDropdown.options.querySelectorAll('input').forEach(function(checkbox) {
        checkbox.checked = selected.has(checkbox.value);
        checkbox.parentElement.classList.toggle('selected', checkbox.checked);
      });
      vscode.postMessage({ type: 'selectBranches', names: Array.from(selected) });
    }
    if (canUpdateInPlace) {
      existingInputs.forEach(function(checkbox) {
        checkbox.checked = selected.has(checkbox.value);
        checkbox.parentElement.classList.toggle('selected', checkbox.checked);
      });
      branchDropdown.menu.querySelector('.select-all').onclick = function() { applySelection(options.map(function(entry) { return entry.value; })); };
      branchDropdown.menu.querySelector('.clear-all').onclick = function() { applySelection([]); };
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
        branchDropdown.pendingSelection = Array.from(selected).sort().join('\0');
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
    if (msg.reposLoading) {
      closeDropdown(repositoryDropdown);
      repositoryDropdown.current.disabled = true;
      repositoryDropdown.label.innerHTML = '<span class="dropdown-spinner"></span>加载仓库...';
      repositoryDropdown.current.title = '加载仓库...';
      repositoryDropdown.options.innerHTML = '';
    } else {
      const repositories = msg.repositories || [];
      renderRepositoryOptions(repositories.map(function(repo) {
        return { value: repo.path, label: repo.label, title: repo.path, hasSubmodules: Boolean(repo.hasSubmodules) };
      }), msg.selectedRepositoryPaths || []);
    }

    if (msg.branchesLoading) {
      closeDropdown(branchDropdown);
      branchDropdown.current.disabled = true;
      branchDropdown.label.innerHTML = '<span class="dropdown-spinner"></span>加载分支...';
      branchDropdown.current.title = '加载分支...';
      branchDropdown.options.innerHTML = '';
      return;
    }

    const branches = msg.branches || [];
    branchDropdown.root.hidden = false;
    const currentBranches = branches.filter(function(branch) { return branch.kind === 'current'; });
    const localBranches = branches.filter(function(branch) { return branch.kind === 'local'; });
    const remoteBranches = branches.filter(function(branch) { return branch.kind === 'remote'; });
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

  function lineCountHtml(file) {
    if (typeof file.addedLines !== 'number' || typeof file.removedLines !== 'number') return '';
    return '<span class="file-line-counts"><span class="file-lines-added">+' + file.addedLines + '</span><span class="file-lines-removed">−' + file.removedLines + '</span></span>';
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
          html += '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>' + lineCountHtml(file) + '<span class="file-path">' + escapeHtml(name) + '</span></div>';
        });
      });
    } else {
      for (const file of ordered) {
        const lastSlash = file.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
        const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
        html += '<div class="file-item' + (file.path === selectedPath ? ' selected' : '') + '" data-path="' + escapeAttr(file.path) + '" title="' + escapeAttr(file.path) + '">';
        html += '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>';
        html += lineCountHtml(file) + '<span class="file-path"><span class="file-folder">' + escapeHtml(folder) + '</span>' + escapeHtml(name) + '</span></div>';
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
        if (!path) return;
        // 立即高亮, 不等扩展往返
        selectedPath = path;
        list.querySelectorAll('.file-item.selected').forEach(function(s) { s.classList.remove('selected'); });
        item.classList.add('selected');
        vscode.postMessage({ type: 'selectFile', path: path });
      });
      item.addEventListener('contextmenu', function(event) {
        event.preventDefault();
        const path = item.getAttribute('data-path');
        if (!path) return;
        contextFilePath = path;
        const menu = document.getElementById('fileContextMenu');
        menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4) + 'px';
        menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4) + 'px';
        menu.hidden = false;
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
    var selected = selectedCommitHash === c.hash && selectedCommitRepositoryPath === c.repositoryPath;
    // 描述只能在当前高亮 commit 上显示。
    var expanded = selected && expandedCommits.has(commitKey);
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
        svg.setAttribute('height', String(ROW_H));
        svg.setAttribute('viewBox', '0 0 ' + currentGraphW + ' ' + ROW_H);
        drawSvg(svg, index, currentGraphW, ROW_H, LANE_W, DOT_R, rowRefX(commits[index]));
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
          || (!repositoryPath && (hash === 'changes' || hash === 'staged'))) {
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
      // 展开属于本地展示细节；提交选择只通过 intent 更新 Store。
      if (!hash || !repositoryPath || row.dataset.hasDescription !== 'true') {
        if (hash === 'changes' || hash === 'staged') {
          applyCommitSelection(hash, '');
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
    var total = commits.length;
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

  function getCurrentBranchVirtualCommits() {
    var currentBranch = branches.find(function(branch) { return branch.kind === 'current'; });
    if (!currentBranch || !selectedBranches.includes(currentBranch.name)) return [];
    return currentBranch.virtualCommits || [];
  }

  function updateWorkingTreeRows() {
    const list = document.getElementById('commitList');
    if (!list || commits.length === 0) return;
    list.querySelectorAll('.working-tree').forEach(function(row) { row.remove(); });
    var virtualCommits = getCurrentBranchVirtualCommits();
    var html = virtualCommits.map(function(commit) {
      return workingTreeRowHTML(commit.hash, commit.label, commit.files.length);
    }).join('');
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
      loading.style.display = 'none';
      list.style.display = 'block';
      list.innerHTML = '<div id="commitEmpty">暂无提交记录</div>';
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
    getCurrentBranchVirtualCommits().forEach(function(commit) {
      html += workingTreeRowHTML(commit.hash, commit.label, commit.files.length);
    });
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
    if (graph) {
      graph.scrollTop = scrollTop;
    }
  }

  function drawSvg(svg, idx, graphW, rowH, laneW, dotR, refColumnX) {
    const c = commits[idx];
    const expanded = selectedCommitHash === c.hash
      && selectedCommitRepositoryPath === c.repositoryPath
      && expandedCommits.has(c.repositoryPath + ':' + c.hash);
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
