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

    readonly onEachHeadBranchUncommittedFileChanged = this.changesEmitter.event;
    readonly onEachHeadBranchUncommittedFileContentChanged = this.contentChangesEmitter.event;

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
            const onFileChanged = (uri: vscode.Uri) => {
                void this.handleWorkspaceFileChanged(repositoryPath, uri);
            };
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(rootUri, '**/*'),
            );
            this.workspaceWatchers.set(repositoryPath, vscode.Disposable.from(
                watcher,
                watcher.onDidCreate(onFileChanged),
                watcher.onDidChange(onFileChanged),
                watcher.onDidDelete(onFileChanged),
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

    private async handleWorkspaceFileChanged(repositoryPath: string, uri: vscode.Uri): Promise<void> {
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
        await this.requestRefresh(repositoryPath);
    }

    private requestRefresh(repositoryPath: string): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch) { return Promise.resolve(); }
        if (slot.running) {
            slot.needsRefresh = true;
            console.log(`[Gitk][UncommittedWatcher] refresh merged ${repositoryPath}`, {
                timestamp: new Date().toISOString(),
                pendingPaths: slot.pendingPaths ? [...slot.pendingPaths] : [],
            });
            return slot.completion ?? Promise.resolve();
        }
        slot.running = true;
        console.log(`[Gitk][UncommittedWatcher] refresh started ${repositoryPath}`, {
            timestamp: new Date().toISOString(),
            pendingPaths: slot.pendingPaths ? [...slot.pendingPaths] : [],
        });
        const completion = this.drainRefresh(repositoryPath, slot);
        slot.completion = completion;
        return completion;
    }

    private async drainRefresh(repositoryPath: string, slot: RepositoryRefreshSlot): Promise<void> {
        try {
            while (slot.branch) {
                const branch = slot.branch;
                const generation = slot.generation;
                // 此轮开始前消费已有请求；读取期间到达的新请求将驱动下一轮。
                slot.needsRefresh = false;
                await this.refreshSlot(repositoryPath, branch, generation, slot);
                if (!slot.needsRefresh) { return; }
                console.log(`[Gitk][UncommittedWatcher] refresh retry ${repositoryPath}`, { timestamp: new Date().toISOString() });
            }
        } finally {
            console.log(`[Gitk][UncommittedWatcher] refresh finished ${repositoryPath}`, { timestamp: new Date().toISOString() });
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
    ): Promise<void> {
        try {
            const rootUri = vscode.Uri.parse(repositoryPath);
            const previous = this.changesByRepository.get(repositoryPath)?.get(branch.hash);
            const paths = slot.pendingPaths ?? new Set<string>();
            slot.pendingPaths = undefined;
            const workspaceContentPaths = slot.pendingWorkspaceContentPaths ?? new Set<string>();
            slot.pendingWorkspaceContentPaths = undefined;
            const fullRefresh = slot.fullRefreshPending;
            slot.fullRefreshPending = false;
            const reconcileIndex = slot.indexRefreshPending;
            slot.indexRefreshPending = false;
            let currentIndexChangedPaths: Set<string> | undefined;
            if (reconcileIndex || !previous || fullRefresh) {
                currentIndexChangedPaths = await getIndexChangedPaths(rootUri);
            }
            if (previous && reconcileIndex && currentIndexChangedPaths) {
                slot.indexChangedPaths.forEach(filePath => paths.add(filePath));
                currentIndexChangedPaths.forEach(filePath => paths.add(filePath));
            }
            const changes = !previous || fullRefresh
                ? await getWorkingTreeStatus(rootUri)
                : paths.size > 0
                    ? this.mergePathChanges(
                        repositoryPath,
                        branch.hash,
                        await getWorkingTreeStatusForPaths(rootUri, [...paths]),
                        paths,
                    )
                    : previous;
            if (slot.generation !== generation || slot.branch?.hash !== branch.hash) {
                console.log(`[Gitk][UncommittedWatcher] refresh discarded ${repositoryPath}`, { timestamp: new Date().toISOString() });
                return;
            }
            if (currentIndexChangedPaths) {
                slot.indexChangedPaths = currentIndexChangedPaths;
            }
            const changesByHash = this.changesByRepository.get(repositoryPath) ?? new Map<string, WorkingTreeChanges>();
            const previousChanges = changesByHash.get(branch.hash);
            const affectedPaths = [...paths];
            const contentChangedPaths = [...workspaceContentPaths];
            if (previousChanges?.equals(changes)) {
                if (contentChangedPaths.length > 0) {
                    this.contentChangesEmitter.fire({ branch, changes: copyChanges(changes), affectedPaths: contentChangedPaths });
                } else {
                    console.log(`[Gitk][UncommittedWatcher] status unchanged ${repositoryPath}`, {
                        timestamp: new Date().toISOString(),
                        paths: affectedPaths,
                    });
                }
                return;
            }
            changesByHash.set(branch.hash, changes);
            this.changesByRepository.set(repositoryPath, changesByHash);
            console.log(`[Gitk][UncommittedWatcher] status changed ${repositoryPath}`, {
                timestamp: new Date().toISOString(),
                paths: affectedPaths,
                stagedCount: changes.staged.length,
                unstagedCount: changes.changes.length,
            });
            this.changesEmitter.fire({ branch, changes: copyChanges(changes), affectedPaths });
        } catch (error) {
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
        const mergeSection = (allFiles: WorkingTreeChanges['staged'], changedFiles: WorkingTreeChanges['staged']) => [
            ...allFiles.filter(file => !isAffected(file)),
            ...changedFiles,
        ];
        return new WorkingTreeChanges({
            staged: mergeSection(previous.staged, changes.staged),
            changes: mergeSection(previous.changes, changes.changes),
        });
    }
}
