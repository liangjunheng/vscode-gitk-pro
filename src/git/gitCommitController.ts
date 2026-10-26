import * as vscode from 'vscode';
import {
    type ChangeSetMode,
    type DiffPayload,
    type GitBranchOption,
    CommitMetadata,
    GraphLane,
    type GitRepositoryOption,
    WorkingTreeChanges,
    isWorkingTreeHash,
} from '../types';
import { DiffReader } from './diffReader';
import type { GitBackend } from './gitBackend';
import { GitBranchesController } from './gitBranchesController';
import { GitRepoController } from './gitRepoController';
import { UncommittedFilesWatcher } from './uncommittedFilesWatcher';
import {
    getCommitFiles,
    getGitCommits,
    getGitCommitsPriority,
    getCurrentGitHeadHashPriority,
    searchCommits,
} from './gitLogProvider';

/** 每页提交条数。 */
const COMMIT_PAGE_SIZE = 50;

// 与 VS Code Source Control Graph 相同的主题色：当前分支使用 historyItemRefColor，其余泳道轮换 foreground1..5。
const HISTORY_ITEM_REF_COLOR = 'var(--vscode-scmGraph-historyItemRefColor, #57a3f8)';
const LANE_COLORS = [
    'var(--vscode-scmGraph-foreground1, #ffb000)',
    'var(--vscode-scmGraph-foreground2, #dc267f)',
    'var(--vscode-scmGraph-foreground3, #994f00)',
    'var(--vscode-scmGraph-foreground4, #40b0a6)',
    'var(--vscode-scmGraph-foreground5, #b66dff)',
];

/**
 * 提交列表与提交内容的唯一写入者。
 *
 * 只管提交读取/过滤/内容查询, 不涉及仓库发现、分支选择、分页, 也不直接操作 Webview。
 * 关键约束:
 * - 两个刷新入口 (分支变化 / 关键字变化) 走同一条流程, 内容一致则不刷新;
 * - 分支选择变化会取消旧提交列表读取，并通过内部 generation 隔离旧结果;
 * - 提交刷新只消费分支选择事件，HEAD 变化不再通过第二入口重复刷新;
 * - selectedBranches 只读不写, 任何失败都不改动它;
 * - selected 仅首次默认取首条, 刷新列表时一律不动;
 * - 两个内容读取方法是纯查询, 不写状态不发事件不受 loading 限制。
 */
export class GitCommitController implements vscode.Disposable {
    private branches: GitBranchOption[] = [];
    private repositories: GitRepositoryOption[] = [];
    private branchesByRepository = new Map<string, GitBranchOption[]>();
    private keywords: string[] = [];
    // 与已发布列表同步更新，不跟随尚未完成的搜索请求。
    private appliedSearchKeywords: string[] = [];
    private searched: CommitMetadata[] = [];
    private total: CommitMetadata[] = [];
    /** 各仓库的 stash(最新在前), 由 Provider 推入；建图时按基线穿插进提交列表。 */
    private stashesByRepository = new Map<string, readonly CommitMetadata[]>();
    /** 默认不显示 stash；由 Provider 的开关推入。与 GitkViewProvider 的默认值保持一致。 */
    private showStashes = false;
    /** 基线提交不在当前已加载列表里、因此没能显示的 stash 数量(按仓库)。 */
    private hiddenStashCountByRepository = new Map<string, number>();
    private commitPageByRepository = new Map<string, CommitMetadata[]>();
    private commitPageOffsetByRepository = new Map<string, number>();
    // Independent of the selected repositories and pagination. Promises provide single-flight reads.
    private readonly firstCommitPages = new Map<string, { headHash: string; commits: Promise<CommitMetadata[]> }>();
    private readonly pendingFirstPages = new Map<string, GitRepositoryOption>();
    private readonly firstPageRepositoryPaths = new Set<string>();
    private firstPageWorkers = 0;
    private readonly firstPageAbortController = new AbortController();
    private hasMoreCommits = false;
    private isLoadingMore = false;
    private commitPageError = '';
    private pageAbortController?: AbortController;
    private pageGeneration = 0;
    private selectedCommitIdentity?: { hash: string; repositoryPath: string };
    // Keep the user's last commit selection per repository when the foreground repository changes.
    private readonly selectedCommitIdentityByRepository = new Map<string, { hash: string; repositoryPath: string; commit?: CommitMetadata }>();
    // Gitlink 卡片可能跳转到尚未进入当前分页列表的子模块提交；保留显式选择对象作为回退。
    private selectedCommitFallback?: CommitMetadata;
    private commitReadAbortController?: AbortController;
    private commitReadGeneration = 0;
    private repositorySelectionGeneration = 0;
    private branchRepositorySelectionGeneration = -1;
    private _isLoading = false;
    /**
     * 本次提交读取的类型, 单一来源, 避免多个布尔互相打架:
     * - 'rebuild': 换数据源(选择变化或首次加载), 列表要整体重建, 界面用全屏蒙版;
     * - 'refresh': 已选不变的就地重读(forceRefreshCurrentSelection);
     * - 'search' : 已选不变、只按关键字重新过滤(search)。
     * 后两者不换数据源, 界面用顶部进度条; 阶段文案也据此区分。
     */
    private reloadKind: 'rebuild' | 'refresh' | 'search' = 'rebuild';
    private workingTree = new WorkingTreeChanges();
    private workingTreeRepositoryPath?: string;
    private _hasUncommittedChanges = false;
    /**
     * 内容读取专用实例, 不与 Provider 共用。
     *
     * DiffReader 的 stop() 会推进内部 requestGeneration；共用一个实例时
     * Provider 侧的代次切换会让控制器的纯查询结果一并失效。
     */
    private readonly diffReader: DiffReader;

    private readonly searchedEmitter = new vscode.EventEmitter<CommitMetadata[]>();
    private readonly totalEmitter = new vscode.EventEmitter<CommitMetadata[]>();
    private readonly selectedEmitter = new vscode.EventEmitter<CommitMetadata | undefined>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly workingTreeEmitter = new vscode.EventEmitter<{ changes: WorkingTreeChanges; affectedPaths?: readonly string[] }>();
    private readonly presenceEmitter = new vscode.EventEmitter<boolean>();
    private readonly repositorySelectionSubscription: vscode.Disposable;
    private readonly branchSelectionSubscription: vscode.Disposable;
    private readonly uncommittedFilesSubscription: vscode.Disposable;
    private readonly allRepositoriesSubscription: vscode.Disposable;

    readonly onSearchedCommitsChanged = this.searchedEmitter.event;
    readonly onTotalCommitsChanged = this.totalEmitter.event;
    readonly onSelectedCommitChanged = this.selectedEmitter.event;
    readonly onCommitsLoadingChanged = this.loadingEmitter.event;
    readonly onWorkingTreeChangesChanged = this.workingTreeEmitter.event;
    readonly onUncommittedPresenceChanged = this.presenceEmitter.event;

    constructor(
        repoController: GitRepoController,
        private readonly branchesController: GitBranchesController,
        private readonly uncommittedFilesWatcher: UncommittedFilesWatcher,
        gitBackend: GitBackend,
    ) {
        this.diffReader = new DiffReader(gitBackend);
        this.repositorySelectionSubscription = repoController.onSelectedRepoListChanged(repositories => {
            void this.selectRepositories(repositories);
        });
        this.branchSelectionSubscription = branchesController.onSelectedBranchesChanged(branchesMap => {
            this.selectBranches([...branchesMap.values()].flat());
        });
        this.uncommittedFilesSubscription = uncommittedFilesWatcher.onEachHeadBranchUncommittedFileChanged(event => {
            this.prefetchFirstCommitPages([event.branch.repoOption]);
            const current = this.branches.find(branch => branch.kind === 'current');
            if (current?.repoOption.path !== event.branch.repoOption.path || current.hash !== event.branch.hash) {
                return;
            }
            this.applyWorkingTreeSnapshot(event.branch.repoOption.path, event.changes, event.affectedPaths);
        });
        this.allRepositoriesSubscription = repoController.ontotalRepoListChanged(repositories => {
            this.firstPageRepositoryPaths.clear();
            repositories.forEach(repository => this.firstPageRepositoryPaths.add(repository.path));
            const paths = this.firstPageRepositoryPaths;
            for (const repositoryPath of this.firstCommitPages.keys()) {
                if (!paths.has(repositoryPath)) { this.firstCommitPages.delete(repositoryPath); }
            }
            for (const repositoryPath of this.pendingFirstPages.keys()) {
                if (!paths.has(repositoryPath)) { this.pendingFirstPages.delete(repositoryPath); }
            }
            this.prefetchFirstCommitPages(repositories);
        });
        repoController.totalRepoList.forEach(repository => this.firstPageRepositoryPaths.add(repository.path));
        this.prefetchFirstCommitPages(repoController.totalRepoList);
    }

    private prefetchFirstCommitPages(repositories: readonly GitRepositoryOption[]): void {
        if (this.firstPageAbortController.signal.aborted) { return; }
        for (const repository of repositories) {
            if (this.firstPageRepositoryPaths.has(repository.path)) { this.pendingFirstPages.set(repository.path, repository); }
        }
        // Start every queued repository immediately; the page cache deduplicates in-flight reads.
        while (this.pendingFirstPages.size > 0) {
            this.firstPageWorkers++;
            void this.drainFirstCommitPages();
        }
    }

    private async drainFirstCommitPages(): Promise<void> {
        const signal = this.firstPageAbortController.signal;
        try {
            while (!signal.aborted && this.pendingFirstPages.size > 0) {
                const repository = this.pendingFirstPages.values().next().value as GitRepositoryOption;
                this.pendingFirstPages.delete(repository.path);
                try {
                    const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                        .find(candidate => candidate.repoOption.path === repository.path);
                    const headHash = branch?.hash ?? await getCurrentGitHeadHashPriority(vscode.Uri.parse(repository.path), signal);
                    if (headHash && !signal.aborted && this.firstPageRepositoryPaths.has(repository.path)) {
                        await this.readFirstCommitPage(repository, headHash);
                    }
                } catch (error) {
                    if (!signal.aborted) { console.warn('无法预读仓库首批提交:', repository.path, error); }
                }
            }
        } finally { this.firstPageWorkers--; }
    }

    private async readFirstCommitPage(repository: GitRepositoryOption, headHash: string): Promise<CommitMetadata[]> {
        let entry = this.firstCommitPages.get(repository.path);
        if (!entry || entry.headHash !== headHash) {
            entry = {
                headHash,
                commits: getGitCommitsPriority(vscode.Uri.parse(repository.path), COMMIT_PAGE_SIZE,
                    [headHash], 0, this.firstPageAbortController.signal),
            };
            this.firstCommitPages.set(repository.path, entry);
        }
        try {
            const commits = await entry.commits;
            // Graph layout and repository ownership are attached only to fresh foreground copies.
            return commits.map(commit => new CommitMetadata({ ...commit, parents: [...commit.parents], refs: [...commit.refs] }));
        } catch (error) {
            if (this.firstCommitPages.get(repository.path) === entry) { this.firstCommitPages.delete(repository.path); }
            throw error;
        }
    }

    get selectedBranches(): readonly GitBranchOption[] { return this.branches; }
    get totalCommitList(): readonly CommitMetadata[] { return this.total; }
    get searchedCommitList(): readonly CommitMetadata[] { return this.searched; }
    get searchKeywords(): readonly string[] { return this.keywords; }
    get displayedSearchKeywords(): readonly string[] { return this.appliedSearchKeywords; }
    get selectedCommit(): CommitMetadata | undefined {
        const identity = this.selectedCommitIdentity;
        if (!identity) { return undefined; }
        if (isWorkingTreeHash(identity.hash)) {
            const branch = this.branches.find(candidate => candidate.kind === 'current' && candidate.repoOption.path === identity.repositoryPath);
            if (branch) { return new CommitMetadata({ hash: identity.hash, gitBranchOption: branch }); }
            // Gitlink navigation can target an initialized descendant that is not part of the main
            // repository selection. Preserve selectCommit's explicit branch fallback so its
            // Uncommitted Changes snapshot can load instead of becoming an empty MultiDiff.
            return this.selectedCommitFallback?.hash === identity.hash
                && this.selectedCommitFallback.gitBranchOption?.repoOption.path === identity.repositoryPath
                ? this.selectedCommitFallback
                : undefined;
        }
        return this.total.find(commit => commit.hash === identity.hash && commit.gitBranchOption?.repoOption.path === identity.repositoryPath)
            ?? this.searched.find(commit => commit.hash === identity.hash && commit.gitBranchOption?.repoOption.path === identity.repositoryPath)
            ?? (this.selectedCommitFallback?.hash === identity.hash
                && this.selectedCommitFallback.gitBranchOption?.repoOption.path === identity.repositoryPath
                ? this.selectedCommitFallback
                : undefined);
    }

    findCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        return this.searched.find(commit =>
            commit.hash === hash && commit.gitBranchOption?.repoOption.path === repositoryPath,
        );
    }
    /** 仓库最新的真实提交(跳过穿插在图中的 stash 行)。 */
    latestCommitOf(repositoryPath: string): CommitMetadata | undefined {
        const isLatest = (commit: CommitMetadata): boolean =>
            !commit.isStash && commit.gitBranchOption?.repoOption.path === repositoryPath;
        return this.total.find(isLatest) ?? this.searched.find(isLatest);
    }

    get hiddenStashCounts(): ReadonlyMap<string, number> { return this.hiddenStashCountByRepository; }
    get stashesVisible(): boolean { return this.showStashes; }

    /**
     * 设置某仓库的 stash 并就地重建图(不重新读 git log)。
     * 返回 true 表示列表有变化。读取中、尚无分页缓存或内容未变时不做任何事。
     */
    setStashes(repositoryPath: string, stashes: readonly CommitMetadata[]): boolean {
        const previous = this.stashesByRepository.get(repositoryPath);
        const same = previous !== undefined && previous.length === stashes.length
            && previous.every((entry, index) => entry.hash === stashes[index].hash && entry.stashIndex === stashes[index].stashIndex);
        if (same) { return false; }
        this.stashesByRepository.set(repositoryPath, [...stashes]);
        return this.rebuildGraphFromPages();
    }

    forgetStashes(repositoryPath: string): void {
        if (this.stashesByRepository.delete(repositoryPath)) { this.rebuildGraphFromPages(); }
    }

    setStashesVisible(visible: boolean): boolean {
        if (this.showStashes === visible) { return false; }
        this.showStashes = visible;
        return this.rebuildGraphFromPages();
    }

    /** 不重读 git: 用已缓存的分页重新建图并发布。选中项保持不变(它可能是 stash 行)。 */
    private rebuildGraphFromPages(): boolean {
        if (this._isLoading || this.commitPageByRepository.size === 0) { return false; }
        const merged = this.buildPagedCommits();
        this.searched = merged;
        this.total = merged.map(commit => new CommitMetadata({ ...commit }));
        this.searchedEmitter.fire([...this.searched]);
        this.totalEmitter.fire([...this.total]);
        return true;
    }

    get isLoading(): boolean { return this._isLoading; }
    /** 当前读取不换数据源(就地重读或关键字过滤): 界面可用轻量进度条, 不必用全屏蒙版。 */
    get isInPlaceReload(): boolean { return this.reloadKind !== 'rebuild'; }
    /** 当前读取是关键字过滤: 阶段文案要显示搜索而不是加载历史。 */
    get isSearching(): boolean { return this.reloadKind === 'search'; }
    get canLoadMoreCommits(): boolean { return this.hasMoreCommits; }
    get isLoadingMoreCommits(): boolean { return this.isLoadingMore; }
    get commitPageErrorMessage(): string { return this.commitPageError; }

    async loadMoreCommits(): Promise<void> {
        if (this._isLoading || this.isLoadingMore || !this.hasMoreCommits || this.keywords.length > 0) { return; }
        const generation = ++this.pageGeneration;
        const abortController = new AbortController();
        this.pageAbortController?.abort();
        this.pageAbortController = abortController;
        this.isLoadingMore = true;
        this.commitPageError = '';
        this.searchedEmitter.fire([...this.searched]);
        try {
            const pageResults = await Promise.all(this.repositories.map(async repository => {
                const refs = this.branchesByRepository.get(repository.path)?.map(branch => branch.name) ?? [];
                const offset = this.commitPageOffsetByRepository.get(repository.path) ?? 0;
                if (refs.length === 0 || offset === 0) { return { path: repository.path, commits: [] }; }
                const commits = await getGitCommits(vscode.Uri.parse(repository.path), COMMIT_PAGE_SIZE, refs, offset, undefined, abortController.signal);
                return { path: repository.path, commits };
            }));
            if (abortController.signal.aborted || generation !== this.pageGeneration) { return; }
            for (const result of pageResults) {
                if (result.commits.length > 0) {
                    const existing = this.commitPageByRepository.get(result.path) ?? [];
                    this.commitPageByRepository.set(result.path, [...existing, ...result.commits]);
                    this.commitPageOffsetByRepository.set(result.path, existing.length + result.commits.length);
                }
            }
            const merged = this.buildPagedCommits();
            this.searched = merged;
            this.total = merged.map(commit => new CommitMetadata({ ...commit }));
            this.hasMoreCommits = pageResults.some(result => result.commits.length === COMMIT_PAGE_SIZE);
            this.searchedEmitter.fire([...this.searched]);
            this.totalEmitter.fire([...this.total]);
        } catch (error) {
            if (!abortController.signal.aborted && generation === this.pageGeneration) {
                this.commitPageError = error instanceof Error ? error.message : String(error);
                this.searchedEmitter.fire([...this.searched]);
            }
        } finally {
            if (generation === this.pageGeneration) {
                this.isLoadingMore = false;
                this.pageAbortController = undefined;
                this.searchedEmitter.fire([...this.searched]);
            }
        }
    }

    /** 仓库选择唯一内部入口：仅由 GitRepoController.onSelectedRepoListChanged 调用。 */
    private async selectRepositories(repositories: readonly GitRepositoryOption[]): Promise<void> {
        if (this.sameRepositories(this.repositories, repositories)) { return; }
        if (this.selectedCommitIdentity) {
            this.selectedCommitIdentityByRepository.set(this.selectedCommitIdentity.repositoryPath, {
                ...this.selectedCommitIdentity,
                commit: this.selectedCommitFallback,
            });
        }
        this.commitReadAbortController?.abort();
        this.pageAbortController?.abort();
        this.repositories = [...repositories];
        this.commitPageByRepository.clear();
        this.commitPageOffsetByRepository.clear();
        this.hasMoreCommits = false;
        this.commitPageError = '';
        this.searched = [];
        this.appliedSearchKeywords = [];
        this.total = [];
        const restorePath = repositories.length === 1 ? repositories[0].path : undefined;
        const restore = restorePath ? this.selectedCommitIdentityByRepository.get(restorePath) : undefined;
        this.selectedCommitIdentity = restore ? { hash: restore.hash, repositoryPath: restore.repositoryPath } : undefined;
        this.selectedCommitFallback = restore?.commit;
        this._isLoading = true;
        this.reloadKind = 'rebuild';
        this.loadingEmitter.fire(true);
        this.searchedEmitter.fire([]);
        this.totalEmitter.fire([]);
        this.repositorySelectionGeneration++;
        if (repositories.length === 0) {
            // Invalidate foreground history, but keep background first-page caches.
            this.commitReadGeneration++;
            this.pageGeneration++;
            this.branches = [];
            this.branchesByRepository.clear();
            this.isLoadingMore = false;
            this._isLoading = false;
            this.applyWorkingTreeSnapshot(undefined, new WorkingTreeChanges());
            this.selectedEmitter.fire(undefined);
            this.loadingEmitter.fire(false);
            return;
        }
        // 仓库事件监听器的注册顺序不应决定提交读取；已有 HEAD 快照时主动消费，否则等待权威分支事件。
        const selectedBranches = [...this.branchesController.getSelectedBranchesByRepository().values()].flat();
        if (selectedBranches.length > 0) { this.selectBranches(selectedBranches); }
    }

    /** 分支选择唯一内部入口：仅由 GitBranchesController.onSelectedBranchesChanged 调用。 */
    private selectBranches(branches: readonly GitBranchOption[]): void {
        this.branchesByRepository = new Map();
        for (const branch of branches) {
            const repositoryPath = branch.repoOption.path;
            const list = this.branchesByRepository.get(repositoryPath) ?? [];
            list.push(branch);
            this.branchesByRepository.set(repositoryPath, list);
        }
        const repositoryChanged = this.branchRepositorySelectionGeneration !== this.repositorySelectionGeneration;
        if (!repositoryChanged && this.sameBranches(this.branches, branches)) { return; }
        // 新分支或新仓库选择必须立即淘汰旧提交列表读取，不能因 loading 丢弃最新数据源。
        this.commitReadAbortController?.abort();
        this.pageAbortController?.abort();
        this.commitPageByRepository.clear();
        this.commitPageOffsetByRepository.clear();
        this.hasMoreCommits = false;
        this.commitPageError = '';
        // 全屏蒙版只属于换仓库(或仍在途的重建): 同一仓库内改分支(手动确认或自动展开 refs)
        //   旧列表仍有参考价值, 只亮顶部进度条, 列表保持可见。
        const rebuildInFlight = this._isLoading && this.reloadKind === 'rebuild';
        this._isLoading = true;
        this.reloadKind = repositoryChanged || rebuildInFlight ? 'rebuild' : 'refresh';
        this.branches = [...branches];
        this.branchRepositorySelectionGeneration = this.repositorySelectionGeneration;
        void this.syncWorkingTreeForCurrentBranch();
        void this.refresh(true);
    }

    /**
     * 手动刷新: 重读当前已确认选择的提交列表与当前分支未提交变更。
     * 无已确认选择时交由生命周期加载, 不打断在途读取; 同选择刷新在途时不重复启动。
     */
    async forceRefreshCurrentSelection(worktreeAlreadyRefreshed = false): Promise<void> {
        // 尚无确认的分支选择, 由初始化/选择事件链负责首次加载。
        if (this.branches.length === 0) { return; }
        // 同一选择的刷新已在途, 复用它避免重复 git log。
        if (this._isLoading) { return; }
        for (const repository of this.repositories) { this.firstCommitPages.delete(repository.path); }
        this.pageAbortController?.abort();
        this.isLoadingMore = false;
        this._isLoading = true;
        // 本次读取不改已选仓库/分支, 只是就地重读, 界面用顶部进度条即可。
        this.reloadKind = 'refresh';
        // 提交列表与工作区状态都由本控制器负责; 后者内部已吸收 rejection。
        const historyRefresh = this.refresh(true);
        const generation = this.commitReadGeneration;
        try {
            if (worktreeAlreadyRefreshed) {
                await historyRefresh;
            } else {
                await Promise.all([historyRefresh, this.syncWorkingTreeForCurrentBranch(true)]);
            }
        } finally {
            this.resetReloadKind(generation);
        }
    }

    /**
     * 刷新/搜索收尾时把加载呈现方式复位为默认。期间若已有新的读取接管(例如用户确认了分支),
     * 呈现方式属于新读取, 旧流程不能把它改回全屏蒙版。
     */
    private resetReloadKind(generation: number): void {
        if (generation === this.commitReadGeneration) { this.reloadKind = 'rebuild'; }
    }

    /** 刷新入口二: 关键字变化; 空数组表示不过滤。 */
    async search(keywords: readonly string[]): Promise<CommitMetadata[]> {
        if (this._isLoading) { return [...this.searched]; }
        if (this.sameKeywords(this.keywords, keywords)) { return [...this.searched]; }
        this._isLoading = true;
        this.keywords = [...keywords];
        // 搜索只是在同一份已选上重新过滤, 不换数据源, 同样用顶部进度条。
        this.reloadKind = 'search';
        // 关键字变化不影响未过滤的全量列表与工作区状态。
        const reading = this.refresh(false);
        const generation = this.commitReadGeneration;
        try {
            await reading;
        } finally {
            this.resetReloadKind(generation);
        }
        return [...this.searched];
    }

    /** 用户操作入口, 唯一允许主动改 selected 的公开方法。 */
    selectCommit(commit: CommitMetadata): boolean {
        const repositoryPath = commit.gitBranchOption?.repoOption.path;
        if (!repositoryPath) { return false; }
        if (this.selectedCommitIdentity?.hash === commit.hash && this.selectedCommitIdentity.repositoryPath === repositoryPath) {
            this.selectedCommitFallback = commit;
            return false;
        }
        this.selectedCommitIdentity = { hash: commit.hash, repositoryPath };
        this.selectedCommitFallback = commit;
        this.selectedCommitIdentityByRepository.set(repositoryPath, {
            hash: commit.hash,
            repositoryPath,
            commit,
        });
        this.selectedEmitter.fire(this.selectedCommit);
        return true;
    }

    /** 纯查询: 读取某提交的 Diff 内容, 不改状态不发事件。 */
    async getCommitContent(hash: string, repositoryPath: string): Promise<DiffPayload[]> {
        const rootUri = vscode.Uri.parse(repositoryPath);
        const files = await getCommitFiles(rootUri, hash);
        return this.diffReader.readDiffs(rootUri, hash, files, 'commit');
    }

    get workingTreeChanges(): WorkingTreeChanges {
        return new WorkingTreeChanges({ staged: [...this.workingTree.staged], changes: [...this.workingTree.changes] });
    }

    get uncommittedRepositoryPath(): string | undefined {
        return this.branches.find(branch => branch.kind === 'current')?.repoOption.path;
    }

    get hasUncommittedChanges(): boolean { return this._hasUncommittedChanges; }

    markUncommittedDirty(): void {
        const current = this.branches.find(branch => branch.kind === 'current');
        if (current) { void this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(current); }
    }

    requestUncommittedPresenceCheck(): void {
        this.markUncommittedDirty();
    }

    async refreshWorkingTreeImmediately(): Promise<void> {
        const current = this.branches.find(branch => branch.kind === 'current');
        if (!current) {
            this.applyWorkingTreeSnapshot(undefined, new WorkingTreeChanges());
            return;
        }
        const changes = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(current);
        this.applyWorkingTreeSnapshot(current.repoOption.path, changes);
    }

    dispose(): void {
        this.allRepositoriesSubscription.dispose();
        this.firstPageAbortController.abort();
        this.pendingFirstPages.clear();
        this.firstPageRepositoryPaths.clear();
        this.firstCommitPages.clear();
        this.repositorySelectionSubscription.dispose();
        this.branchSelectionSubscription.dispose();
        this.uncommittedFilesSubscription.dispose();
        this.commitReadAbortController?.abort();
        this.pageAbortController?.abort();
        this.diffReader.dispose();
        this.searchedEmitter.dispose();
        this.totalEmitter.dispose();
        this.loadingEmitter.dispose();
        this.selectedEmitter.dispose();
        this.workingTreeEmitter.dispose();
        this.presenceEmitter.dispose();
    }

    /** 唯一的刷新流程；分支变化时额外刷新 totalCommitList。 */
    private async refresh(branchesChanged: boolean): Promise<void> {
        const generation = ++this.commitReadGeneration;
        const abortController = new AbortController();
        this.commitReadAbortController = abortController;
        this.loadingEmitter.fire(true);
        try {
            const refsByRepository = new Map<string, string[]>();
            for (const branch of this.branches) {
                const refs = refsByRepository.get(branch.repoOption.path) ?? [];
                refs.push(branch.name);
                refsByRepository.set(branch.repoOption.path, refs);
            }
            const requestKeywords = [...this.keywords];
            const searched = await this.readCommits(refsByRepository, requestKeywords, abortController.signal);
            if (abortController.signal.aborted || generation !== this.commitReadGeneration) { return; }
            this.searched = searched;
            this.appliedSearchKeywords = requestKeywords;
            this.resetCommitPages(searched);
            this.searchedEmitter.fire([...this.searched]);
            if (branchesChanged) {
                // 无搜索时 searched 就是完整展示列表；复制对象即可隔离 buildGraph 写入，无需重复执行 git log。
                const total = this.keywords.length === 0
                    ? this.searched.map(commit => new CommitMetadata({ ...commit }))
                    : await this.readCommits(refsByRepository, [], abortController.signal);
                if (abortController.signal.aborted || generation !== this.commitReadGeneration) { return; }
                this.total = total;
                this.totalEmitter.fire([...this.total]);
            }
            // 仅首次赋值; 已有选中项一律不动, 即使已不在新列表中。
            const firstRealCommit = this.searched.find(commit => !commit.isStash);
            if (!this.selectedCommitIdentity && firstRealCommit) {
                this.selectCommit(firstRealCommit);
            } else if (this.selectedCommitIdentity) {
                const restored = this.searched.find(commit => commit.hash === this.selectedCommitIdentity?.hash
                    && commit.gitBranchOption?.repoOption.path === this.selectedCommitIdentity?.repositoryPath);
                if (restored) this.selectedCommitFallback = restored;
            }
        } catch (error) {
            if (!abortController.signal.aborted) {
                // 保留 selectedBranches 与已有列表原样, 如实反映失败。
                console.warn('无法读取提交列表:', error);
            }
        } finally {
            // 被新分支取消的旧流程不能结束新流程的 loading 或清空新流程控制器。
            if (generation !== this.commitReadGeneration) { return; }
            this.commitReadAbortController = undefined;
            this._isLoading = false;
            this.loadingEmitter.fire(false);
        }
    }

    /** 按仓库并行读取并建图; 关键字非空走搜索, 否则走普通读取。 */
    private async readCommits(
        refsByRepository: ReadonlyMap<string, readonly string[]>,
        keywords: readonly string[],
        signal: AbortSignal,
    ): Promise<CommitMetadata[]> {
        if (this.repositories.length === 0) { return []; }
        const pages = await Promise.all(this.repositories.map(async repository => {
            const refs = refsByRepository.get(repository.path) ?? [];
            if (refs.length === 0) { return []; }
            const rootUri = vscode.Uri.parse(repository.path);
            const repositoryBranches = this.branchesByRepository.get(repository.path) ?? [];
            const currentBranch = repositoryBranches.length === 1 && repositoryBranches[0].kind === 'current'
                ? repositoryBranches[0] : undefined;
            const commits = keywords.length > 0
                ? await searchCommits(rootUri, [...keywords], refs, signal)
                : currentBranch
                    ? await this.readFirstCommitPage(repository, currentBranch.hash)
                    : await getGitCommits(rootUri, COMMIT_PAGE_SIZE, refs, 0, undefined, signal);
            if (signal.aborted) { return []; }
            // 每个列表各自建图: buildGraph 原地改图形字段, 共享对象会互相污染。
            // VS Code 把当前分支整条第一父泳道染成 historyItemRefColor（蓝色）。
            const currentRefHash = repositoryBranches.find(branch => branch.kind === 'current' && refs.includes(branch.name))?.hash;
            return this.buildGraph(this.withStashes(repository.path, commits), currentRefHash).map(commit => new CommitMetadata({
                ...commit,
                gitBranchOption: this.branchesByRepository.get(repository.path)?.[0]!,
            }));
        }));
        return pages.flat();
    }

    private resetCommitPages(commits: readonly CommitMetadata[]): void {
        this.commitPageByRepository.clear();
        this.commitPageOffsetByRepository.clear();
        const byRepository = new Map<string, CommitMetadata[]>();
        for (const commit of commits) {
            // stash 行是图上的穿插行, 不是历史页的一部分: 缓存页只存真实提交, 偏移也只按真实提交计。
            if (commit.isStash) { continue; }
            const repositoryPath = commit.gitBranchOption?.repoOption.path;
            if (!repositoryPath) { continue; }
            const page = byRepository.get(repositoryPath) ?? [];
            page.push(new CommitMetadata({ ...commit, lane: undefined, inputSwimlanes: undefined, outputSwimlanes: undefined }));
            byRepository.set(repositoryPath, page);
        }
        for (const [repositoryPath, page] of byRepository) {
            this.commitPageByRepository.set(repositoryPath, page);
            this.commitPageOffsetByRepository.set(repositoryPath, page.length);
        }
        this.hasMoreCommits = this.keywords.length === 0
            && [...byRepository.values()].some(page => page.length === COMMIT_PAGE_SIZE);
        this.commitPageError = '';
    }

    private buildPagedCommits(): CommitMetadata[] {
        const pages = [...this.commitPageByRepository.entries()].map(([repositoryPath, commits]) =>
            this.buildGraph(
                this.withStashes(repositoryPath, commits.map(commit => new CommitMetadata({ ...commit }))),
                this.branchesByRepository.get(repositoryPath)?.find(branch => branch.kind === 'current')?.hash,
            ).map(commit => new CommitMetadata({
                ...commit,
                // 在建图之后统一挂分支: 穿插进来的 stash 行同样属于该仓库。
                gitBranchOption: this.branchesByRepository.get(repositoryPath)?.[0],
            })),
        );
        return pages.flat();
    }

    /**
     * 把 stash 穿插进提交列表: 每条 stash 只保留 parents[0](基线)作为唯一父提交,
     * 放在列表中第一条 hash === 基线的提交之前; 在泳道图里它是基线所在泳道上的一颗珠子(不开新泳道)。
     * stash 的 index / 未跟踪辅助父提交不是历史的一部分, 不进图。
     * 基线不在已加载列表里(分页没加载到, 或在未选分支上)的 stash 无法定位, 计入 hiddenStashCount。
     */
    private withStashes(repositoryPath: string, commits: readonly CommitMetadata[]): CommitMetadata[] {
        this.hiddenStashCountByRepository.delete(repositoryPath);
        const stashes = this.showStashes && this.keywords.length === 0
            ? this.stashesByRepository.get(repositoryPath) ?? []
            : [];
        if (stashes.length === 0) { return [...commits]; }
        const byBase = new Map<string, CommitMetadata[]>();
        const loaded = new Set(commits.map(commit => commit.hash));
        let hidden = 0;
        for (const stash of stashes) {
            const base = stash.parents[0];
            if (!base || !loaded.has(base)) { hidden++; continue; }
            const list = byBase.get(base) ?? [];
            list.push(stash);
            byBase.set(base, list);
        }
        if (hidden > 0) { this.hiddenStashCountByRepository.set(repositoryPath, hidden); }
        const result: CommitMetadata[] = [];
        const placed = new Set<string>();
        for (const commit of commits) {
            if (!placed.has(commit.hash)) {
                for (const stash of byBase.get(commit.hash) ?? []) {
                    result.push(new CommitMetadata({
                        ...stash,
                        parents: [commit.hash],
                        refs: [],
                        isStash: true,
                    }));
                }
                placed.add(commit.hash);
            }
            result.push(commit);
        }
        return result;
    }

    /**
     * 找出“幽灵泳道”：merge 的第 2+ 个父提交开出的泳道，直到汇入为止一个自己的提交都没有。
     * 典型场景：重复合并（第二父提交本来就是祖先）、把主线同步进分支后再合回主线。
     * 这种泳道只是一条把 merge 节点连到某个祖先的空线，却会占一整列、把旁边所有行的文字往右推。
     *
     * 为什么去掉它不会影响其它提交的位置：
     * - 它汇入时，提交归属于“最靠左、正在等这个提交的泳道”，而幽灵泳道恰好不是那一条（否则就有自己的提交了）；
     * - 所以同一个提交上一定还有另一条更靠左的泳道在等它，去掉幽灵泳道不改变任何提交落在哪一列。
     * 汇入点不在已加载窗口内的泳道无法判断，一律保留（分页加载更多后会重新判定）。
     *
     * 返回的键是 `行号:父提交序号`，与 buildGraph 第二遍创建泳道的位置一一对应。
     */
    private findPhantomLanes(commits: readonly CommitMetadata[]): Set<string> {
        interface LaneTrack { own: number; resolved: boolean; key?: string }
        let lanes: Array<{ hash: string; track: LaneTrack }> = [];
        const candidates: LaneTrack[] = [];
        commits.forEach((commit, row) => {
            if (commit.isStash) { return; }
            const owner = lanes.findIndex(lane => lane.hash === commit.hash);
            const next: Array<{ hash: string; track: LaneTrack }> = [];
            let firstParentAdded = false;
            for (let index = 0; index < lanes.length; index++) {
                const lane = lanes[index];
                if (lane.hash === commit.hash) {
                    lane.track.resolved = true;
                    if (index === owner) {
                        lane.track.own++;
                        if (commit.parents.length > 0) {
                            next.push({ hash: commit.parents[0], track: lane.track });
                            firstParentAdded = true;
                        }
                    }
                    continue;
                }
                next.push(lane);
            }
            for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
                // 没有进入泳道的提交（分支头）自己开出的第一条泳道算它自己的；其余都是侧枝候选。
                const track: LaneTrack = index === 0 && owner < 0
                    ? { own: 1, resolved: true }
                    : { own: 0, resolved: false, key: `${row}:${index}` };
                if (track.key) { candidates.push(track); }
                next.push({ hash: commit.parents[index], track });
            }
            lanes = next;
        });
        const phantom = new Set<string>();
        for (const track of candidates) {
            if (track.resolved && track.own === 0 && track.key) { phantom.add(track.key); }
        }
        return phantom;
    }

    // 图形布局：按 VS Code SCM History 的 inputSwimlanes → outputSwimlanes 状态机转换。
    // 与官方算法的两处区别：
    // 1. 幽灵泳道（见 findPhantomLanes）不再开出，避免空线占列、把无关行的文字推向右侧；
    // 2. stash 行不进入状态机：它只是挂在基线提交上的一颗“珠子”，沿用当前泳道状态原样穿过，
    //    所以显示或隐藏 stash 都不会改变任何真实提交的列和颜色。
    private buildGraph(commits: CommitMetadata[], currentRefHash?: string): CommitMetadata[] {
        const phantom = this.findPhantomLanes(commits);
        let outputSwimlanes: GraphLane[] = [];
        // VS Code 的 colorIndex 只在“没有引用颜色的新泳道”上递增；当前分支的蓝色引用泳道不消耗 foreground1，
        // 因此 merge 的第一条侧枝正好使用 foreground1（橙色）。已有泳道沿第一父提交继承原颜色。
        let nextColor = 0;
        const createSwimlane = (hash: string, color?: string): GraphLane => new GraphLane({
            hash,
            color: color ?? LANE_COLORS[nextColor++ % LANE_COLORS.length],
        });

        for (const [row, commit] of commits.entries()) {
            if (commit.isStash) {
                // 基线已有泳道在等它：珠子落在那一列；基线是分支头（还没有泳道）：落在它即将占用的新列。
                const base = commit.parents[0];
                const baseIndex = outputSwimlanes.findIndex(lane => lane.hash === base);
                commit.lane = baseIndex >= 0 ? baseIndex : outputSwimlanes.length;
                commit.laneColor = undefined;
                commit.laneStartsHere = false;
                commit.inputSwimlanes = outputSwimlanes.map(lane => new GraphLane({ ...lane }));
                commit.outputSwimlanes = outputSwimlanes.map(lane => new GraphLane({ ...lane }));
                continue;
            }
            const inputSwimlanes = outputSwimlanes.map(lane => new GraphLane({ ...lane }));
            const inputIndex = inputSwimlanes.findIndex(lane => lane.hash === commit.hash);
            const refColor = commit.hash === currentRefHash ? HISTORY_ITEM_REF_COLOR : undefined;
            const lane = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
            const nextSwimlanes: GraphLane[] = [];
            let firstParentAdded = false;

            for (let index = 0; index < inputSwimlanes.length; index++) {
                const inputLane = inputSwimlanes[index];
                if (inputLane.hash === commit.hash) {
                    if (index === inputIndex && commit.parents.length > 0) {
                        nextSwimlanes.push(createSwimlane(commit.parents[0], inputLane.color));
                        firstParentAdded = true;
                    }
                    continue;
                }
                nextSwimlanes.push(new GraphLane({ ...inputLane }));
            }

            for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
                if (phantom.has(`${row}:${index}`)) { continue; }
                const color = index === 0 ? refColor : undefined;
                nextSwimlanes.push(createSwimlane(commit.parents[index], color));
            }

            commit.lane = lane;
            commit.laneColor = inputIndex >= 0
                ? inputSwimlanes[inputIndex].color
                : nextSwimlanes[lane]?.color ?? refColor ?? LANE_COLORS[lane % LANE_COLORS.length];
            commit.laneStartsHere = inputIndex < 0;
            commit.inputSwimlanes = inputSwimlanes;
            commit.outputSwimlanes = nextSwimlanes;
            outputSwimlanes = nextSwimlanes;
        }
        this.assignIndentDepth(commits, phantom);
        return commits;
    }

    /**
     * 计算每行文字的缩进层数 indentDepth（只表达“这条提交是被某个侧枝带进来的”，与泳道列号无关）。
     *
     * 规则：
     * - 主线 = 第一行提交沿第一父提交一路走到根。主线上的提交恒为 0，哪怕旁边有泳道线经过；
     * - 其余提交属于某条泳道，泳道由“谁开出了它”串成一棵树：merge 的第 2+ 个父提交开出侧枝，
     *   未合并的分支头自成一条线；
     * - 层数 = 从该泳道往上数，路径上“有自己提交”的侧枝个数。空线（幽灵泳道）不计层；
     * - stash 取其基线提交的层数，不计层。
     * 泳道的身份沿第一父提交继承，所以同一条线上的所有提交层数相同。
     */
    private assignIndentDepth(commits: CommitMetadata[], phantom: ReadonlySet<string>): void {
        interface LaneNode { parent?: LaneNode; own: number; side: boolean }
        const mainline = new Set<string>();
        const byHash = new Map<string, CommitMetadata>();
        for (const commit of commits) { if (!commit.isStash) { byHash.set(commit.hash, commit); } }
        const first = commits.find(commit => !commit.isStash);
        for (let current = first?.hash; current && !mainline.has(current);) {
            mainline.add(current);
            current = byHash.get(current)?.parents[0];
        }

        let lanes: Array<{ hash: string; node: LaneNode }> = [];
        const nodeOfRow: Array<LaneNode | undefined> = [];
        commits.forEach((commit, row) => {
            if (commit.isStash) { nodeOfRow.push(undefined); return; }
            const owner = lanes.findIndex(lane => lane.hash === commit.hash);
            let node: LaneNode;
            const next: Array<{ hash: string; node: LaneNode }> = [];
            let firstParentAdded = false;
            if (owner >= 0) { node = lanes[owner].node; }
            else { node = { own: 0, side: row > 0 }; }
            if (!mainline.has(commit.hash)) { node.own++; }
            for (let index = 0; index < lanes.length; index++) {
                const lane = lanes[index];
                if (lane.hash === commit.hash) {
                    if (index === owner && commit.parents.length > 0) {
                        next.push({ hash: commit.parents[0], node });
                        firstParentAdded = true;
                    }
                    continue;
                }
                next.push(lane);
            }
            if (owner < 0 && commit.parents.length > 0 && !firstParentAdded) {
                next.push({ hash: commit.parents[0], node });
                firstParentAdded = true;
            }
            for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
                if (phantom.has(`${row}:${index}`)) { continue; }
                next.push({ hash: commit.parents[index], node: { parent: node, own: 0, side: true } });
            }
            nodeOfRow.push(node);
            lanes = next;
        });

        const depthOf = (start: LaneNode | undefined): number => {
            let depth = 0;
            for (let node = start, guard = 0; node && guard < 256; node = node.parent, guard++) {
                if (node.side && node.own > 0) { depth++; }
            }
            return depth;
        };
        commits.forEach((commit, row) => {
            if (commit.isStash) { return; }
            commit.indentDepth = mainline.has(commit.hash) ? 0 : depthOf(nodeOfRow[row]);
        });
        // stash 取基线提交的层数。
        for (const commit of commits) {
            if (!commit.isStash) { continue; }
            commit.indentDepth = byHash.get(commit.parents[0])?.indentDepth ?? 0;
        }
    }

    private async syncWorkingTreeForCurrentBranch(forceRefresh = false): Promise<void> {
        const current = this.branches.find(branch => branch.kind === 'current');
        if (!current) {
            this.applyWorkingTreeSnapshot(undefined, new WorkingTreeChanges());
            return;
        }
        try {
            // 手动刷新走强制全量; watcher 校验 HEAD 已变时会抛错, 在此吸收。
            if (forceRefresh) {
                await this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(current);
            }
            const changes = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(current);
            const selected = this.branches.find(branch => branch.kind === 'current');
            if (selected?.repoOption.path !== current.repoOption.path || selected.hash !== current.hash) { return; }
            this.applyWorkingTreeSnapshot(current.repoOption.path, changes);
        } catch (error) {
            // HEAD 在读取期间切换属预期竞态, 由后续 head 事件重新同步, 不冒泡为未处理 rejection。
            console.warn(`无法同步未提交文件: ${current.repoOption.path}`, error);
        }
    }

    private applyWorkingTreeSnapshot(
        repositoryPath: string | undefined,
        changes: WorkingTreeChanges,
        affectedPaths?: readonly string[],
    ): void {
        if (repositoryPath === this.workingTreeRepositoryPath && this.workingTree.equals(changes)) { return; }
        this.workingTreeRepositoryPath = repositoryPath;
        this.workingTree = changes;
        this.setHasUncommittedChanges(changes.staged.length + changes.changes.length > 0);
        // affectedPaths 透传给下游: 状态通道据此识别哪些已展示文件需连内容一起重读,
        // 弥补工作区文件无 objectId 导致 CommitFile.equals 看不见内容变化的缺口。
        this.workingTreeEmitter.fire({ changes: this.workingTreeChanges, affectedPaths });
    }

    private setHasUncommittedChanges(value: boolean): void {
        if (this._hasUncommittedChanges === value) { return; }
        this._hasUncommittedChanges = value;
        this.presenceEmitter.fire(value);
    }

    private sameBranches(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const byRepository = new Map<string, Map<string, GitBranchOption>>();
        for (const branch of left) {
            const byName = byRepository.get(branch.repoOption.path) ?? new Map<string, GitBranchOption>();
            byName.set(branch.name, branch);
            byRepository.set(branch.repoOption.path, byName);
        }
        return right.every(branch => byRepository.get(branch.repoOption.path)?.get(branch.name)?.equals(branch) ?? false);
    }

    private sameRepositories(left: readonly GitRepositoryOption[], right: readonly GitRepositoryOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const paths = new Set(left.map(repository => repository.path));
        return right.every(repository => paths.has(repository.path));
    }

    private sameKeywords(left: readonly string[], right: readonly string[]): boolean {
        return left.length === right.length && left.every((keyword, index) => keyword === right[index]);
    }
}
