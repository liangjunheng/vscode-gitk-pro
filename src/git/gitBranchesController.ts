import * as vscode from 'vscode';
import { GitBranchOption, type GitBranchKind, type GitRepositoryOption } from '../types';
import { getGitBranches } from './gitLogProvider';

import { RepoHeadBranchWatcher } from './gitRepoHeadBranchWatcher';
import { GitRepoController } from './gitRepoController';

/** 已选分支带仓库归属: 分支名在不同仓库间会重名, 裸名字无法定位归属。 */
/**
 * 分支维度状态的唯一写入者。
 *
 * 只管分支, 不涉及仓库发现/提交/变更文件, 也不直接操作 Webview。
 * 全部行为只有五条:
 * 1. 监听仓库变化 (selectRepositories 是唯一输入入口);
 * 2. 内容与已消费快照一致则整个调用返回, 不改状态不发通知不发起 IO;
 * 3. loading 期间收到不同仓库选择时，取消旧的当前分支/分支列表读取并立即启动新流程;
 * 4. branchesMap 变化不影响 selected, 唯一例外是新仓库快路径落地时追加其当前分支;
 * 5. forceRefresh 跳过第 2 条去重, 强制重读全部分片。
 *
 * 关键约束:
 * - 每轮内部创建 AbortController，并以代次阻止旧流程落地或关闭新流程 loading;
 * - repositories 快照的替换必须与刷新绑定;
 * - 内部一律以 path 为 key, 因选项不可变、copy 后引用会变, Map 引用判等必然 miss;
 * - 分支/仓库选项判等一律走 equals 而非 ===。
 */
export class GitBranchesController implements vscode.Disposable {
    // 已消费的仓库选择快照; 仓库集合的唯一存放处。
    private repositories: GitRepositoryOption[] = [];
    // key 用 path: 选项对象经 copy 后引用会变, Map 按引用判等会查不到。
    private readonly branches = new Map<string, GitBranchOption[]>();
    private _selectedBranches: GitBranchOption[] = [];

    private branchReadAbortController?: AbortController;
    private branchReadGeneration = 0;
    private _isLoading = false;

    private readonly branchesEmitter = new vscode.EventEmitter<Map<GitRepositoryOption, GitBranchOption[]>>();
    private readonly branchHeadEmitter = new vscode.EventEmitter<void>();
    private readonly currentHeadBranchEmitter = new vscode.EventEmitter<{ repositoryPath: string; branch: GitBranchOption | undefined }>();
    private readonly selectedEmitter = new vscode.EventEmitter<Map<GitRepositoryOption, GitBranchOption[]>>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly repositorySelectionSubscription: vscode.Disposable;
    private readonly headBranchSubscription: vscode.Disposable;

    readonly onTotalBranchesListChanged = this.branchesEmitter.event;
    readonly onBranchHeadCommitChanged = this.branchHeadEmitter.event;
    readonly onEachRepoCurrentHeadBranchChanged = this.currentHeadBranchEmitter.event;
    readonly onSelectedBranchesChanged = this.selectedEmitter.event;
    // 加载态与分支列表分开发事件, 避免调用方靠覆盖顺序抢某一帧。
    readonly onBranchesLoadingChanged = this.loadingEmitter.event;

    constructor(repoController: GitRepoController, private readonly repoHeadBranchWatcher: RepoHeadBranchWatcher) {
        this.repositorySelectionSubscription = repoController.onSelectedRepoListChanged(repositories => {
            void this.selectRepositories(repositories);
        });
        this.headBranchSubscription = repoHeadBranchWatcher.onEachRepoHeadBranchChanged(event => {
            this.applyHeadBranchChanged(event.repositoryPath, event.headBranch);
        });
    }

    /** 当前仓库集合的分支列表; 传 kind 则只返回该类。 */
    getBranches(kind?: GitBranchKind): readonly GitBranchOption[] {
        const all = this.repositories.flatMap(repository => this.branches.get(repository.path) ?? []);
        return kind ? all.filter(branch => branch.kind === kind) : all;
    }

    /** 当前已选分支中的当前分支。 */
    getSelectedCurrentBranch(): GitBranchOption | undefined {
        for (const entry of this._selectedBranches) {
            if (entry.kind === 'current') { return entry; }
        }
        return undefined;
    }

    /** 指定仓库的当前分支。 */
    getCurrentBranch(repository: GitRepositoryOption): GitBranchOption | undefined {
        return this.branches.get(repository.path)?.find(branch => branch.kind === 'current');
    }

    /**
     * 唯一内部仓库选择入口：只能由 GitRepoController.onSelectedRepoListChanged 调用。
     * 内容不一致时先取消旧的当前分支和分支列表读取，再启动新流程。
     */
    private async selectRepositories(repositories: readonly GitRepositoryOption[]): Promise<void> {
        if (this.sameRepositories(this.repositories, repositories)) { return; }
        this.branchReadAbortController?.abort();
        await this.refresh(repositories, false);
    }

    /**
     * 强制重读 branchesMap; 跳过去重, 对全部入选仓库重新读取。
     * 用于 checkout / fetch / watcher 后 —— 清缓存本身不触发读取, 这里才是「去读」的入口。
     */
    forceRefresh(): void {
        if (this._isLoading) { return; }
        void this.refresh(this.repositories, true);
    }

    /**
     * 用户操作入口, 唯一允许改 selected 的公开方法; 加载在途期间同样生效。
     * 返回是否被接受, 便于调用方决定要不要进入加载态 —— 否则被忽略的调用会让 UI 停在假 loading。
     */
    selectBranches(branches: readonly GitBranchOption[]): boolean {
        if (this._isLoading) { return false; }
        const next: GitBranchOption[] = [];
        for (const candidate of branches) {
            const resolved = this.resolveBranch(candidate);
            // 校验 1: 任一项无法解析到归属仓库则整个调用忽略。
            if (!resolved) { return false; }
            const duplicated = next.some(entry => entry.repoOption.equals(resolved.repoOption)
                && entry.equals(resolved));
            if (!duplicated) { next.push(resolved); }
        }
        // 校验 2: 与当前选择完全相同直接返回, 避免重复点击引发无意义的提交重载。
        if (this.sameSelected(this._selectedBranches, next)) { return false; }
        // 空数组是合法入参: 用户取消全部勾选就该得到空选择。
        this._isLoading = true;
        this.loadingEmitter.fire(true);
        this._selectedBranches = next;
        this.fireSelected();
        this._isLoading = false;
        this.loadingEmitter.fire(false);
        return true;
    }

    dispose(): void {
        this.repositorySelectionSubscription.dispose();
        this.headBranchSubscription.dispose();
        this.branchReadAbortController?.abort();
        this.branchesEmitter.dispose();
        this.branchHeadEmitter.dispose();
        this.currentHeadBranchEmitter.dispose();
        this.selectedEmitter.dispose();
        this.loadingEmitter.dispose();
    }

    /**
     * 两阶段刷新。loading 必须在任何 await 之前同步置位, 否则两个请求都能通过门禁。
     * repositories 的替换与刷新绑定: 被丢弃的那轮快照不动, 下次事件比较必然不一致可自行修正。
     */
    private async refresh(repositories: readonly GitRepositoryOption[], force: boolean): Promise<void> {
        const generation = ++this.branchReadGeneration;
        const abortController = new AbortController();
        this.branchReadAbortController = abortController;
        this._isLoading = true;
        this.loadingEmitter.fire(true);
        this.repositories = [...repositories];
        const keep = new Set(this.repositories.map(repository => repository.path));
        const removedCurrentPaths = [...this.branches.entries()]
            .filter(([repositoryPath, branches]) => !keep.has(repositoryPath) && branches.some(branch => branch.kind === 'current'))
            .map(([repositoryPath]) => repositoryPath);
        // 先更新内部选择但不立即通知，避免仓库切换时先发布空分支并触发一次无效提交读取。
        this.pruneSelected(keep);
        this.pruneRemoved(keep);
        for (const repositoryPath of removedCurrentPaths) {
            this.currentHeadBranchEmitter.fire({ repositoryPath, branch: undefined });
        }
        // force 时对全部入选仓库重读; 否则只处理还没有分片的仓库。
        const targets = force
            ? [...this.repositories]
            : this.repositories.filter(repository => !this.branches.has(repository.path));
        this.fireBranches();
        try {
            // 当前 HEAD 与完整分支列表独立读取：先启动两者，当前 HEAD 完成即发布默认选择。
            const currentBranchesPromise = !force
                ? Promise.all(this.repositories.map(
                    repository => this.applyCurrentBranch(repository, abortController.signal, generation),
                ))
                : undefined;
            const loadedPromise = Promise.all(targets.map(async repository => {
                try {
                    const [branches, current] = await Promise.all([
                        getGitBranches(vscode.Uri.parse(repository.path), abortController.signal),
                        this.repoHeadBranchWatcher.getHeadBranchByRepo(repository),
                    ]);
                    return {
                        repository,
                        branches: this.withCurrentHead(repository, branches, current),
                    };
                } catch (error) {
                    if (!abortController.signal.aborted) {
                        // 单仓库失败不影响其他仓库落地; 快路径写入的当前分支保留。
                        console.warn('无法读取分支列表:', error);
                    }
                    return undefined;
                }
            }));
            if (currentBranchesPromise) {
                const currentBranches = await currentBranchesPromise;
                if (abortController.signal.aborted || generation !== this.branchReadGeneration) { return; }
                const defaults = currentBranches.flatMap(entry => entry ? [entry] : []);
                this._selectedBranches = this.dedupeSelected([...this._selectedBranches, ...defaults]);
                this.fireSelected();
            }
            const loaded = await loadedPromise;
            if (abortController.signal.aborted || generation !== this.branchReadGeneration) { return; }
            let changed = false;
            let headChanged = false;
            for (const entry of loaded) {
                // 期间可能已被移出选择, 落地前再确认一次。
                if (!entry || !keep.has(entry.repository.path)) { continue; }
                const previous = this.branches.get(entry.repository.path);
                const previousHead = previous?.find(branch => branch.kind === 'current');
                const nextHead = entry.branches.find(branch => branch.kind === 'current');
                if (previousHead && nextHead && previousHead.hash !== nextHead.hash) {
                    headChanged = true;
                }
                if (previous && this.sameBranches(previous, entry.branches)) { continue; }
                // 整体替换, 不是「先清空再填充」。
                this.branches.set(entry.repository.path, [...entry.branches]);
                if (previousHead?.name !== nextHead?.name || previousHead?.hash !== nextHead?.hash) {
                    this.currentHeadBranchEmitter.fire({ repositoryPath: entry.repository.path, branch: nextHead });
                }
                changed = true;
            }
            // 全量落地一律不碰 selected: 初值已由快路径给出, 重算只会多 fire 一次。
            if (changed) { this.fireBranches(); }
            if (headChanged) { this.branchHeadEmitter.fire(); }
        } finally {
            // 旧流程被取消后不能结束新流程的 loading，也不能清空新流程的取消控制器。
            if (generation !== this.branchReadGeneration) { return; }
            this.branchReadAbortController = undefined;
            this._isLoading = false;
            this.loadingEmitter.fire(false);
        }
    }

    /** 新仓库快路径：当前 HEAD 由 RepoHeadBranchWatcher 唯一提供。 */
    private async applyCurrentBranch(
        repository: GitRepositoryOption,
        signal: AbortSignal,
        generation: number,
    ): Promise<GitBranchOption | undefined> {
        const current = await this.repoHeadBranchWatcher.getHeadBranchByRepo(repository);
        // 空仓库无 HEAD 或旧流程已取消, 均不再落地。
        if (!current || signal.aborted || generation !== this.branchReadGeneration) { return undefined; }
        // 期间可能已被移出选择。
        if (!this.repositories.some(option => option.path === repository.path)) { return undefined; }
        if (!this.branches.has(repository.path)) {
            this.branches.set(repository.path, [current]);
            this.fireBranches();
            this.currentHeadBranchEmitter.fire({ repositoryPath: repository.path, branch: current });
        }
        return current;
    }

    private withCurrentHead(
        repository: GitRepositoryOption,
        branches: readonly GitBranchOption[],
        current: GitBranchOption | undefined,
    ): GitBranchOption[] {
        const withoutCurrent = branches.filter(branch => branch.kind !== 'current');
        return current ? [current, ...withoutCurrent] : withoutCurrent;
    }

    private applyHeadBranchChanged(repositoryPath: string, headBranch: GitBranchOption | undefined): void {
        const repository = this.repositories.find(candidate => candidate.path === repositoryPath);
        if (!repository) { return; }
        const previous = this.branches.get(repositoryPath) ?? [];
        const next = this.withCurrentHead(repository, previous, headBranch);
        const previousHead = previous.find(branch => branch.kind === 'current');
        const nextHead = next.find(branch => branch.kind === 'current');
        if (previousHead?.name === nextHead?.name && previousHead?.hash === nextHead?.hash) { return; }
        this.branches.set(repositoryPath, next);
        const selected = this._selectedBranches.filter(branch => !(branch.repoOption.path === repositoryPath && branch.kind === 'current'));
        if (nextHead) { selected.push(nextHead); }
        this._selectedBranches = this.dedupeSelected(selected);
        this.fireBranches();
        this.fireSelected();
        this.currentHeadBranchEmitter.fire({ repositoryPath, branch: nextHead });
        this.branchHeadEmitter.fire();
    }

    /** 剔除不再入选的仓库分片。 */
    private pruneRemoved(keep: Set<string>): void {
        for (const path of [...this.branches.keys()]) {
            if (!keep.has(path)) { this.branches.delete(path); }
        }
    }

    /** 仓库集合变化时先删除旧仓库的勾选，避免新列表与旧勾选组合成一帧。 */
    private pruneSelected(keep: ReadonlySet<string>): boolean {
        const next = this._selectedBranches.filter(branch => keep.has(branch.repoOption.path));
        if (this.sameSelected(this._selectedBranches, next)) { return false; }
        this._selectedBranches = next;
        return true;
    }

    /**
     * 解析入参分支的仓库归属, 单次遍历按优先级取最佳匹配:
     * 属性全同 > name+hash > 仅 name。
     *
     * 中间那级是传对象的价值所在 —— 多仓库同名分支 (多个子模块都有 refs/heads/master)
     * 靠 hash 才能区分归属; 且对象经 copy (如更新变更标记) 后属性全同已不成立,
     * 若缺这一级就会直接落到按名字兜底而错配。
     */
    private resolveBranch(candidate: GitBranchOption): GitBranchOption | undefined {
        let hashMatch: GitBranchOption | undefined;
        let nameMatch: GitBranchOption | undefined;
        for (const repository of this.repositories) {
            for (const branch of this.branches.get(repository.path) ?? []) {
                const entry = branch;
                if (branch.equals(candidate)) { return entry; }
                if (branch.name === candidate.name && branch.hash === candidate.hash) { hashMatch ??= entry; }
                if (branch.name === candidate.name) { nameMatch ??= entry; }
            }
        }
        return hashMatch ?? nameMatch;
    }

    // 顺序无关的值比较: 上游 fire 的数组顺序不保证稳定。path 唯一, 故同长度 + 逐项命中即等价。
    private sameRepositories(left: readonly GitRepositoryOption[], right: readonly GitRepositoryOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const byPath = new Map(left.map(option => [option.path, option]));
        return right.every(option => {
            const other = byPath.get(option.path);
            return other !== undefined && option.equals(other);
        });
    }

    private sameBranches(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        return left.length === right.length
            && left.every((branch, index) => branch.equals(right[index]));
    }

    // 顺序无关的已选集合比较；同一仓库的同名分支是唯一业务键。
    private sameSelected(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const byRepository = new Map<string, Map<string, GitBranchOption>>();
        for (const branch of left) {
            const byName = byRepository.get(branch.repoOption.path) ?? new Map<string, GitBranchOption>();
            byName.set(branch.name, branch);
            byRepository.set(branch.repoOption.path, byName);
        }
        return right.every(branch => byRepository.get(branch.repoOption.path)?.get(branch.name)?.equals(branch) ?? false);
    }

    private dedupeSelected(selected: readonly GitBranchOption[]): GitBranchOption[] {
        const result: GitBranchOption[] = [];
        const namesByRepository = new Map<string, Set<string>>();
        for (const entry of selected) {
            const names = namesByRepository.get(entry.repoOption.path) ?? new Set<string>();
            if (names.has(entry.name)) { continue; }
            names.add(entry.name);
            namesByRepository.set(entry.repoOption.path, names);
            result.push(entry);
        }
        return result;
    }

    // 对外形态以 GitRepositoryOption 为 key, 由内部按 path 索引的真值现场转出。
    private fireBranches(): void {
        const snapshot = new Map<GitRepositoryOption, GitBranchOption[]>();
        for (const repository of this.repositories) {
            snapshot.set(repository, [...(this.branches.get(repository.path) ?? [])]);
        }
        this.branchesEmitter.fire(snapshot);
    }

    private fireSelected(): void {
        const snapshot = new Map<GitRepositoryOption, GitBranchOption[]>();
        for (const branch of this._selectedBranches) {
            const branches = snapshot.get(branch.repoOption);
            if (branches) {
                branches.push(branch);
            } else {
                snapshot.set(branch.repoOption, [branch]);
            }
        }
        this.selectedEmitter.fire(snapshot);
    }
}
