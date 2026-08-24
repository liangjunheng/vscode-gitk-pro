import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitBranchOption, type GitRepositoryOption } from '../types';
import {
    buildDetachedHeadBranch,
    getCurrentGitBranch,
    getCurrentGitHeadHash,
} from './gitLogProvider';
import { GitRepoController } from './gitRepoController';

const execFileAsync = promisify(execFile);

type RepoHeadBranchChangedEvent = {
    repositoryPath: string;
    headBranch: GitBranchOption | undefined;
};

type HeadReadSlot = {
    running: boolean;
    needsRefresh: boolean;
    completion?: Promise<void>;
};

function repositoryKey(repositoryPath: string): string {
    const normalized = path.normalize(vscode.Uri.parse(repositoryPath).fsPath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 全部仓库 HEAD 的唯一监听者与查询者。 */
export class RepoHeadBranchWatcher implements vscode.Disposable {
    private readonly repositories = new Map<string, GitRepositoryOption>();
    private readonly repoWatchers = new Map<string, vscode.Disposable>();
    private readonly headBranches = new Map<string, GitBranchOption>();
    private readonly headReadSlots = new Map<string, HeadReadSlot>();
    private readonly repositorySubscription: vscode.Disposable;
    private readonly headBranchEmitter = new vscode.EventEmitter<RepoHeadBranchChangedEvent>();
    private readonly repoController: GitRepoController;
    private syncingRepositories = false;
    private needsRepositorySync = false;

    readonly onEachRepoHeadBranchChanged = this.headBranchEmitter.event;

    constructor(repoController: GitRepoController) {
        this.repoController = repoController;
        this.repositorySubscription = repoController.ontotalRepoListChanged(() => {
            this.requestRepositorySync();
        });
        this.requestRepositorySync();
    }

    async getHeadBranchByRepo(repository: GitRepositoryOption): Promise<GitBranchOption | undefined> {
        const key = repositoryKey(repository.path);
        const cached = this.headBranches.get(key);
        if (cached) { return cached; }
        if (!this.repositories.has(key)) { return this.readHeadBranch(repository); }
        return this.enqueueHeadRead(key, repository);
    }

    dispose(): void {
        this.repositorySubscription.dispose();
        this.repoWatchers.forEach(watcher => watcher.dispose());
        this.repoWatchers.clear();
        this.repositories.clear();
        this.headBranches.clear();
        this.headReadSlots.clear();
        this.headBranchEmitter.dispose();
    }

    private requestRepositorySync(): void {
        if (this.syncingRepositories) {
            this.needsRepositorySync = true;
            return;
        }
        void this.drainRepositorySync();
    }

    private async drainRepositorySync(): Promise<void> {
        this.syncingRepositories = true;
        try {
            do {
                this.needsRepositorySync = false;
                await this.syncRepositories(this.repoController.totalRepoList);
            } while (this.needsRepositorySync);
        } catch (error) {
            console.warn('无法同步仓库 HEAD 监听:', error);
        } finally {
            this.syncingRepositories = false;
            if (this.needsRepositorySync) { void this.drainRepositorySync(); }
        }
    }

    private async syncRepositories(nextRepositories: readonly GitRepositoryOption[]): Promise<void> {
        const nextByKey = new Map(nextRepositories.map(repository => [repositoryKey(repository.path), repository]));
        for (const [key, watcher] of this.repoWatchers) {
            if (nextByKey.has(key)) { continue; }
            watcher.dispose();
            this.repoWatchers.delete(key);
            this.repositories.delete(key);
            this.headReadSlots.delete(key);
            const previous = this.headBranches.get(key);
            this.headBranches.delete(key);
            if (previous) {
                this.headBranchEmitter.fire({ repositoryPath: previous.repoOption.path, headBranch: undefined });
            }
        }
        await Promise.all([...nextByKey.entries()].map(async ([key, repository]) => {
            if (this.repoWatchers.has(key)) {
                this.repositories.set(key, repository);
                return;
            }
            this.repositories.set(key, repository);
            const watcher = await this.createHeadWatcher(key, repository);
            if (!watcher) { return; }
            this.repoWatchers.set(key, watcher);
            await this.enqueueHeadRead(key, repository);
        }));
    }

    private async createHeadWatcher(key: string, repository: GitRepositoryOption): Promise<vscode.Disposable | undefined> {
        try {
            const rootUri = vscode.Uri.parse(repository.path);
            const { stdout } = await execFileAsync('git', [
                '--no-optional-locks', '-C', rootUri.fsPath, 'rev-parse', '--absolute-git-dir',
            ], { windowsHide: true });
            const gitDir = stdout.trim();
            if (!gitDir || this.repositories.get(key)?.path !== repository.path) { return undefined; }
            const headWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(gitDir), 'HEAD'),
            );
            const refresh = () => {
                const currentRepository = this.repositories.get(key);
                if (currentRepository) { void this.enqueueHeadRead(key, currentRepository); }
            };
            return vscode.Disposable.from(
                headWatcher,
                headWatcher.onDidCreate(refresh),
                headWatcher.onDidChange(refresh),
                headWatcher.onDidDelete(refresh),
            );
        } catch (error) {
            console.warn(`无法创建仓库 HEAD 监听: ${repository.path}`, error);
            return undefined;
        }
    }

    private enqueueHeadRead(key: string, repository: GitRepositoryOption): Promise<GitBranchOption | undefined> {
        const slot = this.headReadSlots.get(key) ?? { running: false, needsRefresh: false };
        this.headReadSlots.set(key, slot);
        if (slot.running) {
            slot.needsRefresh = true;
            return (slot.completion ?? Promise.resolve()).then(() => this.headBranches.get(key));
        }
        slot.running = true;
        const completion = this.drainHeadRead(key, repository, slot);
        slot.completion = completion;
        return completion.then(() => this.headBranches.get(key));
    }

    private async drainHeadRead(key: string, repository: GitRepositoryOption, slot: HeadReadSlot): Promise<void> {
        try {
            do {
                slot.needsRefresh = false;
                const currentRepository = this.repositories.get(key) ?? repository;
                const next = await this.readHeadBranch(currentRepository);
                if (!this.repositories.has(key)) { return; }
                if (this.repositories.get(key)?.path !== currentRepository.path) { return; }
                this.applyHeadBranch(key, currentRepository, next);
            } while (slot.needsRefresh);
        } catch (error) {
            console.warn(`无法读取仓库 HEAD: ${repository.path}`, error);
        } finally {
            slot.running = false;
            slot.completion = undefined;
            if (this.headReadSlots.get(key) === slot && !this.repositories.has(key)) {
                this.headReadSlots.delete(key);
            }
        }
    }

    private async readHeadBranch(repository: GitRepositoryOption): Promise<GitBranchOption | undefined> {
        const rootUri = vscode.Uri.parse(repository.path);
        const [branchName, headHash] = await Promise.all([
            getCurrentGitBranch(rootUri),
            getCurrentGitHeadHash(rootUri).catch(() => undefined),
        ]);
        if (!headHash) { return undefined; }
        return branchName
            ? new GitBranchOption({
                repoOption: repository,
                name: branchName,
                label: branchName.replace(/^refs\/heads\//, ''),
                hash: headHash,
                kind: 'current',
            })
            : buildDetachedHeadBranch(rootUri, headHash, repository);
    }

    private applyHeadBranch(key: string, repository: GitRepositoryOption, next: GitBranchOption | undefined): void {
        const previous = this.headBranches.get(key);
        if (previous?.name === next?.name && previous?.hash === next?.hash) {
            if (previous && previous.repoOption !== repository) {
                this.headBranches.set(key, new GitBranchOption({ ...previous, repoOption: repository }));
            }
            return;
        }
        if (next) {
            this.headBranches.set(key, next);
        } else {
            this.headBranches.delete(key);
        }
        this.headBranchEmitter.fire({ repositoryPath: repository.path, headBranch: next });
    }
}
