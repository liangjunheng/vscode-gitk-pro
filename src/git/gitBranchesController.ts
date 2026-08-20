import * as path from 'path';
import * as vscode from 'vscode';
import type { GitBranchKind, GitBranchOption, GitRepositoryOption } from '../types';
import { copyBranchOption, equalsBranchOption, equalsRepositoryOption } from '../types/git';
import {
    buildDetachedHeadBranch,
    getCurrentGitBranch,
    getCurrentGitHeadHash,
    getGitBranches,
    getWorkingTreeChangePresence,
} from './gitLogProvider';

/** 已选分支带仓库归属: 分支名在不同仓库间会重名, 裸名字无法定位归属。 */
interface SelectedBranch {
    readonly repository: GitRepositoryOption;
    readonly branch: GitBranchOption;
}

/**
 * 分支维度状态的唯一写入者。
 *
 * 只管分支, 不涉及仓库发现/提交/变更文件, 也不直接操作 Webview。
 * 全部行为只有五条:
 * 1. 监听仓库变化 (selectRepositories 是唯一输入入口);
 * 2. 内容与已消费快照一致则整个调用返回, 不改状态不发通知不发起 IO;
 * 3. isLoading 期间新请求一律丢弃, 不排队不打断;
 * 4. branchesMap 变化不影响 selectedBranches, 唯一例外是新仓库快路径落地时追加其当前分支;
 * 5. forceRefresh 跳过第 2 条去重, 强制重读全部分片。
 *
 * 关键约束:
 * - 不接受外部 AbortSignal, 也不需要代次: 在途即丢弃已消除并发竞争;
 * - repositories 快照的替换必须与刷新绑定, 不能在门禁之前替换;
 * - 内部一律以 path 为 key, 因选项不可变、copy 后引用会变, Map 引用判等必然 miss;
 * - 分支/仓库选项判等一律走 equals 而非 ===。
 */
export class GitBranchesController implements vscode.Disposable {
    // 已消费的仓库选择快照; 仓库集合的唯一存放处。
    private repositories: GitRepositoryOption[] = [];
    // key 用 path: 选项对象经 copy 后引用会变, Map 按引用判等会查不到。
    private readonly branches = new Map<string, GitBranchOption[]>();
    private selected: SelectedBranch[] = [];
    private readonly changeWatchers = new Map<string, vscode.Disposable>();
    private changeFlagRefreshTimer?: ReturnType<typeof setTimeout>;
    private pendingChangeFlagRefresh = false;
    private loading = false;

    private readonly branchesEmitter = new vscode.EventEmitter<Map<GitRepositoryOption, GitBranchOption[]>>();
    private readonly branchHeadEmitter = new vscode.EventEmitter<void>();
    private readonly selectedEmitter = new vscode.EventEmitter<Map<GitRepositoryOption, GitBranchOption[]>>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly workspaceChangeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (this.isRepositoryDocument(event.document.uri)) { this.scheduleCurrentBranchChangeFlagRefresh(); }
    });

    readonly onBranchesMapChanged = this.branchesEmitter.event;
    readonly onBranchHeadCommitChanged = this.branchHeadEmitter.event;
    readonly onSelectedBranchesChanged = this.selectedEmitter.event;
    // 加载态与分支列表分开发事件, 避免调用方靠覆盖顺序抢某一帧。
    readonly onBranchesLoadingChanged = this.loadingEmitter.event;

    get selectedBranches(): ReadonlyMap<GitRepositoryOption, GitBranchOption> {
        const snapshot = new Map<GitRepositoryOption, GitBranchOption>();
        for (const entry of this.selected) {
            if (!snapshot.has(entry.repository)) { snapshot.set(entry.repository, entry.branch); }
        }
        return snapshot;
    }
    get isLoading(): boolean { return this.loading; }

    /** 当前仓库集合的分支列表; 传 kind 则只返回该类。 */
    getBranches(kind?: GitBranchKind): readonly GitBranchOption[] {
        const all = this.repositories.flatMap(repository => this.branches.get(repository.path) ?? []);
        return kind ? all.filter(branch => branch.kind === kind) : all;
    }

    /** 指定仓库的当前分支。 */
    getCurrentBranch(repository: GitRepositoryOption): GitBranchOption | undefined {
        return this.branches.get(repository.path)?.find(branch => branch.kind === 'current');
    }

    /**
     * 唯一输入入口: 仓库选择变化。
     * 在途则丢弃 (快照不动), 内容一致则整个调用返回。
     */
    selectRepositories(repositories: readonly GitRepositoryOption[]): void {
        if (this.loading) { return; }
        if (this.sameRepositories(this.repositories, repositories)) { return; }
        void this.refresh(repositories, false);
    }

    /**
     * 强制重读 branchesMap; 跳过去重, 对全部入选仓库重新读取。
     * 用于 checkout / fetch / watcher 后 —— 清缓存本身不触发读取, 这里才是「去读」的入口。
     */
    forceRefresh(): void {
        if (this.loading) { return; }
        void this.refresh(this.repositories, true);
    }

    /**
     * 用户操作入口, 唯一允许改 selectedBranches 的公开方法; 加载在途期间同样生效。
     * 返回是否被接受, 便于调用方决定要不要进入加载态 —— 否则被忽略的调用会让 UI 停在假 loading。
     */
    selectBranches(branches: readonly GitBranchOption[]): boolean {
        if (this.loading) { return false; }
        const next: SelectedBranch[] = [];
        for (const candidate of branches) {
            const resolved = this.resolveBranch(candidate);
            // 校验 1: 任一项无法解析到归属仓库则整个调用忽略。
            if (!resolved) { return false; }
            const duplicated = next.some(entry => entry.repository.path === resolved.repository.path
                && entry.branch.name === resolved.branch.name);
            if (!duplicated) { next.push(resolved); }
        }
        // 校验 2: 与当前选择完全相同直接返回, 避免重复点击引发无意义的提交重载。
        if (this.sameSelected(this.selected, next)) { return false; }
        // 空数组是合法入参: 用户取消全部勾选就该得到空选择。
        this.loading = true;
        this.loadingEmitter.fire(true);
        this.selected = next;
        this.fireSelected();
        void this.refreshCurrentBranchChangeFlags().finally(() => {
            this.loading = false;
            this.loadingEmitter.fire(false);
            if (this.pendingChangeFlagRefresh) {
                this.pendingChangeFlagRefresh = false;
                this.scheduleCurrentBranchChangeFlagRefresh();
            }
        });
        return true;
    }

    dispose(): void {
        this.workspaceChangeSubscription.dispose();
        this.changeWatchers.forEach(watcher => watcher.dispose());
        this.changeWatchers.clear();
        if (this.changeFlagRefreshTimer) { clearTimeout(this.changeFlagRefreshTimer); }
        this.branchesEmitter.dispose();
        this.branchHeadEmitter.dispose();
        this.selectedEmitter.dispose();
        this.loadingEmitter.dispose();
    }

    /**
     * 两阶段刷新。isLoading 必须在任何 await 之前同步置位, 否则两个请求都能通过门禁。
     * repositories 的替换与刷新绑定: 被丢弃的那轮快照不动, 下次事件比较必然不一致可自行修正。
     */
    private async refresh(repositories: readonly GitRepositoryOption[], force: boolean): Promise<void> {
        this.loading = true;
        this.loadingEmitter.fire(true);
        this.repositories = [...repositories];
        const keep = new Set(this.repositories.map(repository => repository.path));
        this.syncChangeWatchers(keep);
        if (this.pruneSelected(keep)) { this.fireSelected(); }
        this.pruneRemoved(keep);
        // force 时对全部入选仓库重读; 否则只处理还没有分片的仓库。
        const targets = force
            ? [...this.repositories]
            : this.repositories.filter(repository => !this.branches.has(repository.path));
        this.fireBranches();
        try {
            // 快路径只对新仓库执行: 已有分片的仓库退回单条当前分支是把有效数据换成更差的数据,
            // 还会连带触碰它已有的选择。force 一律不走快路径。
            if (!force) {
                const currentBranches = await Promise.all(this.repositories.map(repository => this.applyCurrentBranch(repository)));
                const defaults = currentBranches.flatMap(entry => entry ? [entry] : []);
                this.selected = this.dedupeSelected([...this.selected, ...defaults]);
                this.fireSelected();
            }
            const loaded = await Promise.all(targets.map(async repository => {
                try {
                    return { repository, branches: await getGitBranches(vscode.Uri.parse(repository.path)) };
                } catch (error) {
                    // 单仓库失败不影响其他仓库落地; 快路径写入的当前分支保留。
                    console.warn('无法读取分支列表:', error);
                    return undefined;
                }
            }));
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
                changed = true;
            }
            // 全量落地一律不碰 selectedBranches: 初值已由快路径给出, 重算只会多 fire 一次。
            if (changed) { this.fireBranches(); }
            if (headChanged) { this.branchHeadEmitter.fire(); }
            await this.refreshCurrentBranchChangeFlags();
        } finally {
            // 必须收敛, 否则控制器永久拒绝后续请求。
            this.loading = false;
            this.loadingEmitter.fire(false);
            if (this.pendingChangeFlagRefresh) {
                this.pendingChangeFlagRefresh = false;
                this.scheduleCurrentBranchChangeFlagRefresh();
            }
        }
    }

    /**
     * 快路径: 读当前分支并返回带仓库归属的默认选择。
     * 只有尚无分片时才写单条 branchesMap；selectedBranches 由调用方汇总、去重后统一回调。
     */
    private async applyCurrentBranch(repository: GitRepositoryOption): Promise<SelectedBranch | undefined> {
        const current = await this.readCurrentBranch(vscode.Uri.parse(repository.path));
        // 空仓库无 HEAD, 等全量结果收尾。
        if (!current) { return undefined; }
        // 期间可能已被移出选择。
        if (!this.repositories.some(option => option.path === repository.path)) { return undefined; }
        if (!this.branches.has(repository.path)) {
            this.branches.set(repository.path, [current]);
            this.fireBranches();
        }
        return { repository, branch: current };
    }

    // 当前分支: 正常分支用 refs/heads/*, detached HEAD 用裸 hash 兜底, 无 HEAD 才放弃。
    private async readCurrentBranch(rootUri: vscode.Uri): Promise<GitBranchOption | undefined> {
        const [branchName, headHash] = await Promise.all([
            getCurrentGitBranch(rootUri).catch(() => undefined),
            getCurrentGitHeadHash(rootUri).catch(() => undefined),
        ]);
        // 判据只能是 !headHash: detached 时 symbolic-ref 按 Git 约定失败, branchName 恒 undefined。
        if (!headHash) { return undefined; }
        return branchName
            ? { name: branchName, label: branchName.replace(/^refs\/heads\//, ''), hash: headHash, kind: 'current' }
            : buildDetachedHeadBranch(headHash);
    }

    /** 剔除不再入选的仓库分片。 */
    private pruneRemoved(keep: Set<string>): void {
        for (const path of [...this.branches.keys()]) {
            if (!keep.has(path)) { this.branches.delete(path); }
        }
    }

    /** 仓库集合变化时先删除旧仓库的勾选，避免新列表与旧勾选组合成一帧。 */
    private pruneSelected(keep: ReadonlySet<string>): boolean {
        const next = this.selected.filter(entry => keep.has(entry.repository.path));
        if (this.sameSelected(this.selected, next)) { return false; }
        this.selected = next;
        return true;
    }

    private syncChangeWatchers(keep: ReadonlySet<string>): void {
        for (const [repositoryPath, watcher] of this.changeWatchers) {
            if (keep.has(repositoryPath)) { continue; }
            watcher.dispose();
            this.changeWatchers.delete(repositoryPath);
        }
        for (const repositoryPath of keep) {
            if (this.changeWatchers.has(repositoryPath)) { continue; }
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(repositoryPath), '.git/index'));
            const refresh = () => this.scheduleCurrentBranchChangeFlagRefresh();
            this.changeWatchers.set(repositoryPath, vscode.Disposable.from(
                watcher,
                watcher.onDidCreate(refresh),
                watcher.onDidChange(refresh),
                watcher.onDidDelete(refresh),
            ));
        }
    }

    private isRepositoryDocument(uri: vscode.Uri): boolean {
        return this.repositories.some(repository => uri.scheme === 'file'
            && (uri.fsPath === vscode.Uri.parse(repository.path).fsPath
                || uri.fsPath.startsWith(`${vscode.Uri.parse(repository.path).fsPath}${path.sep}`)));
    }

    private scheduleCurrentBranchChangeFlagRefresh(): void {
        if (this.loading) {
            this.pendingChangeFlagRefresh = true;
            return;
        }
        if (this.changeFlagRefreshTimer) { clearTimeout(this.changeFlagRefreshTimer); }
        this.changeFlagRefreshTimer = setTimeout(() => {
            this.changeFlagRefreshTimer = undefined;
            if (this.loading) {
                this.pendingChangeFlagRefresh = true;
                return;
            }
            void this.refreshCurrentBranchChangeFlags();
        }, 300);
    }

    /**
     * 解析入参分支的仓库归属, 单次遍历按优先级取最佳匹配:
     * 属性全同 > name+hash > 仅 name。
     *
     * 中间那级是传对象的价值所在 —— 多仓库同名分支 (多个子模块都有 refs/heads/master)
     * 靠 hash 才能区分归属; 且对象经 copy (如更新变更标记) 后属性全同已不成立,
     * 若缺这一级就会直接落到按名字兜底而错配。
     */
    private resolveBranch(candidate: GitBranchOption): SelectedBranch | undefined {
        let hashMatch: SelectedBranch | undefined;
        let nameMatch: SelectedBranch | undefined;
        for (const repository of this.repositories) {
            for (const branch of this.branches.get(repository.path) ?? []) {
                if (branch.name !== candidate.name) { continue; }
                const entry: SelectedBranch = { repository, branch };
                if (equalsBranchOption(branch, candidate)) { return entry; }
                if (branch.hash === candidate.hash) { hashMatch ??= entry; }
                nameMatch ??= entry;
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
            return other !== undefined && equalsRepositoryOption(option, other);
        });
    }

    private sameBranches(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        return left.length === right.length
            && left.every((branch, index) => equalsBranchOption(branch, right[index]));
    }

    private sameSelected(left: readonly SelectedBranch[], right: readonly SelectedBranch[]): boolean {
        return left.length === right.length
            && left.every((entry, index) => entry.repository.path === right[index].repository.path
                && equalsBranchOption(entry.branch, right[index].branch));
    }

    private dedupeSelected(selected: readonly SelectedBranch[]): SelectedBranch[] {
        const result: SelectedBranch[] = [];
        const keys = new Set<string>();
        for (const entry of selected) {
            const key = `${entry.repository.path}\0${entry.branch.name}`;
            if (keys.has(key)) { continue; }
            keys.add(key);
            result.push(entry);
        }
        return result;
    }

    private async refreshCurrentBranchChangeFlags(): Promise<void> {
        const updates = await Promise.all(this.repositories.map(async repository => {
            const branch = this.getCurrentBranch(repository);
            if (!branch) { return undefined; }
            try {
                const presence = await getWorkingTreeChangePresence(vscode.Uri.parse(repository.path));
                if (branch.hasChangeFiles === presence.changes && branch.hasStagedChangeFiles === presence.staged) {
                    return undefined;
                }
                return { repository, branch: copyBranchOption(branch, {
                    hasChangeFiles: presence.changes,
                    hasStagedChangeFiles: presence.staged,
                }) };
            } catch (error) {
                console.warn('无法读取工作区状态:', error);
                return undefined;
            }
        }));
        let changed = false;
        for (const update of updates) {
            if (!update) { continue; }
            const branches = this.branches.get(update.repository.path);
            if (!branches) { continue; }
            const index = branches.findIndex(branch => branch.kind === 'current');
            if (index < 0) { continue; }
            const next = [...branches];
            next[index] = update.branch;
            this.branches.set(update.repository.path, next);
            this.replaceSelectedCurrentBranch(update.repository.path, update.branch);
            changed = true;
        }
        if (changed) { this.fireBranches(); }
    }

    private replaceSelectedCurrentBranch(repositoryPath: string, branch: GitBranchOption): void {
        this.selected = this.selected.map(entry => entry.repository.path === repositoryPath && entry.branch.kind === 'current'
            ? { ...entry, branch }
            : entry);
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
        for (const entry of this.selected) {
            const branches = snapshot.get(entry.repository);
            if (branches) {
                branches.push(entry.branch);
            } else {
                snapshot.set(entry.repository, [entry.branch]);
            }
        }
        this.selectedEmitter.fire(snapshot);
    }
}
