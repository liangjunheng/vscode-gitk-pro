import * as vscode from 'vscode';
import {
    type ChangeSetMode,
    type DiffPayload,
    type GitBranchOption,
    CommitMetadata,
    GraphLane,
    type GitRepositoryOption,
    WorkingTreeChanges,
} from '../types';
import { DiffReader } from './diffReader';
import { GitBranchesController } from './gitBranchesController';
import { GitRepoController } from './gitRepoController';
import { UncommittedFilesWatcher } from './uncommittedFilesWatcher';
import {
    getCommitFiles,
    getGitCommits,
    searchCommits,
} from './gitLogProvider';

/** 每页提交条数。 */
const COMMIT_PAGE_SIZE = 50;

const LANE_COLORS = [
    '#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b',
    '#56b6c2', '#ff7a7a', '#a6e22e', '#fd971f', '#ae81ff',
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
    private searched: CommitMetadata[] = [];
    private total: CommitMetadata[] = [];
    private commitPageByRepository = new Map<string, CommitMetadata[]>();
    private commitPageOffsetByRepository = new Map<string, number>();
    private hasMoreCommits = false;
    private isLoadingMore = false;
    private commitPageError = '';
    private pageAbortController?: AbortController;
    private pageGeneration = 0;
    private selectedCommitIdentity?: { hash: string; repositoryPath: string };
    private commitReadAbortController?: AbortController;
    private commitReadGeneration = 0;
    private repositorySelectionGeneration = 0;
    private branchRepositorySelectionGeneration = -1;
    private _isLoading = false;
    private workingTree = new WorkingTreeChanges();
    private workingTreeRepositoryPath?: string;
    private _hasUncommittedChanges = false;
    /**
     * 内容读取专用实例, 不与 Provider 共用。
     *
     * DiffReader 的 stop() 会推进内部 requestGeneration 并 kill 全部子进程,
     * 共用一个实例时 Provider 侧的 stop() 会连坐中止控制器的纯查询。
     */
    private readonly diffReader = new DiffReader();

    private readonly searchedEmitter = new vscode.EventEmitter<CommitMetadata[]>();
    private readonly totalEmitter = new vscode.EventEmitter<CommitMetadata[]>();
    private readonly selectedEmitter = new vscode.EventEmitter<CommitMetadata | undefined>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly workingTreeEmitter = new vscode.EventEmitter<{ changes: WorkingTreeChanges; affectedPaths?: readonly string[] }>();
    private readonly presenceEmitter = new vscode.EventEmitter<boolean>();
    private readonly repositorySelectionSubscription: vscode.Disposable;
    private readonly branchSelectionSubscription: vscode.Disposable;
    private readonly uncommittedFilesSubscription: vscode.Disposable;

    readonly onSearchedCommitsChanged = this.searchedEmitter.event;
    readonly onTotalCommitsChanged = this.totalEmitter.event;
    readonly onSelectedCommitChanged = this.selectedEmitter.event;
    readonly onCommitsLoadingChanged = this.loadingEmitter.event;
    readonly onWorkingTreeChangesChanged = this.workingTreeEmitter.event;
    readonly onUncommittedPresenceChanged = this.presenceEmitter.event;

    constructor(
        repoController: GitRepoController,
        branchesController: GitBranchesController,
        private readonly uncommittedFilesWatcher: UncommittedFilesWatcher,
    ) {
        this.repositorySelectionSubscription = repoController.onSelectedRepoListChanged(repositories => {
            void this.selectRepositories(repositories);
        });
        this.branchSelectionSubscription = branchesController.onSelectedBranchesChanged(branchesMap => {
            this.selectBranches([...branchesMap.values()].flat());
        });
        this.uncommittedFilesSubscription = uncommittedFilesWatcher.onEachHeadBranchUncommittedFileChanged(event => {
            const current = this.branches.find(branch => branch.kind === 'current');
            if (current?.repoOption.path !== event.branch.repoOption.path || current.hash !== event.branch.hash) {
                return;
            }
            this.applyWorkingTreeSnapshot(event.branch.repoOption.path, event.changes, event.affectedPaths);
        });
    }

    get selectedBranches(): readonly GitBranchOption[] { return this.branches; }
    get totalCommitList(): readonly CommitMetadata[] { return this.total; }
    get searchedCommitList(): readonly CommitMetadata[] { return this.searched; }
    get searchKeywords(): readonly string[] { return this.keywords; }
    get selectedCommit(): CommitMetadata | undefined {
        const identity = this.selectedCommitIdentity;
        if (!identity) { return undefined; }
        if (identity.hash === 'uncommitted') {
            const branch = this.branches.find(candidate => candidate.kind === 'current' && candidate.repoOption.path === identity.repositoryPath);
            return branch ? new CommitMetadata({ hash: identity.hash, gitBranchOption: branch }) : undefined;
        }
        return this.total.find(commit => commit.hash === identity.hash && commit.gitBranchOption?.repoOption.path === identity.repositoryPath)
            ?? this.searched.find(commit => commit.hash === identity.hash && commit.gitBranchOption?.repoOption.path === identity.repositoryPath);
    }

    findCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        return this.searched.find(commit =>
            commit.hash === hash && commit.gitBranchOption?.repoOption.path === repositoryPath,
        );
    }
    get isLoading(): boolean { return this._isLoading; }
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
        this.commitReadAbortController?.abort();
        this.pageAbortController?.abort();
        this.repositories = [...repositories];
        this.commitPageByRepository.clear();
        this.commitPageOffsetByRepository.clear();
        this.hasMoreCommits = false;
        this.commitPageError = '';
        this.repositorySelectionGeneration++;
        // 分支事件将携带新仓库对应的分支；强制该次事件按新数据源重新读取。
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
        this._isLoading = true;
        this.branches = [...branches];
        this.branchRepositorySelectionGeneration = this.repositorySelectionGeneration;
        void this.syncWorkingTreeForCurrentBranch();
        void this.refresh(true);
    }

    /**
     * 手动刷新: 重读当前已确认选择的提交列表与当前分支未提交变更。
     * 无已确认选择时交由生命周期加载, 不打断在途读取; 同选择刷新在途时不重复启动。
     */
    async forceRefreshCurrentSelection(): Promise<void> {
        // 尚无确认的分支选择, 由初始化/选择事件链负责首次加载。
        if (this.branches.length === 0) { return; }
        // 同一选择的刷新已在途, 复用它避免重复 git log。
        if (this._isLoading) { return; }
        this.pageAbortController?.abort();
        this.isLoadingMore = false;
        this._isLoading = true;
        // 提交列表与工作区状态都由本控制器负责; 后者内部已吸收 rejection。
        await Promise.all([
            this.refresh(true),
            this.syncWorkingTreeForCurrentBranch(true),
        ]);
    }

    /** 刷新入口二: 关键字变化; 空数组表示不过滤。 */
    async search(keywords: readonly string[]): Promise<CommitMetadata[]> {
        if (this._isLoading) { return [...this.searched]; }
        if (this.sameKeywords(this.keywords, keywords)) { return [...this.searched]; }
        this._isLoading = true;
        this.keywords = [...keywords];
        // 关键字变化不影响未过滤的全量列表与工作区状态。
        await this.refresh(false);
        return [...this.searched];
    }

    /** 用户操作入口, 唯一允许主动改 selected 的公开方法。 */
    selectCommit(commit: CommitMetadata): boolean {
        const repositoryPath = commit.gitBranchOption?.repoOption.path;
        if (!repositoryPath) { return false; }
        if (this.selectedCommitIdentity?.hash === commit.hash && this.selectedCommitIdentity.repositoryPath === repositoryPath) {
            return false;
        }
        this.selectedCommitIdentity = { hash: commit.hash, repositoryPath };
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
        this.repositorySelectionSubscription.dispose();
        this.branchSelectionSubscription.dispose();
        this.uncommittedFilesSubscription.dispose();
        this.commitReadAbortController?.abort();
        this.pageAbortController?.abort();
        this.diffReader.stop();
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
            const searchedPromise = this.readCommits(refsByRepository, this.keywords, abortController.signal);
            const searched = await searchedPromise;
            if (abortController.signal.aborted || generation !== this.commitReadGeneration) { return; }
            this.searched = searched;
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
            if (!this.selectedCommitIdentity && this.searched.length > 0) {
                this.selectCommit(this.searched[0]);
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
            const commits = keywords.length > 0
                ? await searchCommits(rootUri, [...keywords], refs, signal)
                : await getGitCommits(rootUri, COMMIT_PAGE_SIZE, refs, 0, undefined, signal);
            // 每个列表各自建图: buildGraph 原地改图形字段, 共享对象会互相污染。
            return this.buildGraph(commits).map(commit => new CommitMetadata({
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
            this.buildGraph(commits.map(commit => new CommitMetadata({
                ...commit,
                gitBranchOption: this.branchesByRepository.get(repositoryPath)?.[0],
            }))),
        );
        return pages.flat();
    }

    // 图形布局：按 VS Code SCM History 的 inputSwimlanes → outputSwimlanes 状态机转换。
    private buildGraph(commits: CommitMetadata[]): CommitMetadata[] {
        let outputSwimlanes: GraphLane[] = [];
        let nextColor = 0;
        const createSwimlane = (hash: string, color?: string): GraphLane => new GraphLane({
            hash,
            color: color ?? LANE_COLORS[nextColor++ % LANE_COLORS.length],
        });

        for (const commit of commits) {
            const inputSwimlanes = outputSwimlanes.map(lane => new GraphLane({ ...lane }));
            const inputIndex = inputSwimlanes.findIndex(lane => lane.hash === commit.hash);
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
                nextSwimlanes.push(createSwimlane(commit.parents[index]));
            }

            commit.lane = lane;
            commit.laneColor = inputIndex >= 0
                ? inputSwimlanes[inputIndex].color
                : nextSwimlanes[lane]?.color ?? LANE_COLORS[nextColor % LANE_COLORS.length];
            commit.laneStartsHere = inputIndex < 0;
            commit.inputSwimlanes = inputSwimlanes;
            commit.outputSwimlanes = nextSwimlanes;
            outputSwimlanes = nextSwimlanes;
        }
        return commits;
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
