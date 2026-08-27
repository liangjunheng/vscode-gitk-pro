import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitBranchOption, WorkingTreeChanges } from '../types';
import { getIndexChangedPaths, getWorkingTreeStatus, getWorkingTreeStatusForPaths } from './gitLogProvider';
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

type VisibleDiffFileContentChangedEvent = {
    branch: GitBranchOption;
    affectedPaths: readonly string[];
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
    private readonly visibleDiffPathsByRepository = new Map<string, Set<string>>();
    private readonly branchSubscription: vscode.Disposable;
    private readonly changesEmitter = new vscode.EventEmitter<HeadBranchUncommittedFilesChangedEvent>();
    private readonly contentChangesEmitter = new vscode.EventEmitter<HeadBranchUncommittedFileContentChangedEvent>();
    private readonly visibleDiffContentEmitter = new vscode.EventEmitter<VisibleDiffFileContentChangedEvent>();

    readonly onEachHeadBranchUncommittedFileChanged = this.changesEmitter.event;
    readonly onEachHeadBranchUncommittedFileContentChanged = this.contentChangesEmitter.event;
    readonly onVisibleDiffFileContentChanged = this.visibleDiffContentEmitter.event;

    constructor(repoHeadBranchWatcher: RepoHeadBranchWatcher) {
        // 数据源改为全部仓库 HEAD 监听器, 不再跟随仓库选择, 天然覆盖所有仓库。
        this.branchSubscription = repoHeadBranchWatcher.onEachRepoHeadBranchChanged(event => {
            this.applyCurrentHeadBranch(event.repositoryPath, event.headBranch);
        });
    }

    /** 列出所有已知仓库的当前 HEAD 分支 (覆盖全部仓库, 不受仓库选择限制)。 */
    listCurrentHeadBranches(): GitBranchOption[] {
        const branches: GitBranchOption[] = [];
        for (const slot of this.slots.values()) {
            if (slot.branch) { branches.push(slot.branch); }
        }
        return branches;
    }

    setVisibleDiffPaths(repositoryPath: string | undefined, paths: readonly string[]): void {
        this.visibleDiffPathsByRepository.clear();
        if (repositoryPath && paths.length > 0) {
            this.visibleDiffPathsByRepository.set(repositoryPath, new Set(paths));
        }
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

    dispose(): void {
        this.branchSubscription.dispose();
        this.workspaceWatchers.forEach(watcher => watcher.dispose());
        this.workspaceWatchers.clear();
        this.indexWatchers.forEach(watcher => watcher.dispose());
        this.indexWatchers.clear();
        this.indexWatcherCreations.clear();
        this.slots.clear();
        this.changesByRepository.clear();
        this.visibleDiffPathsByRepository.clear();
        this.changesEmitter.dispose();
        this.contentChangesEmitter.dispose();
        this.visibleDiffContentEmitter.dispose();
    }

    private applyCurrentHeadBranch(repositoryPath: string, branch: GitBranchOption | undefined): void {
        const slot = this.slots.get(repositoryPath) ?? {
            generation: 0,
            running: false,
            needsRefresh: false,
            fullRefreshPending: false,
            indexRefreshPending: false,
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
        slot.indexChangedPaths = new Set<string>();
        this.slots.set(repositoryPath, slot);
        if (!branch) {
            this.disposeRepositoryWatchers(repositoryPath);
            return;
        }
        this.ensureRepositoryWatchers(branch);
        void this.requestRefresh(repositoryPath);
    }

    private ensureRepositoryWatchers(branch: GitBranchOption): void {
        const repositoryPath = branch.repoOption.path;
        if (!this.workspaceWatchers.has(repositoryPath)) {
            const rootUri = vscode.Uri.parse(repositoryPath);
            const onFileCreated = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri, 'create');
            };
            const onFileChanged = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri, 'change');
            };
            const onFileDeleted = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri, 'delete');
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
                slot.indexRefreshPending = true;
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
        eventType: 'create' | 'change' | 'delete',
    ): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch || uri.scheme !== 'file') { return; }
        const rootPath = vscode.Uri.parse(repositoryPath).fsPath;
        const relativePath = path.relative(rootPath, uri.fsPath);
        if (!relativePath || relativePath === '.git' || relativePath.startsWith(`.git${path.sep}`)) { return; }
        const normalizedPath = relativePath.split(path.sep).join('/');
        // 命中 Webview 上报的可视卡片白名单时, 走即时内容通道 (onVisibleDiffFileContentChanged),
        //   让 Host 只重读该文件的 Diff, 绕开全量 status 队列, 实现所见卡片的低延迟刷新。
        // 注意: staged 卡片虽然也会命中白名单并触发本通道, 但其 Diff 内容源自 index, 工作区内容变化不会改变它,
        //   所以 staged 卡片重读后"内容不变"是符合语义的; 不要据此误判为链路断裂。
        // 严格契约: 快通道只服务可视文件的"内容变化(change)"。create/delete 是结构变化(卡片出现/消失),
        //   只能由状态通道经 git status 重建文件清单来正确增删卡片。
        //   若让 delete 也 fire 快通道, 会与状态通道形成两条独立代次、互不作废的异步写 store.files 链,
        //   在文件系统未稳定期交替落地, 导致 Diff 卡片"消失→出现→消失"闪烁 (回归警示)。
        const isVisibleDiff = this.visibleDiffPathsByRepository.get(repositoryPath)?.has(normalizedPath) ?? false;
        if (isVisibleDiff && eventType === 'change') {
            this.visibleDiffContentEmitter.fire({
                branch: slot.branch,
                affectedPaths: [normalizedPath],
            });
            // 内容通道已完成职责, 不再进入状态队列。
            return;
        }
        const pendingPaths = slot.pendingPaths ?? new Set<string>();
        pendingPaths.add(normalizedPath);
        slot.pendingPaths = pendingPaths;
        if (!isVisibleDiff) {
            const pendingWorkspaceContentPaths = slot.pendingWorkspaceContentPaths ?? new Set<string>();
            pendingWorkspaceContentPaths.add(normalizedPath);
            slot.pendingWorkspaceContentPaths = pendingWorkspaceContentPaths;
        }
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
            if (reconcileIndex || !previous || fullRefresh) {
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
            this.changesEmitter.fire({ branch, changes: copyChanges(changes), affectedPaths });
        } catch (error: any) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
                const pendingPaths = slot.pendingPaths ?? new Set<string>();
                paths.forEach(filePath => pendingPaths.add(filePath));
                slot.pendingPaths = pendingPaths;
                const pendingWorkspaceContentPaths = slot.pendingWorkspaceContentPaths ?? new Set<string>();
                workspaceContentPaths.forEach(filePath => pendingWorkspaceContentPaths.add(filePath));
                slot.pendingWorkspaceContentPaths = pendingWorkspaceContentPaths;
                slot.fullRefreshPending ||= fullRefresh;
                slot.indexRefreshPending ||= reconcileIndex;
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
