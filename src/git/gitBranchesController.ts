import * as vscode from 'vscode';
import { GitBranchOption, type GitBranchKind, type GitRepositoryOption } from '../types';

import { SelectedRepoTotalBranchWatcher } from './selectedRepoTotalBranchWatcher';
import { GitRepoController } from './gitRepoController';

/**
 * 分支选择维度的控制器。
 * 分支总列表由 SelectedRepoTotalBranchWatcher 唯一持有，本类只负责仓库范围聚合、HEAD/选择事件和用户选择状态。
 */
export class GitBranchesController implements vscode.Disposable {
    // 已消费的仓库选择快照; 仓库集合的唯一存放处。
    private repositories: GitRepositoryOption[] = [];
    private readonly selectedBranchNamesByRepository = new Map<string, Set<string>>();
    // 与 GitRepoController.hasUserSelection 对称: 用户手动选过分支后不再自动回填默认当前分支。
    private hasUserSelection = false;

    private _isLoading = false;

    private readonly branchesEmitter = new vscode.EventEmitter<Map<GitRepositoryOption, GitBranchOption[]>>();
    private readonly branchHeadEmitter = new vscode.EventEmitter<void>();
    private readonly currentHeadBranchEmitter = new vscode.EventEmitter<{ repositoryPath: string; branch: GitBranchOption | undefined }>();
    private readonly selectedEmitter = new vscode.EventEmitter<Map<GitRepositoryOption, GitBranchOption[]>>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly repositorySelectionSubscription: vscode.Disposable;
    private readonly totalBranchesSubscription: vscode.Disposable;
    private readonly totalBranchesLoadingSubscription: vscode.Disposable;

    readonly onTotalBranchesListChanged = this.branchesEmitter.event;
    readonly onBranchHeadCommitChanged = this.branchHeadEmitter.event;
    readonly onEachRepoCurrentHeadBranchChanged = this.currentHeadBranchEmitter.event;
    readonly onSelectedBranchesChanged = this.selectedEmitter.event;
    // 加载态与分支列表分开发事件, 避免调用方靠覆盖顺序抢某一帧。
    readonly onBranchesLoadingChanged = this.loadingEmitter.event;

    constructor(
        repoController: GitRepoController,
        private readonly totalBranchWatcher: SelectedRepoTotalBranchWatcher,
    ) {
        this.repositorySelectionSubscription = repoController.onSelectedRepoListChanged(repositories => {
            void this.selectRepositories(repositories);
        });
        this.totalBranchesSubscription = totalBranchWatcher.onRepositoryBranchesChanged(snapshot => {
            this.applyTotalBranches(snapshot.repository, snapshot.branches, snapshot.headChanged);
        });
        for (const snapshot of totalBranchWatcher.getRepositorySnapshots()) {
            this.applyTotalBranches(snapshot.repository, snapshot.branches, snapshot.headChanged);
        }
        this._isLoading = totalBranchWatcher.isLoading;
        this.totalBranchesLoadingSubscription = totalBranchWatcher.onBranchesLoadingChanged(loading => {
            this._isLoading = loading;
            this.loadingEmitter.fire(loading);
        });
    }

    /** 当前仓库集合的分支列表; 传 kind 则只返回该类。 */
    getBranches(kind?: GitBranchKind): readonly GitBranchOption[] {
        const all = this.repositories.flatMap(repository => this.totalBranchWatcher.getTotalBranches(repository));
        return kind ? all.filter(branch => branch.kind === kind) : all;
    }

    /** 当前已选分支中的当前分支。 */
    getSelectedCurrentBranch(): GitBranchOption | undefined {
        return this.selectedBranches.find(branch => branch.kind === 'current');
    }

    private get selectedBranches(): GitBranchOption[] {
        return this.repositories.flatMap(repository => {
            const names = this.selectedBranchNamesByRepository.get(repository.path);
            return this.totalBranchWatcher.getTotalBranches(repository).filter(branch => names?.has(branch.name));
        });
    }

    getSelectedBranchesByRepository(): ReadonlyMap<GitRepositoryOption, GitBranchOption[]> {
        const selected = new Map<GitRepositoryOption, GitBranchOption[]>();
        for (const branch of this.selectedBranches) {
            const branches = selected.get(branch.repoOption) ?? [];
            branches.push(branch);
            selected.set(branch.repoOption, branches);
        }
        return selected;
    }

    /** 指定仓库的当前分支。 */
    getCurrentBranch(repository: GitRepositoryOption): GitBranchOption | undefined {
        return this.totalBranchWatcher.getTotalBranches(repository).find(branch => branch.kind === 'current');
    }

    /**
     * 唯一内部仓库选择入口：只能由 GitRepoController.onSelectedRepoListChanged 调用。
     * 内容不一致时先取消旧的当前分支和分支列表读取，再启动新流程。
     */
    private async selectRepositories(repositories: readonly GitRepositoryOption[]): Promise<void> {
        if (this.sameRepositories(this.repositories, repositories)) { return; }
        this.repositories = [...repositories];
        const keep = new Set(this.repositories.map(repository => repository.path));
        this.pruneSelected(keep);
        // 已缓存当前分支的仓库立即回填默认选择; 尚未读到 HEAD 的仓库由 applyTotalBranches 到达时补。
        const defaulted = this.ensureDefaultSelection();
        this.fireBranches();
        if (defaulted) { this.fireSelected(); }
    }

    /**
     * 默认选择: 用户从未手动选过分支时, 为已选仓库中尚无勾选的仓库自动选中其当前分支 (kind==='current')。
     * 与 GitRepoController「默认选第一个仓库」对称; 当前分支 HEAD 是异步读入的, 故到达处 (applyTotalBranches) 也要调用。
     * 返回是否新增了默认选择。
     */
    private ensureDefaultSelection(): boolean {
        if (this.hasUserSelection) { return false; }
        let changed = false;
        for (const repository of this.repositories) {
            if (this.selectedBranchNamesByRepository.has(repository.path)) { continue; }
            const current = this.totalBranchWatcher.getTotalBranches(repository).find(branch => branch.kind === 'current');
            if (!current) { continue; }
            this.selectedBranchNamesByRepository.set(repository.path, new Set([current.name]));
            changed = true;
        }
        return changed;
    }

    /**
     * 强制重读 branchesMap; 跳过去重, 对全部入选仓库重新读取。
     * 用于 checkout / fetch / watcher 后 —— 清缓存本身不触发读取, 这里才是「去读」的入口。
     */
    forceRefresh(): void {
        this.totalBranchWatcher.refreshSelectedRepositories();
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
        if (this.sameSelected(this.selectedBranches, next)) { return false; }
        this.hasUserSelection = true;
        this._isLoading = true;
        this.loadingEmitter.fire(true);
        this.replaceSelected(next);
        this.fireSelected();
        this._isLoading = false;
        this.loadingEmitter.fire(false);
        return true;
    }

    dispose(): void {
        this.repositorySelectionSubscription.dispose();
        this.totalBranchesSubscription.dispose();
        this.totalBranchesLoadingSubscription.dispose();
        this.branchesEmitter.dispose();
        this.branchHeadEmitter.dispose();
        this.currentHeadBranchEmitter.dispose();
        this.selectedEmitter.dispose();
        this.loadingEmitter.dispose();
    }

    private applyTotalBranches(
        repository: GitRepositoryOption,
        branches: readonly GitBranchOption[],
        headChanged: boolean,
    ): void {
        if (!this.repositories.some(candidate => candidate.path === repository.path)) { return; }
        if (headChanged) {
            this.currentHeadBranchEmitter.fire({
                repositoryPath: repository.path,
                branch: branches.find(branch => branch.kind === 'current'),
            });
            this.branchHeadEmitter.fire();
        }
        // 当前分支此刻才异步到达, 是回填默认选择的关键时机 (仓库变化时该仓库 HEAD 可能尚未读到)。
        const defaulted = this.ensureDefaultSelection();
        this.fireBranches();
        if (headChanged || defaulted) { this.fireSelected(); }
    }

    /** 仓库集合变化时先删除旧仓库的勾选，避免新列表与旧勾选组合成一帧。 */
    private pruneSelected(keep: ReadonlySet<string>): boolean {
        let changed = false;
        for (const repositoryPath of this.selectedBranchNamesByRepository.keys()) {
            if (!keep.has(repositoryPath)) {
                this.selectedBranchNamesByRepository.delete(repositoryPath);
                changed = true;
            }
        }
        return changed;
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
            for (const branch of this.totalBranchWatcher.getTotalBranches(repository)) {
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

    private sameSelected(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        if (left.length !== right.length) { return false; }
        const namesByRepository = new Map<string, Set<string>>();
        for (const branch of left) {
            const names = namesByRepository.get(branch.repoOption.path) ?? new Set<string>();
            names.add(branch.name);
            namesByRepository.set(branch.repoOption.path, names);
        }
        return right.every(branch => namesByRepository.get(branch.repoOption.path)?.has(branch.name) ?? false);
    }

    private replaceSelected(branches: readonly GitBranchOption[]): void {
        this.selectedBranchNamesByRepository.clear();
        for (const branch of branches) {
            const names = this.selectedBranchNamesByRepository.get(branch.repoOption.path) ?? new Set<string>();
            names.add(branch.name);
            this.selectedBranchNamesByRepository.set(branch.repoOption.path, names);
        }
    }

    // 对外形态以 GitRepositoryOption 为 key, 由内部按 path 索引的真值现场转出。
    private fireBranches(): void {
        const snapshot = new Map<GitRepositoryOption, GitBranchOption[]>();
        for (const repository of this.repositories) {
            snapshot.set(repository, [...this.totalBranchWatcher.getTotalBranches(repository)]);
        }
        this.branchesEmitter.fire(snapshot);
    }

    private fireSelected(): void {
        const snapshot = new Map<GitRepositoryOption, GitBranchOption[]>();
        for (const branch of this.selectedBranches) {
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
