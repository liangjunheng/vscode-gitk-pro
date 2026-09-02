import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import { GitBranchOption, type GitRepositoryOption } from '../types';

const execFileAsync = promisify(execFile);
import { getGitBranches } from './gitLogProvider';
import { GitRepoController } from './gitRepoController';
import { RepoHeadBranchWatcher } from './eachRepoHeadBranchWatcher';

interface BranchSnapshot {
    repository: GitRepositoryOption;
    branches: GitBranchOption[];
    headChanged: boolean;
}

type RefreshSlot = {
    repository: GitRepositoryOption;
    running: boolean;
    needsRefresh: boolean;
    generation: number;
    completion?: Promise<void>;
};

function repositoryKey(repositoryPath: string): string {
    const normalized = path.normalize(vscode.Uri.parse(repositoryPath).fsPath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 监听选中仓库的完整 refs，并维护每个仓库的总分支快照。 */
export class SelectedRepoTotalBranchWatcher implements vscode.Disposable {
    private readonly repositories = new Map<string, GitRepositoryOption>();
    private readonly totalBranches = new Map<string, GitBranchOption[]>();
    private readonly repoWatchers = new Map<string, vscode.Disposable>();
    private readonly refreshSlots = new Map<string, RefreshSlot>();
    private readonly snapshotEmitter = new vscode.EventEmitter<BranchSnapshot>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly repositorySubscription: vscode.Disposable;
    private readonly headSubscription: vscode.Disposable;
    private loadingCount = 0;

    readonly onRepositoryBranchesChanged = this.snapshotEmitter.event;
    readonly onBranchesLoadingChanged = this.loadingEmitter.event;

    constructor(
        private readonly repoController: GitRepoController,
        private readonly repoHeadBranchWatcher: RepoHeadBranchWatcher,
    ) {
        this.repositorySubscription = repoController.onSelectedRepoListChanged(repositories => {
            void this.syncRepositories(repositories);
        });
        this.headSubscription = repoHeadBranchWatcher.onEachRepoHeadBranchChanged(event => {
            this.applyHeadBranch(event.repositoryPath, event.headBranch);
        });
        void this.syncRepositories(repoController.selectedRepoList);
    }

    get isLoading(): boolean { return this.loadingCount > 0; }

    getTotalBranches(repository: GitRepositoryOption): readonly GitBranchOption[] {
        return this.totalBranches.get(repositoryKey(repository.path)) ?? [];
    }

    getRepositorySnapshots(): readonly BranchSnapshot[] {
        return [...this.repositories].flatMap(([key, repository]) => {
            const branches = this.totalBranches.get(key);
            return branches ? [{ repository, branches: [...branches], headChanged: false }] : [];
        });
    }

    refreshSelectedRepositories(): void {
        for (const repository of this.repositories.values()) {
            void this.enqueueRefresh(repository, true);
        }
    }

    dispose(): void {
        this.repositorySubscription.dispose();
        this.headSubscription.dispose();
        for (const watcher of this.repoWatchers.values()) { watcher.dispose(); }
        this.repoWatchers.clear();
        this.refreshSlots.clear();
        this.repositories.clear();
        this.totalBranches.clear();
        this.snapshotEmitter.dispose();
        this.loadingEmitter.dispose();
    }

    private async syncRepositories(nextRepositories: readonly GitRepositoryOption[]): Promise<void> {
        const nextByKey = new Map(nextRepositories.map(repository => [repositoryKey(repository.path), repository]));
        for (const [key, watcher] of this.repoWatchers) {
            if (nextByKey.has(key)) { continue; }
            watcher.dispose();
            this.repoWatchers.delete(key);
            this.repositories.delete(key);
            this.refreshSlots.delete(key);
            this.totalBranches.delete(key);
        }
        for (const [key, repository] of nextByKey) {
            const previousRepository = this.repositories.get(key);
            this.repositories.set(key, repository);
            const cachedBranches = this.totalBranches.get(key);
            const needsFullRefresh = !cachedBranches;
            if (!cachedBranches) {
                const cachedHead = this.repoHeadBranchWatcher.getCachedHeadBranch(repository);
                if (cachedHead) {
                    const initialBranches = [cachedHead];
                    this.totalBranches.set(key, initialBranches);
                    this.snapshotEmitter.fire({ repository, branches: initialBranches, headChanged: true });
                }
            } else if (!previousRepository || !repository.equals(previousRepository)) {
                const reboundBranches = cachedBranches.map(branch => new GitBranchOption({ ...branch, repoOption: repository }));
                this.totalBranches.set(key, reboundBranches);
                this.snapshotEmitter.fire({ repository, branches: reboundBranches, headChanged: false });
            }
            if (!this.repoWatchers.has(key)) {
                const watcher = await this.createRepositoryWatcher(key, repository);
                if (watcher && this.repositories.get(key)?.path === repository.path) {
                    this.repoWatchers.set(key, watcher);
                } else {
                    watcher?.dispose();
                }
            }
            void this.enqueueRefresh(repository, needsFullRefresh);
        }
    }

    private async createRepositoryWatcher(key: string, repository: GitRepositoryOption): Promise<vscode.Disposable | undefined> {
        try {
            const { stdout } = await execFileAsync('git', [
                '--no-optional-locks', '-C', vscode.Uri.parse(repository.path).fsPath,
                'rev-parse', '--absolute-git-dir',
            ], { windowsHide: true });
            const gitDir = stdout.trim();
            if (!gitDir || this.repositories.get(key)?.path !== repository.path) { return undefined; }
            const gitUri = vscode.Uri.file(gitDir);
            const watchers = [
                vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitUri, 'refs/heads/**')),
                vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitUri, 'refs/remotes/**')),
                vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitUri, 'packed-refs')),
            ];
            const refresh = () => {
                const current = this.repositories.get(key);
                if (current) { void this.enqueueRefresh(current, true); }
            };
            return vscode.Disposable.from(
                ...watchers,
                ...watchers.flatMap(watcher => [watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh)]),
            );
        } catch (error) {
            console.warn(`无法创建仓库分支监听: ${repository.path}`, error);
            return undefined;
        }
    }

    private applyHeadBranch(repositoryPath: string, headBranch: GitBranchOption | undefined): void {
        const key = repositoryKey(repositoryPath);
        const repository = this.repositories.get(key);
        if (!repository) { return; }
        const previous = this.totalBranches.get(key) ?? [];
        const withoutCurrent = previous.filter(branch => branch.kind !== 'current');
        const next = headBranch ? [new GitBranchOption({ ...headBranch, repoOption: repository }), ...withoutCurrent] : withoutCurrent;
        if (previous.length === next.length && previous.every((branch, index) => branch.equals(next[index]))) { return; }
        const previousHead = previous.find(branch => branch.kind === 'current');
        const nextHead = next.find(branch => branch.kind === 'current');
        this.totalBranches.set(key, next);
        this.snapshotEmitter.fire({
            repository,
            branches: [...next],
            headChanged: previousHead?.name !== nextHead?.name || previousHead?.hash !== nextHead?.hash,
        });
    }
    private sameBranches(left: readonly GitBranchOption[], right: readonly GitBranchOption[]): boolean {
        return left.length === right.length
            && left.every((branch, index) => branch.equals(right[index]));
    }
    private enqueueRefresh(repository: GitRepositoryOption, force: boolean): Promise<void> {
        const key = repositoryKey(repository.path);
        const slot = this.refreshSlots.get(key) ?? { repository, running: false, needsRefresh: false, generation: 0 };
        slot.repository = repository;
        slot.generation++;
        if (!force && this.totalBranches.has(key)) { return slot.completion ?? Promise.resolve(); }
        if (slot.running) {
            slot.needsRefresh = true;
            return slot.completion ?? Promise.resolve();
        }
        slot.running = true;
        slot.needsRefresh = false;
        this.refreshSlots.set(key, slot);
        const completion = this.drainRefresh(key, slot);
        slot.completion = completion;
        return completion;
    }

    private async drainRefresh(key: string, slot: RefreshSlot): Promise<void> {
        this.loadingCount++;
        if (this.loadingCount === 1) { this.loadingEmitter.fire(true); }
        try {
            do {
                slot.needsRefresh = false;
                const generation = slot.generation;
                const repository = this.repositories.get(key);
                if (!repository) { return; }
                const head = await this.repoHeadBranchWatcher.getHeadBranchByRepo(repository);
                if (this.repositories.get(key)?.path !== repository.path || generation !== slot.generation) {
                    slot.needsRefresh = true;
                    continue;
                }
                this.applyHeadBranch(repository.path, head);
                const branches = await getGitBranches(vscode.Uri.parse(repository.path));
                if (this.repositories.get(key)?.path !== repository.path || generation !== slot.generation) {
                    slot.needsRefresh = true;
                    continue;
                }
                const normalized = branches.filter(branch => branch.kind !== 'current').map(branch => new GitBranchOption({ ...branch, repoOption: repository }));
                const complete = head ? [head, ...normalized] : normalized;
                const previous = this.totalBranches.get(key);
                if (previous && this.sameBranches(previous, complete)) { continue; }
                const previousHead = previous?.find(branch => branch.kind === 'current');
                const nextHead = complete.find(branch => branch.kind === 'current');
                this.totalBranches.set(key, complete);
                this.snapshotEmitter.fire({
                    repository,
                    branches: [...complete],
                    headChanged: previousHead?.name !== nextHead?.name || previousHead?.hash !== nextHead?.hash,
                });
            } while (slot.needsRefresh);
        } catch (error) {
            console.warn(`无法读取仓库分支: ${slot.repository.path}`, error);
        } finally {
            slot.running = false;
            slot.completion = undefined;
            this.loadingCount--;
            if (this.loadingCount === 0) { this.loadingEmitter.fire(false); }
            if (this.repositories.get(key)?.path !== slot.repository.path) {
                this.refreshSlots.delete(key);
            }
        }
    }
}
