import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitBranchOption, WorkingTreeChanges } from '../types';
import { getIndexChangedPaths, getWorkingTreeStatus, getWorkingTreeStatusForPaths, hasWorkingTreeChanges } from './gitLogProvider';
import { RepoHeadBranchWatcher } from './eachRepoHeadBranchWatcher';

const execFileAsync = promisify(execFile);

type HeadBranchUncommittedFilesChangedEvent = {
    branch: GitBranchOption;
    changes: WorkingTreeChanges;
    affectedPaths?: readonly string[];
};

type HeadBranchUncommittedFileContentChangedEvent = {
    branch: GitBranchOption;
    changes: WorkingTreeChanges;
    affectedPaths: readonly string[];
};

type HeadBranchUncommittedPresenceChangedEvent = {
    repositoryPath: string;
    branch: GitBranchOption;
    hasChanges: boolean;
};

type RepositoryRefreshSlot = {
    branch?: GitBranchOption;
    generation: number;
    running: boolean;
    needsRefresh: boolean;
    pendingPaths?: Set<string>;
    pendingWorkspaceContentPaths?: Set<string>;
    fullRefreshPending: boolean;
    indexRefreshPending: boolean;
    mutationDepth: number;
    indexChangedPaths: Set<string>;
    refreshAbortController?: AbortController;
    completion?: Promise<void>;
};

function copyChanges(changes: WorkingTreeChanges): WorkingTreeChanges {
    return new WorkingTreeChanges({
        staged: [...changes.staged],
        changes: [...changes.changes],
    });
}

/** 全部仓库当前 HEAD 工作区未提交文件的唯一读取者与目录监听者。 */
export class UncommittedFilesWatcher implements vscode.Disposable {
    private readonly workspaceWatchers = new Map<string, vscode.Disposable>();
    private readonly indexWatchers = new Map<string, vscode.Disposable>();
    private readonly indexWatcherCreations = new Map<string, Promise<void>>();
    private readonly slots = new Map<string, RepositoryRefreshSlot>();
    private readonly changesByRepository = new Map<string, Map<string, WorkingTreeChanges>>();
    private readonly branchSubscription: vscode.Disposable;
    private readonly changesEmitter = new vscode.EventEmitter<HeadBranchUncommittedFilesChangedEvent>();
    private readonly contentChangesEmitter = new vscode.EventEmitter<HeadBranchUncommittedFileContentChangedEvent>();
    private readonly indexChangedEmitter = new vscode.EventEmitter<{ repositoryPath: string }>();
    private readonly presenceEmitter = new vscode.EventEmitter<HeadBranchUncommittedPresenceChangedEvent>();

    readonly onEachHeadBranchUncommittedFileChanged = this.changesEmitter.event;
    readonly onEachHeadBranchUncommittedFileContentChanged = this.contentChangesEmitter.event;
    readonly onRepositoryIndexChanged = this.indexChangedEmitter.event;
    /** 轻量存在性事件：不等完整清单，只为每个仓库尽快给出“是否有未提交文件”。 */
    readonly onRepositoryUncommittedPresenceChanged = this.presenceEmitter.event;

    constructor(private readonly repoHeadBranchWatcher: RepoHeadBranchWatcher) {
        // 数据源改为全部仓库 HEAD 监听器, 不再跟随仓库选择, 天然覆盖所有仓库。
        this.branchSubscription = repoHeadBranchWatcher.onEachRepoHeadBranchChanged(event => {
            this.applyCurrentHeadBranch(event.repositoryPath, event.headBranch);
        });
    }

    /**
     * 强制重读 HEAD 后等待该 HEAD 的完整工作区状态就绪。
     * 普通 commit 不改 .git/HEAD, 必须由调用方显式触发；不能只等待 HEAD 事件投递,
     * 否则提交列表刷新完成时 CommitPanel 仍可能从旧 hash 缓存读取 staged/unstaged。
     */
    async refreshHeadBranch(repositoryPath: string): Promise<void> {
        await this.repoHeadBranchWatcher.refreshHeadBranch(repositoryPath);
        const branch = this.slots.get(repositoryPath)?.branch;
        if (branch) { await this.getUncommittedFilesByHeadBranch(branch); }
    }

    /** 列出所有已知仓库的当前 HEAD 分支 (覆盖全部仓库, 不受仓库选择限制)。 */
    listCurrentHeadBranches(): GitBranchOption[] {
        const branches: GitBranchOption[] = [];
        for (const slot of this.slots.values()) {
            if (slot.branch) { branches.push(slot.branch); }
        }
        return branches;
    }

    getCachedUncommittedFilesByHeadBranch(branch: GitBranchOption): WorkingTreeChanges | undefined {
        if (branch.kind !== 'current') {
            throw new Error('只能查询当前 HEAD 分支的未提交文件');
        }
        const cached = this.changesByRepository.get(branch.repoOption.path)?.get(branch.hash);
        return cached ? copyChanges(cached) : undefined;
    }

    async getUncommittedFilesByHeadBranch(branch: GitBranchOption): Promise<WorkingTreeChanges> {
        if (branch.kind !== 'current') {
            throw new Error('只能查询当前 HEAD 分支的未提交文件');
        }
        const cached = this.changesByRepository.get(branch.repoOption.path)?.get(branch.hash);
        if (cached) { return copyChanges(cached); }
        const slot = this.slots.get(branch.repoOption.path);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        if (slot.running) {
            await slot.completion;
        } else {
            await this.requestRefresh(branch.repoOption.path);
        }
        return copyChanges(
            this.changesByRepository.get(branch.repoOption.path)?.get(branch.hash)
            ?? new WorkingTreeChanges(),
        );
    }

    async refreshUncommittedFilesByHeadBranch(branch: GitBranchOption): Promise<void> {
        if (branch.kind !== 'current') {
            throw new Error('只能刷新当前 HEAD 分支的未提交文件');
        }
        const slot = this.slots.get(branch.repoOption.path);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        slot.fullRefreshPending = true;
        await this.requestRefresh(branch.repoOption.path);
    }

    async refreshUncommittedFilesForPaths(branch: GitBranchOption, paths: readonly string[]): Promise<void> {
        if (branch.kind !== 'current') {
            throw new Error('只能刷新当前 HEAD 分支的未提交文件');
        }
        const slot = this.slots.get(branch.repoOption.path);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        const pendingPaths = slot.pendingPaths ?? new Set<string>();
        paths.forEach(filePath => pendingPaths.add(filePath));
        slot.pendingPaths = pendingPaths;
        await this.requestRefresh(branch.repoOption.path);
    }

    beginWorkingTreeMutation(branch: GitBranchOption): void {
        const slot = this.slots.get(branch.repoOption.path);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        slot.mutationDepth++;
    }

    async endWorkingTreeMutation(
        branch: GitBranchOption,
        paths: readonly string[],
        fullRefresh = false,
    ): Promise<void> {
        const slot = this.slots.get(branch.repoOption.path);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        if (slot.mutationDepth === 0) {
            throw new Error('工作区操作事务未开始');
        }
        slot.mutationDepth--;
        if (slot.mutationDepth > 0) { return; }
        slot.fullRefreshPending ||= fullRefresh;
        const pendingPaths = slot.pendingPaths ?? new Set<string>();
        paths.forEach(filePath => pendingPaths.add(filePath));
        slot.pendingPaths = pendingPaths;
        await this.requestRefresh(branch.repoOption.path);
    }

    dispose(): void {
        this.branchSubscription.dispose();
        this.workspaceWatchers.forEach(watcher => watcher.dispose());
        this.workspaceWatchers.clear();
        this.indexWatchers.forEach(watcher => watcher.dispose());
        this.indexWatchers.clear();
        this.indexWatcherCreations.clear();
        this.slots.clear();
        this.changesByRepository.clear();
        this.changesEmitter.dispose();
        this.contentChangesEmitter.dispose();
        this.indexChangedEmitter.dispose();
        this.presenceEmitter.dispose();
    }

    private applyCurrentHeadBranch(repositoryPath: string, branch: GitBranchOption | undefined): void {
        const slot = this.slots.get(repositoryPath) ?? {
            generation: 0,
            running: false,
            needsRefresh: false,
            fullRefreshPending: false,
            indexRefreshPending: false,
            mutationDepth: 0,
            indexChangedPaths: new Set<string>(),
        };
        const previous = slot.branch;
        if (previous?.name === branch?.name && previous?.hash === branch?.hash) { return; }
        slot.branch = branch;
        slot.generation++;
        slot.pendingPaths = undefined;
        slot.pendingWorkspaceContentPaths = undefined;
        slot.fullRefreshPending = false;
        slot.indexRefreshPending = false;
        slot.mutationDepth = 0;
        slot.indexChangedPaths = new Set<string>();
        this.slots.set(repositoryPath, slot);
        if (!branch) {
            this.disposeRepositoryWatchers(repositoryPath);
            return;
        }
        this.ensureRepositoryWatchers(branch);
        // 存在性探测与完整清单读取并行：徽标不必等 --untracked-files=all 递归展开。
        void this.probePresence(repositoryPath, branch);
        void this.requestRefresh(repositoryPath);
    }

    /** 以轻量命令尽快给出“是否有未提交文件”，结果只用于徽标，不写入清单缓存。 */
    private async probePresence(repositoryPath: string, branch: GitBranchOption): Promise<void> {
        try {
            const hasChanges = await hasWorkingTreeChanges(vscode.Uri.parse(repositoryPath));
            const slot = this.slots.get(repositoryPath);
            if (!slot || slot.branch?.hash !== branch.hash) { return; }
            this.presenceEmitter.fire({ repositoryPath, branch, hasChanges });
        } catch (error) {
            console.warn(`无法探测未提交文件存在性: ${repositoryPath}`, error);
        }
    }

    private ensureRepositoryWatchers(branch: GitBranchOption): void {
        const repositoryPath = branch.repoOption.path;
        if (!this.workspaceWatchers.has(repositoryPath)) {
            const rootUri = vscode.Uri.parse(repositoryPath);
            const onFileCreated = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri);
            };
            const onFileChanged = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri);
            };
            const onFileDeleted = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri);
            };
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(rootUri, '**/*'),
            );
            this.workspaceWatchers.set(repositoryPath, vscode.Disposable.from(
                watcher,
                watcher.onDidCreate(onFileCreated),
                watcher.onDidChange(onFileChanged),
                watcher.onDidDelete(onFileDeleted),
            ));
        }
        if (!this.indexWatchers.has(repositoryPath) && !this.indexWatcherCreations.has(repositoryPath)) {
            const creation = this.createIndexWatcher(repositoryPath).finally(() => {
                if (this.indexWatcherCreations.get(repositoryPath) === creation) {
                    this.indexWatcherCreations.delete(repositoryPath);
                }
            });
            this.indexWatcherCreations.set(repositoryPath, creation);
        }
    }

    private async createIndexWatcher(repositoryPath: string): Promise<void> {
        const rootPath = vscode.Uri.parse(repositoryPath).fsPath;
        try {
            const { stdout } = await execFileAsync('git', [
                '--no-optional-locks', '-C', rootPath, 'rev-parse', '--absolute-git-dir',
            ], { windowsHide: true });
            if (!this.slots.get(repositoryPath)?.branch || this.indexWatchers.has(repositoryPath)) { return; }
            const indexWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(stdout.trim()), 'index'),
            );
            const requestRefresh = () => {
                const slot = this.slots.get(repositoryPath);
                if (!slot?.branch) { return; }
                if (slot.mutationDepth > 0) { return; }
                slot.indexRefreshPending = true;
                this.indexChangedEmitter.fire({ repositoryPath });
                void this.requestRefresh(repositoryPath);
            };
            this.indexWatchers.set(repositoryPath, vscode.Disposable.from(
                indexWatcher,
                indexWatcher.onDidCreate(requestRefresh),
                indexWatcher.onDidChange(requestRefresh),
                indexWatcher.onDidDelete(requestRefresh),
            ));
        } catch (error) {
            console.warn(`无法创建 Git index 监听: ${repositoryPath}`, error);
        }
    }

    private disposeRepositoryWatchers(repositoryPath: string): void {
        this.workspaceWatchers.get(repositoryPath)?.dispose();
        this.workspaceWatchers.delete(repositoryPath);
        this.indexWatchers.get(repositoryPath)?.dispose();
        this.indexWatchers.delete(repositoryPath);
        this.indexWatcherCreations.delete(repositoryPath);
    }

    private async handleWorkspaceFileChanged(
        repositoryPath: string,
        uri: vscode.Uri,
    ): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch || uri.scheme !== 'file') { return; }
        const rootPath = vscode.Uri.parse(repositoryPath).fsPath;
        const relativePath = path.relative(rootPath, uri.fsPath);
        if (!relativePath || relativePath === '.git' || relativePath.startsWith(`.git${path.sep}`)) { return; }
        const normalizedPath = relativePath.split(path.sep).join('/');
        const pendingPaths = slot.pendingPaths ?? new Set<string>();
        pendingPaths.add(normalizedPath);
        slot.pendingPaths = pendingPaths;
        const pendingWorkspaceContentPaths = slot.pendingWorkspaceContentPaths ?? new Set<string>();
        pendingWorkspaceContentPaths.add(normalizedPath);
        slot.pendingWorkspaceContentPaths = pendingWorkspaceContentPaths;
        if (slot.mutationDepth > 0) { return; }
        await this.requestRefresh(repositoryPath);
    }

    private requestRefresh(repositoryPath: string): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch) { return Promise.resolve(); }
        if (slot.running) {
            slot.needsRefresh = true;
            slot.refreshAbortController?.abort();
            return slot.completion ?? Promise.resolve();
        }
        slot.running = true;
        const completion = this.drainRefresh(repositoryPath, slot);
        slot.completion = completion;
        return completion;
    }

    private async drainRefresh(repositoryPath: string, slot: RepositoryRefreshSlot): Promise<void> {
        try {
            while (slot.branch) {
                const branch = slot.branch;
                const generation = slot.generation;
                slot.needsRefresh = false;
                const refreshAbortController = new AbortController();
                slot.refreshAbortController = refreshAbortController;
                try {
                    await this.refreshSlot(repositoryPath, branch, generation, slot, refreshAbortController.signal);
                } catch (error: any) {
                    if (error?.name !== 'AbortError' && error?.code !== 'ABORT_ERR') { throw error; }
                } finally {
                    if (slot.refreshAbortController === refreshAbortController) {
                        slot.refreshAbortController = undefined;
                    }
                }
                if (!slot.needsRefresh) { return; }
            }
        } finally {
            slot.refreshAbortController?.abort();
            slot.refreshAbortController = undefined;
            slot.needsRefresh = false;
            slot.running = false;
            slot.completion = undefined;
        }
    }

    private async refreshSlot(
        repositoryPath: string,
        branch: GitBranchOption,
        generation: number,
        slot: RepositoryRefreshSlot,
        signal: AbortSignal,
    ): Promise<void> {
        const paths = new Set<string>();
        const workspaceContentPaths = new Set<string>();
        let fullRefresh = false;
        let reconcileIndex = false;
        try {
            const rootUri = vscode.Uri.parse(repositoryPath);
            const previous = this.changesByRepository.get(repositoryPath)?.get(branch.hash);
            slot.pendingPaths?.forEach(filePath => paths.add(filePath));
            slot.pendingPaths = undefined;
            slot.pendingWorkspaceContentPaths?.forEach(filePath => workspaceContentPaths.add(filePath));
            slot.pendingWorkspaceContentPaths = undefined;
            fullRefresh = slot.fullRefreshPending;
            slot.fullRefreshPending = false;
            reconcileIndex = slot.indexRefreshPending;
            slot.indexRefreshPending = false;
            let currentIndexChangedPaths: Set<string> | undefined;
            if (previous && (reconcileIndex || fullRefresh)) {
                currentIndexChangedPaths = await getIndexChangedPaths(rootUri, signal);
            }
            if (previous && reconcileIndex && currentIndexChangedPaths) {
                slot.indexChangedPaths.forEach(filePath => paths.add(filePath));
                currentIndexChangedPaths.forEach(filePath => paths.add(filePath));
            }
            const changes = !previous || fullRefresh
                ? await getWorkingTreeStatus(rootUri, signal)
                : paths.size > 0
                    ? this.mergePathChanges(
                        repositoryPath,
                        branch.hash,
                        await getWorkingTreeStatusForPaths(rootUri, [...paths], signal),
                        paths,
                    )
                    : previous;
            if (slot.generation !== generation || slot.branch?.hash !== branch.hash) {
                return;
            }
            if (currentIndexChangedPaths) {
                slot.indexChangedPaths = currentIndexChangedPaths;
            }
            const changesByHash = this.changesByRepository.get(repositoryPath) ?? new Map<string, WorkingTreeChanges>();
            const previousChanges = changesByHash.get(branch.hash);
            const affectedPaths = [...paths];
            // 内容变更路径 = 工作区内容变化(unstaged/untracked) + index 内容变化(staged)。
            // git add/reset 时清单可能不变(文件本就在 staged 列表), 但其 index 内容已变,
            //   必须把 index 变化路径纳入内容事件, 否则下方 previousChanges.equals 分支会漏发, staged 卡片不刷新。
            const contentChangedPaths = [...workspaceContentPaths];
            if (reconcileIndex) {
                slot.indexChangedPaths.forEach(filePath => contentChangedPaths.push(filePath));
                currentIndexChangedPaths?.forEach(filePath => contentChangedPaths.push(filePath));
            }
            if (previousChanges?.equals(changes)) {
                if (contentChangedPaths.length > 0) {
                    this.contentChangesEmitter.fire({ branch, changes: copyChanges(changes), affectedPaths: contentChangedPaths });
                }
                return;
            }
            changesByHash.set(branch.hash, changes);
            this.changesByRepository.set(repositoryPath, changesByHash);
            // 完整清单就绪后用精确值校正存在性，保证徽标最终与清单一致。
            this.presenceEmitter.fire({
                repositoryPath,
                branch,
                hasChanges: changes.staged.length > 0 || changes.changes.length > 0,
            });
            this.changesEmitter.fire({ branch, changes: copyChanges(changes), affectedPaths });
        } catch (error: any) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
                if (slot.generation === generation && slot.branch?.hash === branch.hash) {
                    const pendingPaths = slot.pendingPaths ?? new Set<string>();
                    paths.forEach(filePath => pendingPaths.add(filePath));
                    slot.pendingPaths = pendingPaths;
                    const pendingWorkspaceContentPaths = slot.pendingWorkspaceContentPaths ?? new Set<string>();
                    workspaceContentPaths.forEach(filePath => pendingWorkspaceContentPaths.add(filePath));
                    slot.pendingWorkspaceContentPaths = pendingWorkspaceContentPaths;
                    slot.fullRefreshPending ||= fullRefresh;
                    slot.indexRefreshPending ||= reconcileIndex;
                }
                slot.needsRefresh = true;
                throw error;
            }
            console.warn(`无法读取未提交文件: ${repositoryPath}`, error);
        }
    }

    private mergePathChanges(
        repositoryPath: string,
        branchHash: string,
        changes: WorkingTreeChanges,
        paths: ReadonlySet<string>,
    ): WorkingTreeChanges {
        const previous = this.changesByRepository.get(repositoryPath)?.get(branchHash) ?? new WorkingTreeChanges();
        const isAffected = (file: WorkingTreeChanges['staged'][number]) =>
            paths.has(file.path) || (!!file.oldPath && paths.has(file.oldPath));
        // 就地替换受影响项, 保持原有顺序。追加末尾会打乱列表, 让按下标比较的 WorkingTreeChanges.equals
        // 误判为状态变化, 使纯内容编辑被错误分流到状态通道而漏读内容。
        const mergeSection = (allFiles: WorkingTreeChanges['staged'], changedFiles: WorkingTreeChanges['staged']) => {
            const changedByPath = new Map(changedFiles.map(file => [file.path, file]));
            const merged = allFiles.flatMap(file => {
                if (!isAffected(file)) { return [file]; }
                const replacement = changedByPath.get(file.path);
                // 命中即消费, 避免同路径重复; 未命中表示该受影响项已消失, 从列表移除。
                if (replacement) { changedByPath.delete(file.path); }
                return replacement ? [replacement] : [];
            });
            // 本轮新出现的受影响文件追加到末尾。
            for (const file of changedFiles) {
                if (changedByPath.has(file.path)) { merged.push(file); }
            }
            return merged;
        };
        return new WorkingTreeChanges({
            staged: mergeSection(previous.staged, changes.staged),
            changes: mergeSection(previous.changes, changes.changes),
        });
    }
}
