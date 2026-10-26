import * as path from 'path';
import * as vscode from 'vscode';
import { CommitFile, GitBranchOption, WorkingTreeChanges } from '../types';
import type { GitBackend } from './gitBackend';
import { RepoHeadBranchWatcher } from './eachRepoHeadBranchWatcher';
import { invokeNativeGit } from './nativeGitBinding';
import { statusReadLimiter } from './statusConcurrency';


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

function childGitlinkPath(parentRepositoryPath: string, childRepositoryPath: string): string | undefined {
    const parentRoot = vscode.Uri.parse(parentRepositoryPath).fsPath;
    const childRoot = vscode.Uri.parse(childRepositoryPath).fsPath;
    const relativePath = path.relative(parentRoot, childRoot);
    if (!relativePath || relativePath === '..' || path.isAbsolute(relativePath)
        || relativePath.startsWith(`..${path.sep}`)) {
        return undefined;
    }
    return relativePath.split(path.sep).join('/');
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

    readonly onEachHeadBranchUncommittedFileChanged = this.changesEmitter.event;
    readonly onEachHeadBranchUncommittedFileContentChanged = this.contentChangesEmitter.event;

    constructor(
        private readonly repoHeadBranchWatcher: RepoHeadBranchWatcher,
        private readonly gitBackend: GitBackend,
    ) {
        // 每个仓库（含递归已初始化子模块）的 HEAD 一解析完成就先启动完整 status。
        // 这必须早于分支/提交监听器启动历史读取，避免首次 Uncommitted Changes
        // 在原生任务队列中被首屏 commit 读取拖后。
        const onHeadReady = repoHeadBranchWatcher.onEachRepoHeadBranchReady
            ?? repoHeadBranchWatcher.onEachRepoHeadBranchChanged;
        this.branchSubscription = onHeadReady(event => {
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
        const slot = this.slots.get(branch.repoOption.path);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        if (slot.running) {
            await slot.completion;
        } else {
            const cached = this.changesByRepository.get(branch.repoOption.path)?.get(branch.hash);
            if (!cached) { await this.requestRefresh(branch.repoOption.path); }
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
        // 用户操作开始后，操作前启动的状态读取已经可能过期。立即终止它，
        // 避免 endWorkingTreeMutation 先等待旧刷新，再额外执行一次操作后的刷新。
        if (slot.mutationDepth === 1) { slot.refreshAbortController?.abort(); }
    }

    async endWorkingTreeMutation(
        branch: GitBranchOption,
        paths: readonly string[],
        fullRefresh = false,
        waitForRefresh = true,
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
        const refresh = this.requestRefresh(branch.repoOption.path);
        if (waitForRefresh) { await refresh; }
    }


    /**
     * 完成一个已经能给出权威路径补丁的操作。先把补丁写入唯一缓存并发布；
     * 只有无法从操作语义确定的少量路径才同步读取 status。操作自身触发的
     * index/worktree 事件从 pending 集合移除，事务结束后的新事件仍会正常刷新。
     */
    async completeWorkingTreeMutation(
        branch: GitBranchOption,
        changes: WorkingTreeChanges,
        affectedPaths: readonly string[],
        verificationPaths: readonly string[] = [],
    ): Promise<void> {
        const repositoryPath = branch.repoOption.path;
        const slot = this.slots.get(repositoryPath);
        if (!slot || slot.branch?.hash !== branch.hash) {
            throw new Error('该分支不是仓库当前 HEAD');
        }
        if (slot.mutationDepth === 0) {
            throw new Error('工作区操作事务未开始');
        }
        slot.mutationDepth--;
        if (slot.mutationDepth > 0) { return; }

        const affected = new Set(affectedPaths);
        affected.forEach(filePath => {
            slot.pendingPaths?.delete(filePath);
            slot.pendingWorkspaceContentPaths?.delete(filePath);
            slot.indexChangedPaths.delete(filePath);
        });
        slot.indexRefreshPending = false;

        const projected = this.withDirectChildGitlinkStates(repositoryPath, changes);
        const changesByHash = this.changesByRepository.get(repositoryPath) ?? new Map<string, WorkingTreeChanges>();
        const previous = changesByHash.get(branch.hash);
        changesByHash.set(branch.hash, projected);
        this.changesByRepository.set(repositoryPath, changesByHash);
        if (previous?.equals(projected)) {
            if (affectedPaths.length > 0) {
                this.contentChangesEmitter.fire({ branch, changes: copyChanges(projected), affectedPaths });
            }
        } else {
            this.changesEmitter.fire({ branch, changes: copyChanges(projected), affectedPaths });
            void this.publishParentGitlinkProjection(branch);
        }

        if (verificationPaths.length > 0) {
            const pendingPaths = slot.pendingPaths ?? new Set<string>();
            verificationPaths.forEach(filePath => pendingPaths.add(filePath));
            slot.pendingPaths = pendingPaths;
            await this.requestRefresh(repositoryPath);
        } else if (slot.fullRefreshPending
            || (slot.pendingPaths?.size ?? 0) > 0
            || (slot.pendingWorkspaceContentPaths?.size ?? 0) > 0) {
            void this.requestRefresh(repositoryPath);
        }
    }

    dispose(): void {
        this.branchSubscription.dispose();
        this.workspaceWatchers.forEach(watcher => watcher.dispose());
        this.workspaceWatchers.clear();
        this.indexWatchers.forEach(watcher => watcher.dispose());
        this.indexWatchers.clear();
        this.indexWatcherCreations.clear();
        this.slots.forEach(slot => slot.refreshAbortController?.abort());
        this.slots.clear();
        this.changesByRepository.clear();
        this.changesEmitter.dispose();
        this.contentChangesEmitter.dispose();
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
        slot.refreshAbortController?.abort();
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
        // A moved child HEAD changes the parent Gitlink pointer. Refresh only
        // that path; child worktree dirtiness itself is projected from cache.
        if (previous && previous.hash !== branch.hash) {
            this.queueParentGitlinkRefresh(branch);
        }
        void this.requestRefresh(repositoryPath);
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
            const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: rootPath });
            if (!this.slots.get(repositoryPath)?.branch || this.indexWatchers.has(repositoryPath)) { return; }
            const indexWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(gitDir), 'index'),
            );
            const requestRefresh = () => {
                const slot = this.slots.get(repositoryPath);
                if (!slot?.branch) { return; }
                if (slot.mutationDepth > 0) { return; }
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

    private getOwningRepositoryPath(filePath: string): string | undefined {
        let owner: string | undefined;
        let ownerLength = -1;
        for (const [repositoryPath, slot] of this.slots) {
            if (!slot.branch) { continue; }
            const repositoryPathFs = path.normalize(vscode.Uri.parse(repositoryPath).fsPath);
            const relativePath = path.relative(repositoryPathFs, filePath);
            if (relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) { continue; }
            if (repositoryPathFs.length > ownerLength) {
                owner = repositoryPath;
                ownerLength = repositoryPathFs.length;
            }
        }
        return owner;
    }

    private async handleWorkspaceFileChanged(
        repositoryPath: string,
        uri: vscode.Uri,
    ): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch || uri.scheme !== 'file') { return; }
        if (this.getOwningRepositoryPath(uri.fsPath) !== repositoryPath) { return; }
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

    private queueParentGitlinkRefresh(branch: GitBranchOption): void {
        const parent = branch.repoOption.ancestry.at(-1);
        if (!parent) { return; }
        const parentSlot = this.slots.get(parent.path);
        if (!parentSlot?.branch) { return; }
        const gitlinkPath = childGitlinkPath(parent.path, branch.repoOption.path);
        if (!gitlinkPath) { return; }
        const pendingPaths = parentSlot.pendingPaths ?? new Set<string>();
        pendingPaths.add(gitlinkPath);
        parentSlot.pendingPaths = pendingPaths;
        if (parentSlot.mutationDepth === 0) { void this.requestRefresh(parent.path); }
    }

    private requestRefresh(repositoryPath: string): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch) { return Promise.resolve(); }
        if (slot.running) {
            slot.needsRefresh = true;
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
                if (slot.mutationDepth > 0 || !slot.needsRefresh) { return; }
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
                currentIndexChangedPaths = await this.gitBackend.getIndexChangedPaths(rootUri, signal);
            }
            if (previous && reconcileIndex && currentIndexChangedPaths) {
                slot.indexChangedPaths.forEach(filePath => paths.add(filePath));
                currentIndexChangedPaths.forEach(filePath => paths.add(filePath));
            }
            let changes: WorkingTreeChanges;
            if (!previous || fullRefresh) {
                changes = await statusReadLimiter.run(() =>
                    this.gitBackend.getWorkingTreeStatusWithoutSubmoduleWorktrees(rootUri, signal));
            } else if (paths.size > 0) {
                changes = this.mergePathChanges(
                    repositoryPath,
                    branch.hash,
                    await statusReadLimiter.run(() =>
                        this.gitBackend.getWorkingTreeStatusForPaths(rootUri, [...paths], signal)),
                    paths,
                );
            } else {
                changes = previous;
            }
            changes = this.withDirectChildGitlinkStates(repositoryPath, changes);
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
            // 强制全量刷新必须连带重读全部内容: 工作区文件没有 objectId(unstaged 的 newObjectId 恒为全 0),
            //   内容变化不会体现为清单变化, 于是 previousChanges.equals 命中、状态通道无事件可发。
            //   不把整份清单的路径并入内容通道, 手动刷新就只会重跑 git log, staged/unstaged 的正文不会被重读。
            if (fullRefresh) {
                [...changes.staged, ...changes.changes].forEach(file => contentChangedPaths.push(file.path));
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
            void this.publishParentGitlinkProjection(branch);
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

    private withDirectChildGitlinkStates(
        repositoryPath: string,
        source: WorkingTreeChanges,
    ): WorkingTreeChanges {
        const children = [...this.slots.values()].flatMap(slot => {
            const branch = slot.branch;
            return branch?.repoOption.ancestry.at(-1)?.path === repositoryPath ? [branch] : [];
        });
        if (children.length === 0) { return source; }
        const staged = [...source.staged];
        let changes = [...source.changes];
        for (const child of children) {
            const childChanges = this.changesByRepository.get(child.repoOption.path)?.get(child.hash);
            if (!childChanges) { continue; }
            const gitlinkPath = childGitlinkPath(repositoryPath, child.repoOption.path);
            if (!gitlinkPath) { continue; }
            const dirtyCount = new Set([
                ...childChanges.staged.map(file => file.path),
                ...childChanges.changes.map(file => file.path),
            ]).size;
            const existingIndex = changes.findIndex(file => file.path === gitlinkPath && file.isGitlink);
            const existing = existingIndex >= 0 ? changes[existingIndex] : undefined;
            const pointerChanged = Boolean(existing?.oldObjectId && existing.newObjectId
                && existing.oldObjectId !== existing.newObjectId);
            if (!pointerChanged && dirtyCount === 0) {
                if (existing?.gitlinkWorktreeDirty && existing.oldObjectId === existing.newObjectId) {
                    changes.splice(existingIndex, 1);
                } else if (existing?.gitlinkWorktreeDirty) {
                    changes[existingIndex] = new CommitFile({
                        ...existing,
                        gitlinkWorktreeDirty: false,
                        gitlinkWorktreeChangeCount: undefined,
                    });
                }
                continue;
            }
            const replacement = new CommitFile({
                ...existing,
                path: gitlinkPath,
                status: 'M',
                oldObjectId: existing?.oldObjectId ?? child.hash,
                newObjectId: existing?.newObjectId ?? child.hash,
                oldMode: '160000',
                newMode: '160000',
                isGitlink: true,
                gitlinkWorktreeDirty: dirtyCount > 0,
                gitlinkWorktreeChangeCount: dirtyCount > 0 ? dirtyCount : undefined,
            });
            if (existingIndex >= 0) { changes[existingIndex] = replacement; }
            else { changes.push(replacement); }
        }
        changes = changes.sort((left, right) => left.path.localeCompare(right.path));
        return new WorkingTreeChanges({ staged, changes });
    }

    private publishParentGitlinkProjection(branch: GitBranchOption): void {
        const parent = branch.repoOption.ancestry.at(-1);
        if (!parent) { return; }
        const parentSlot = this.slots.get(parent.path);
        const parentBranch = parentSlot?.branch;
        if (!parentSlot || !parentBranch) { return; }
        const current = this.changesByRepository.get(parent.path)?.get(parentBranch.hash);
        if (!current) { return; }
        const projected = this.withDirectChildGitlinkStates(parent.path, current);
        if (parentSlot.branch?.hash !== parentBranch.hash || current.equals(projected)) { return; }
        this.changesByRepository.get(parent.path)?.set(parentBranch.hash, projected);
        this.changesEmitter.fire({ branch: parentBranch, changes: copyChanges(projected) });
        this.publishParentGitlinkProjection(parentBranch);
    }

    private mergePathChanges(
        repositoryPath: string,
        branchHash: string,
        changes: WorkingTreeChanges,
        paths: ReadonlySet<string>,
    ): WorkingTreeChanges {
        const previous = this.changesByRepository.get(repositoryPath)?.get(branchHash) ?? new WorkingTreeChanges();
        const pathIsAffected = (filePath: string): boolean => {
            for (const affectedPath of paths) {
                if (filePath === affectedPath || filePath.startsWith(`${affectedPath.replace(/\/$/, '')}/`)) {
                    return true;
                }
            }
            return false;
        };
        const isAffected = (file: WorkingTreeChanges['staged'][number]) =>
            pathIsAffected(file.path) || (!!file.oldPath && pathIsAffected(file.oldPath));
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
