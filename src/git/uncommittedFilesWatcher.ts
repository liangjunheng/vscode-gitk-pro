import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitBranchOption, WorkingTreeChanges } from '../types';
import { getWorkingTreeStatus, getWorkingTreeStatusForPaths } from './gitLogProvider';
import { GitBranchesController } from './gitBranchesController';

const execFileAsync = promisify(execFile);

type HeadBranchUncommittedFilesChangedEvent = {
    branch: GitBranchOption;
    changes: WorkingTreeChanges;
};

type RepositoryRefreshSlot = {
    branch?: GitBranchOption;
    generation: number;
    running: boolean;
    needsRefresh: boolean;
    completion?: Promise<void>;
};

function copyChanges(changes: WorkingTreeChanges): WorkingTreeChanges {
    return new WorkingTreeChanges({
        staged: [...changes.staged],
        changes: [...changes.changes],
    });
}

/** 当前 HEAD 工作区未提交文件的唯一读取者与目录监听者。 */
export class UncommittedFilesWatcher implements vscode.Disposable {
    private readonly workspaceWatchers = new Map<string, vscode.Disposable>();
    private readonly indexWatchers = new Map<string, vscode.Disposable>();
    private readonly indexWatcherCreations = new Map<string, Promise<void>>();
    private readonly slots = new Map<string, RepositoryRefreshSlot>();
    private readonly changesByRepository = new Map<string, Map<string, WorkingTreeChanges>>();
    private readonly branchesByRepository = new Map<string, Map<string, GitBranchOption>>();
    private readonly branchSubscription: vscode.Disposable;
    private readonly changesEmitter = new vscode.EventEmitter<HeadBranchUncommittedFilesChangedEvent>();

    readonly onEachHeadBranchUncommittedFileChanged = this.changesEmitter.event;

    constructor(branchesController: GitBranchesController) {
        this.branchSubscription = branchesController.onEachRepoCurrentHeadBranchChanged(event => {
            this.applyCurrentHeadBranch(event.repositoryPath, event.branch);
        });
        for (const branch of branchesController.getBranches('current')) {
            this.applyCurrentHeadBranch(branch.repoOption.path, branch);
        }
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
        await this.requestRefresh(branch.repoOption.path);
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
        const changes = await getWorkingTreeStatusForPaths(vscode.Uri.parse(branch.repoOption.path), paths);
        if (slot.branch?.hash !== branch.hash) { return; }
        const cached = this.changesByRepository.get(branch.repoOption.path) ?? new Map<string, WorkingTreeChanges>();
        const previous = cached.get(branch.hash) ?? new WorkingTreeChanges();
        const pathSet = new Set(paths);
        const isStale = (file: WorkingTreeChanges['staged'][number]) =>
            pathSet.has(file.path) || (!!file.oldPath && pathSet.has(file.oldPath));
        const mergeSection = (allFiles: WorkingTreeChanges['staged'], changedFiles: WorkingTreeChanges['staged']) => [
            ...allFiles.filter(file => !isStale(file)),
            ...changedFiles,
        ];
        const merged = new WorkingTreeChanges({
            staged: mergeSection(previous.staged, changes.staged),
            changes: mergeSection(previous.changes, changes.changes),
        });
        if (previous.equals(merged)) { return; }
        cached.set(branch.hash, merged);
        this.changesByRepository.set(branch.repoOption.path, cached);
        const branches = this.branchesByRepository.get(branch.repoOption.path) ?? new Map<string, GitBranchOption>();
        branches.set(branch.hash, branch);
        this.branchesByRepository.set(branch.repoOption.path, branches);
        this.changesEmitter.fire({ branch, changes: copyChanges(merged) });
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
        this.branchesByRepository.clear();
        this.changesEmitter.dispose();
    }

    private applyCurrentHeadBranch(repositoryPath: string, branch: GitBranchOption | undefined): void {
        const slot = this.slots.get(repositoryPath) ?? {
            generation: 0,
            running: false,
            needsRefresh: false,
        };
        const previous = slot.branch;
        if (previous?.name === branch?.name && previous?.hash === branch?.hash) { return; }
        slot.branch = branch;
        slot.generation++;
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
            const requestRefresh = () => { void this.requestRefresh(repositoryPath); };
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
        await this.requestRefresh(repositoryPath);
    }

    private requestRefresh(repositoryPath: string): Promise<void> {
        const slot = this.slots.get(repositoryPath);
        if (!slot?.branch) { return Promise.resolve(); }
        if (slot.running) {
            if (!slot.needsRefresh) { slot.needsRefresh = true; }
            return slot.completion ?? Promise.resolve();
        }
        slot.running = true;
        const completion = this.drainRefresh(repositoryPath, slot);
        slot.completion = completion;
        return completion;
    }

    private async drainRefresh(repositoryPath: string, slot: RepositoryRefreshSlot): Promise<void> {
        try {
            do {
                slot.needsRefresh = false;
                const branch = slot.branch;
                const generation = slot.generation;
                if (!branch) { return; }
                await this.refreshBranch(repositoryPath, branch, generation, slot);
            } while (slot.needsRefresh && slot.branch);
        } finally {
            slot.running = false;
            slot.completion = undefined;
        }
    }

    private async refreshBranch(
        repositoryPath: string,
        branch: GitBranchOption,
        generation: number,
        slot: RepositoryRefreshSlot,
    ): Promise<void> {
        try {
            const changes = await getWorkingTreeStatus(vscode.Uri.parse(repositoryPath));
            if (slot.generation !== generation || slot.branch?.hash !== branch.hash) { return; }
            const changesByHash = this.changesByRepository.get(repositoryPath) ?? new Map<string, WorkingTreeChanges>();
            const previous = changesByHash.get(branch.hash);
            if (previous?.equals(changes)) { return; }
            changesByHash.set(branch.hash, changes);
            this.changesByRepository.set(repositoryPath, changesByHash);
            const branchesByHash = this.branchesByRepository.get(repositoryPath) ?? new Map<string, GitBranchOption>();
            branchesByHash.set(branch.hash, branch);
            this.branchesByRepository.set(repositoryPath, branchesByHash);
            this.changesEmitter.fire({ branch, changes: copyChanges(changes) });
        } catch (error) {
            console.warn(`无法读取未提交文件: ${repositoryPath}`, error);
        }
    }
}
