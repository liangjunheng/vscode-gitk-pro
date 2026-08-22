import * as path from 'path';
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
import {
    checkWorkingTreePresence,
    getCommitFiles,
    getGitCommits,
    getWorkingTreeChanges,
    searchCommits,
} from './gitLogProvider';

/** 首页提交条数。 */
const COMMIT_LIMIT = 200;

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
 * - 搜索与 forceRefresh 仍共用 loading 门禁，不打断当前分支读取;
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
    private _selectedCommit?: CommitMetadata;
    private commitReadAbortController?: AbortController;
    private commitReadGeneration = 0;
    private repositorySelectionGeneration = 0;
    private branchRepositorySelectionGeneration = -1;
    private _isLoading = false;
    private pendingForceRefresh = false;
    private workingTree = new WorkingTreeChanges();
    private workingTreeRepositoryPath?: string;
    private workingTreeReadGeneration = 0;
    private _hasUncommittedChanges = false;
    private presenceAbortController?: AbortController;
    private presenceGeneration = 0;
    private readonly changeWatchers = new Map<string, vscode.Disposable>();
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
    private readonly workingTreeEmitter = new vscode.EventEmitter<WorkingTreeChanges>();
    private readonly presenceEmitter = new vscode.EventEmitter<boolean>();
    private readonly repositorySelectionSubscription: vscode.Disposable;
    private readonly branchSelectionSubscription: vscode.Disposable;
    private readonly workspaceChangeSubscription: vscode.Disposable;
    private readonly workspaceSaveSubscription: vscode.Disposable;

    readonly onSearchedCommitsChanged = this.searchedEmitter.event;
    readonly onTotalCommitsChanged = this.totalEmitter.event;
    readonly onSelectedCommitChanged = this.selectedEmitter.event;
    readonly onCommitsLoadingChanged = this.loadingEmitter.event;
    readonly onWorkingTreeChangesChanged = this.workingTreeEmitter.event;
    readonly onUncommittedPresenceChanged = this.presenceEmitter.event;

    constructor(repoController: GitRepoController, branchesController: GitBranchesController) {
        this.repositorySelectionSubscription = repoController.onSelectedRepoListChanged(repositories => {
            void this.selectRepositories(repositories);
        });
        this.branchSelectionSubscription = branchesController.onSelectedBranchesChanged(branchesMap => {
            this.selectBranches([...branchesMap.values()].flat());
        });
        this.workspaceChangeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (!this.isRepositoryDocument(event.document.uri)) { return; }
            this.markUncommittedDirty();
        });
        this.workspaceSaveSubscription = vscode.workspace.onDidSaveTextDocument(document => {
            if (this.isRepositoryDocument(document.uri)) { this.requestUncommittedPresenceCheck(); }
        });
    }

    get selectedBranches(): readonly GitBranchOption[] { return this.branches; }
    get totalCommitList(): readonly CommitMetadata[] { return this.total; }
    get searchedCommitList(): readonly CommitMetadata[] { return this.searched; }
    get searchKeywords(): readonly string[] { return this.keywords; }
    get selectedCommit(): CommitMetadata | undefined { return this._selectedCommit; }

    findCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        return this.searched.find(commit =>
            commit.hash === hash && commit.gitBranchOption?.repoOption.path === repositoryPath,
        );
    }
    get isLoading(): boolean { return this._isLoading; }

    /**
     * 分支头变化后的强制刷新入口。
     * 不改 selectedBranches；在途时记账，当前刷新收尾后补跑，避免 watcher 事件丢失。
     */
    forceRefresh(): void {
        if (this._isLoading) {
            this.pendingForceRefresh = true;
            return;
        }
        if (this.branches.length === 0 || this.repositories.length === 0) { return; }
        this._isLoading = true;
        void this.refresh(true);
    }

    /** 仓库选择唯一内部入口：仅由 GitRepoController.onSelectedRepoListChanged 调用。 */
    private async selectRepositories(repositories: readonly GitRepositoryOption[]): Promise<void> {
        if (this.sameRepositories(this.repositories, repositories)) { return; }
        this.commitReadAbortController?.abort();
        this.repositories = [...repositories];
        this.repositorySelectionGeneration++;
        this.syncChangeWatchers();
        this.requestUncommittedPresenceCheck();
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
        if (!repositoryChanged && this.sameNames(this.branches, branches)) { return; }
        // 新分支或新仓库选择必须立即淘汰旧提交列表读取，不能因 loading 丢弃最新数据源。
        this.commitReadAbortController?.abort();
        this._isLoading = true;
        this.branches = [...branches];
        this.branchRepositorySelectionGeneration = this.repositorySelectionGeneration;
        this.requestUncommittedPresenceCheck();
        void this.refresh(true);
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
        // 提交业务身份由仓库路径和 hash 组成；对象重建、图形字段变化不应触发重复选择。
        if (this._selectedCommit?.gitBranchOption && commit.gitBranchOption
            && this._selectedCommit.gitBranchOption.equals(commit.gitBranchOption)
            && this._selectedCommit.hash === commit.hash) {
            return false;
        }
        // 选择提交只改变选择状态，不刷新提交列表；提交内容读取由 Provider 独立管理。
        this._selectedCommit = commit;
        this.selectedEmitter.fire(this._selectedCommit);
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
        this.setHasUncommittedChanges(true);
    }

    requestUncommittedPresenceCheck(): void {
        const generation = ++this.presenceGeneration;
        this.presenceAbortController?.abort();
        const repositoryPath = this.uncommittedRepositoryPath;
        if (!repositoryPath) {
            this.presenceAbortController = undefined;
            this.setHasUncommittedChanges(false);
            return;
        }
        const abortController = new AbortController();
        this.presenceAbortController = abortController;
        void checkWorkingTreePresence(vscode.Uri.parse(repositoryPath), abortController.signal).then(hasChanges => {
            if (generation === this.presenceGeneration && !abortController.signal.aborted) {
                this.setHasUncommittedChanges(hasChanges);
            }
        }).catch(error => {
            if (error instanceof Error && error.name === 'AbortError') { return; }
            if (generation === this.presenceGeneration) { console.warn('无法检测未提交状态:', error); }
        }).finally(() => {
            if (this.presenceAbortController === abortController) { this.presenceAbortController = undefined; }
        });
    }

    async refreshWorkingTreeImmediately(): Promise<void> {
        await this.refreshWorkingTreeSnapshot();
    }

    dispose(): void {
        this.repositorySelectionSubscription.dispose();
        this.branchSelectionSubscription.dispose();
        this.workspaceChangeSubscription.dispose();
        this.workspaceSaveSubscription.dispose();
        this.commitReadAbortController?.abort();
        this.presenceAbortController?.abort();
        this.changeWatchers.forEach(watcher => watcher.dispose());
        this.changeWatchers.clear();
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
            const searched = await this.readCommits(refsByRepository, this.keywords, abortController.signal);
            if (abortController.signal.aborted || generation !== this.commitReadGeneration) { return; }
            this.searched = searched;
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
            if (!this._selectedCommit && this.searched.length > 0) {
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
            if (this.pendingForceRefresh) {
                this.pendingForceRefresh = false;
                this.forceRefresh();
            }
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
                : await getGitCommits(rootUri, COMMIT_LIMIT, refs, 0, undefined, signal);
            // 每个列表各自建图: buildGraph 原地改图形字段, 共享对象会互相污染。
            return this.buildGraph(commits).map(commit => new CommitMetadata({
                ...commit,
                gitBranchOption: this.branchesByRepository.get(repository.path)?.[0]!,
            }));
        }));
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

    private syncChangeWatchers(): void {
        const keep = new Set(this.repositories.map(repository => repository.path));
        for (const [repositoryPath, watcher] of this.changeWatchers) {
            if (keep.has(repositoryPath)) { continue; }
            watcher.dispose();
            this.changeWatchers.delete(repositoryPath);
        }
        for (const repository of this.repositories) {
            if (this.changeWatchers.has(repository.path)) { continue; }
            const rootUri = vscode.Uri.parse(repository.path);
            const indexWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, '.git/index'));
            const refresh = () => this.requestUncommittedPresenceCheck();
            this.changeWatchers.set(repository.path, vscode.Disposable.from(
                indexWatcher,
                indexWatcher.onDidCreate(refresh),
                indexWatcher.onDidChange(refresh),
                indexWatcher.onDidDelete(refresh),
            ));
        }
    }

    private async refreshWorkingTreeSnapshot(): Promise<void> {
        const generation = ++this.workingTreeReadGeneration;
        const selectedHead = this.branches.find(branch => branch.kind === 'current');
        const repositoryPath = selectedHead?.repoOption.path;
        if (!selectedHead || !repositoryPath) {
            this.applyWorkingTreeSnapshot(undefined, new WorkingTreeChanges());
            return;
        }
        try {
            const changes = await getWorkingTreeChanges(vscode.Uri.parse(repositoryPath));
            if (generation !== this.workingTreeReadGeneration) { return; }
            this.applyWorkingTreeSnapshot(repositoryPath, changes);
        } catch (error) {
            if (generation === this.workingTreeReadGeneration) {
                console.warn('无法读取工作区变更:', error);
            }
        }
    }

    private applyWorkingTreeSnapshot(repositoryPath: string | undefined, changes: WorkingTreeChanges): void {
        if (repositoryPath === this.workingTreeRepositoryPath && this.workingTree.equals(changes)) { return; }
        this.workingTreeRepositoryPath = repositoryPath;
        this.workingTree = changes;
        this.setHasUncommittedChanges(changes.staged.length + changes.changes.length > 0);
        this.workingTreeEmitter.fire(this.workingTreeChanges);
    }

    private setHasUncommittedChanges(value: boolean): void {
        if (this._hasUncommittedChanges === value) { return; }
        this._hasUncommittedChanges = value;
        this.presenceEmitter.fire(value);
    }

    isRepositoryDocument(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') { return false; }
        return this.repositories.some(repository => {
            const rootPath = vscode.Uri.parse(repository.path).fsPath;
            return uri.fsPath === rootPath || uri.fsPath.startsWith(`${rootPath}${path.sep}`);
        });
    }

    // 顺序无关的 name 集合比较: 上游 fire 的数组顺序不稳定。
    private sameNames(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const names = new Set(left.map(branch => branch.name));
        return right.every(branch => names.has(branch.name));
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
