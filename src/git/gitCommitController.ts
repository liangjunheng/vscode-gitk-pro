import * as vscode from 'vscode';
import type {
    ChangeSetMode,
    DiffPayload,
    GitBranchOption,
    GitCommit,
    GitRepositoryOption,
    RepositoryCommit,
} from '../types';
import { DiffReader } from './diffReader';
import {
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
 * - isLoading 在任何 await 之前同步置位, 在途请求一律丢弃, 因此无需代次机制;
 * - 不接受外部 AbortSignal, 读取有效性只取决于自身是否完成;
 * - selectedBranches 只读不写, 任何失败都不改动它;
 * - selectedCommit 仅首次默认取首条, 刷新列表时一律不动;
 * - 两个内容读取方法是纯查询, 不写状态不发事件不受 isLoading 限制。
 */
export class GitCommitController implements vscode.Disposable {
    private branches: GitBranchOption[] = [];
    private repositories: GitRepositoryOption[] = [];
    private keywords: string[] = [];
    private searched: RepositoryCommit[] = [];
    private total: RepositoryCommit[] = [];
    private selected?: RepositoryCommit;
    private loading = false;
    private pendingForceRefresh = false;
    /**
     * 内容读取专用实例, 不与 Provider 共用。
     *
     * DiffReader 的 stop() 会推进内部 requestGeneration 并 kill 全部子进程,
     * 共用一个实例时 Provider 侧的 stop() 会连坐中止控制器的纯查询。
     */
    private readonly diffReader = new DiffReader();

    private readonly searchedEmitter = new vscode.EventEmitter<RepositoryCommit[]>();
    private readonly totalEmitter = new vscode.EventEmitter<RepositoryCommit[]>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();

    readonly onSearchedCommitsChanged = this.searchedEmitter.event;
    readonly onTotalCommitsChanged = this.totalEmitter.event;
    readonly onLoadingChanged = this.loadingEmitter.event;

    get selectedBranches(): readonly GitBranchOption[] { return this.branches; }
    get totalCommitList(): readonly RepositoryCommit[] { return this.total; }
    get searchedCommitList(): readonly RepositoryCommit[] { return this.searched; }
    get searchKeywords(): readonly string[] { return this.keywords; }
    get selectedCommit(): RepositoryCommit | undefined { return this.selected; }
    get isLoading(): boolean { return this.loading; }

    /**
     * 分支头变化后的强制刷新入口。
     * 不改 selectedBranches；在途时记账，当前刷新收尾后补跑，避免 watcher 事件丢失。
     */
    forceRefresh(): void {
        if (this.loading) {
            this.pendingForceRefresh = true;
            return;
        }
        if (this.branches.length === 0 || this.repositories.length === 0) { return; }
        this.loading = true;
        void this.refresh(true);
    }

    /**
     * 刷新入口一: 分支选择变化。
     * 返回是否真的发起了刷新, 便于调用方决定要不要进入加载态。
     */
    async selectBranches(branches: readonly GitBranchOption[], repositories: readonly GitRepositoryOption[]): Promise<boolean> {
        // 在途即丢弃; 置位在任何 await 之前, 确保后续请求必然被拦住。
        if (this.loading) { return false; }
        if (this.sameNames(this.branches, branches)) { return false; }
        this.loading = true;
        this.branches = [...branches];
        this.repositories = [...repositories];
        await this.refresh(true);
        return true;
    }

    /** 刷新入口二: 关键字变化; 空数组表示不过滤。 */
    async search(keywords: readonly string[], repositories: readonly GitRepositoryOption[]): Promise<RepositoryCommit[]> {
        if (this.loading) { return [...this.searched]; }
        if (this.sameKeywords(this.keywords, keywords)) { return [...this.searched]; }
        this.loading = true;
        this.keywords = [...keywords];
        this.repositories = [...repositories];
        // 关键字变化不影响未过滤的全量列表与工作区状态。
        await this.refresh(false);
        return [...this.searched];
    }

    /** 用户操作入口, 唯一允许主动改 selectedCommit 的公开方法。 */
    selectCommit(commit: RepositoryCommit): boolean {
        // 不校验是否在列表中: selectedCommit 允许指向列表外的提交。
        if (this.isSameCommit(this.selected, commit)) { return false; }
        this.selected = commit;
        return true;
    }

    /** 纯查询: 读取某提交的 Diff 内容, 不改状态不发事件。 */
    async getCommitContent(hash: string, repositoryPath: string): Promise<DiffPayload[]> {
        const rootUri = vscode.Uri.parse(repositoryPath);
        const files = await getCommitFiles(rootUri, hash);
        return this.diffReader.readDiffs(rootUri, hash, files, 'commit');
    }

    /**
     * 纯查询: 读取工作区 Changes / Staged 内容。
     * 每次都从本地重新读取, 不缓存 —— 工作区随时在变, 缓存失效时机无法确定。
     */
    async getVirtualCommitContent(
        mode: Exclude<ChangeSetMode, 'commit'>,
        repositoryPath: string,
    ): Promise<DiffPayload[]> {
        const rootUri = vscode.Uri.parse(repositoryPath);
        const changes = await getWorkingTreeChanges(rootUri);
        // 开关为 false 时不拒绝: 开关是上次刷新的快照, 此刻工作区可能已有新变更。
        const files = mode === 'staged' ? changes.staged : changes.changes;
        // hash 传空串: 工作区路径比对的是 HEAD/索引/磁盘, readDiffs 在非 commit 模式下不读该参数。
        return this.diffReader.readDiffs(rootUri, '', files, mode);
    }

    dispose(): void {
        this.diffReader.stop();
        this.searchedEmitter.dispose();
        this.totalEmitter.dispose();
        this.loadingEmitter.dispose();
    }

    /** 唯一的刷新流程；分支变化时额外刷新 totalCommitList。 */
    private async refresh(branchesChanged: boolean): Promise<void> {
        this.loadingEmitter.fire(true);
        try {
            const refs = this.branches.map(branch => branch.name);
            this.searched = await this.readCommits(refs, this.keywords);
            this.searchedEmitter.fire([...this.searched]);
            if (branchesChanged) {
                // 两个列表不得共享提交对象: buildGraph 原地改图形字段, 共享会互相污染布局。
                // 关键字为空时内容相同, 仍需独立读取一份而不能直接复用 searched。
                this.total = await this.readCommits(refs, []);
                this.totalEmitter.fire([...this.total]);
            }
            // 仅首次赋值; 已有选中项一律不动, 即使已不在新列表中。
            if (!this.selected && this.searched.length > 0) {
                this.selected = this.searched[0];
            }
        } catch (error) {
            // 保留 selectedBranches 与已有列表原样, 如实反映失败。
            console.warn('无法读取提交列表:', error);
        } finally {
            // 必须置回, 否则后续请求会被规则 3 全部丢弃。
            this.loading = false;
            this.loadingEmitter.fire(false);
            if (this.pendingForceRefresh) {
                this.pendingForceRefresh = false;
                this.forceRefresh();
            }
        }
    }

    /** 按仓库并行读取并建图; 关键字非空走搜索, 否则走普通读取。 */
    private async readCommits(refs: readonly string[], keywords: readonly string[]): Promise<RepositoryCommit[]> {
        if (this.repositories.length === 0 || refs.length === 0) { return []; }
        const pages = await Promise.all(this.repositories.map(async repository => {
            const rootUri = vscode.Uri.parse(repository.path);
            const commits = keywords.length > 0
                ? await searchCommits(rootUri, [...keywords], refs)
                : await getGitCommits(rootUri, COMMIT_LIMIT, refs, 0);
            // 每个列表各自建图: buildGraph 原地改图形字段, 共享对象会互相污染。
            return this.buildGraph(commits).map(commit => ({ ...commit, repositoryPath: repository.path }));
        }));
        return pages.flat();
    }

    // 图形布局：按 VS Code SCM History 的 inputSwimlanes → outputSwimlanes 状态机转换。
    private buildGraph(commits: GitCommit[]): GitCommit[] {
        interface Swimlane { hash: string; color: string; }
        let outputSwimlanes: Swimlane[] = [];
        let nextColor = 0;
        const createSwimlane = (hash: string, color?: string): Swimlane => ({
            hash,
            color: color ?? LANE_COLORS[nextColor++ % LANE_COLORS.length],
        });

        for (const commit of commits) {
            const inputSwimlanes = outputSwimlanes.map(lane => ({ ...lane }));
            const inputIndex = inputSwimlanes.findIndex(lane => lane.hash === commit.hash);
            const lane = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
            const nextSwimlanes: Swimlane[] = [];
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
                nextSwimlanes.push({ ...inputLane });
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

    // 提交判等只比 hash + repositoryPath: 图形字段随布局变化, 全属性比较会误判。
    private isSameCommit(left: RepositoryCommit | undefined, right: RepositoryCommit | undefined): boolean {
        if (!left || !right) { return left === right; }
        return left.hash === right.hash && left.repositoryPath === right.repositoryPath;
    }

    // 顺序无关的 name 集合比较: 上游 fire 的数组顺序不稳定, current 分支变更标记不应触发提交重载。
    private sameNames(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const names = new Set(left.map(branch => branch.name));
        return right.every(branch => names.has(branch.name));
    }

    private sameKeywords(left: readonly string[], right: readonly string[]): boolean {
        return left.length === right.length && left.every((keyword, index) => keyword === right[index]);
    }
}
