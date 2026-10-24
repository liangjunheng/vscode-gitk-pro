import * as path from 'path';
import * as vscode from 'vscode';
import { GitBranchOption, type GitRepositoryOption } from '../types';
import { buildDetachedHeadBranch } from './gitLogProvider';
import { GitRepoController } from './gitRepoController';
import { invokeNativeGit } from './nativeGitBinding';


type RepoHeadBranchChangedEvent = {
    repositoryPath: string;
    headBranch: GitBranchOption | undefined;
};

type RepoRemoteRefsChangedEvent = {
    repositoryPath: string;
};

type RepoStashChangedEvent = {
    repositoryPath: string;
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
    private readonly headBranchReadyEmitter = new vscode.EventEmitter<RepoHeadBranchChangedEvent>();
    private readonly headBranchEmitter = new vscode.EventEmitter<RepoHeadBranchChangedEvent>();
    private readonly remoteRefsChangedEmitter = new vscode.EventEmitter<RepoRemoteRefsChangedEvent>();
    private readonly stashChangedEmitter = new vscode.EventEmitter<RepoStashChangedEvent>();
    private readonly repoController: GitRepoController;
    private syncingRepositories = false;
    private needsRepositorySync = false;

    /**
     * Fires as soon as HEAD is resolved, before consumers that begin history and
     * branch work. The worktree watcher uses this to put the full initial status
     * read into the native queue first for every discovered repository.
     */
    readonly onEachRepoHeadBranchReady = this.headBranchReadyEmitter.event;
    readonly onEachRepoHeadBranchChanged = this.headBranchEmitter.event;
    readonly onEachRepoRemoteRefsChanged = this.remoteRefsChangedEmitter.event;
    /** refs/stash 或其 reflog 变化: 创建、drop、pop 都会改写它们(drop 非最后一条时只改 reflog)。 */
    readonly onEachRepoStashChanged = this.stashChangedEmitter.event;

    constructor(repoController: GitRepoController) {
        this.repoController = repoController;
        this.repositorySubscription = repoController.ontotalRepoListChanged(() => {
            this.requestRepositorySync();
        });
        this.requestRepositorySync();
    }

    getCachedHeadBranch(repository: GitRepositoryOption): GitBranchOption | undefined {
        const cached = this.headBranches.get(repositoryKey(repository.path));
        return cached ? new GitBranchOption({ ...cached, repoOption: repository }) : undefined;
    }

    /**
     * 读取 HEAD 真值, 不返回缓存。
     * 唯一调用方是分支刷新, 它正是在 refs 已被改写之后来取值的; 此时缓存几乎必然停在旧 hash,
     * 拿它组装的分支快照会被去重判定成"未变化", 外部提交便永远推不到提交列表。
     */
    async getHeadBranchByRepo(repository: GitRepositoryOption): Promise<GitBranchOption | undefined> {
        const key = repositoryKey(repository.path);
        if (!this.repositories.has(key)) { return this.readHeadBranch(repository); }
        return this.enqueueHeadRead(key, repository);
    }

    /**
     * 强制重新读取指定仓库的 HEAD 并等待结果落地。
     * logs/HEAD 监听已能异步感知外部提交, 但扩展自身提交后必须同步等到新 hash 落地:
     * 否则新 HEAD 的 staged 清单尚未读出就刷新提交列表, CommitPanel 会命中旧 hash 的缓存。
     */
    async refreshHeadBranch(repositoryPath: string): Promise<void> {
        const key = repositoryKey(repositoryPath);
        const repository = this.repositories.get(key);
        if (!repository) { return; }
        await this.enqueueHeadRead(key, repository);
    }

    dispose(): void {
        this.repositorySubscription.dispose();
        this.repoWatchers.forEach(watcher => watcher.dispose());
        this.repoWatchers.clear();
        this.repositories.clear();
        this.headBranches.clear();
        this.headReadSlots.clear();
        this.headBranchReadyEmitter.dispose();
        this.headBranchEmitter.dispose();
        this.remoteRefsChangedEmitter.dispose();
        this.stashChangedEmitter.dispose();
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
            const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: rootUri.fsPath });
            if (!gitDir || this.repositories.get(key)?.path !== repository.path) { return undefined; }
            // HEAD 只存符号引用(ref: refs/heads/x), commit/amend/merge/rebase/reset 都不改写它,
            // 只改写目标 ref 与 logs/HEAD; 只听 HEAD 就永远收不到这些移动的 HEAD 值变化信号。
            // logs/HEAD 是 git 记录 HEAD 移动的 reflog, 覆盖范围与 HEAD 值变化一一对应。
            const headWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,logs/HEAD}'),
            );
            const remoteRefsWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(gitDir), '{refs/remotes/**,packed-refs}'),
            );
            // 同一个 refs/stash 变更会触发 ref 与 reflog 两个事件, 合并成一次通知。
            const stashWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(gitDir), '{refs/stash,logs/refs/stash,packed-refs}'),
            );
            let stashNotifyTimer: ReturnType<typeof setTimeout> | undefined;
            let remoteRefsNotifyTimer: ReturnType<typeof setTimeout> | undefined;
            const notifyStashChanged = () => {
                if (stashNotifyTimer) { return; }
                stashNotifyTimer = setTimeout(() => {
                    stashNotifyTimer = undefined;
                    const currentRepository = this.repositories.get(key);
                    if (currentRepository) { this.stashChangedEmitter.fire({ repositoryPath: currentRepository.path }); }
                }, 50);
            };
            const refresh = () => {
                const currentRepository = this.repositories.get(key);
                if (currentRepository) { void this.enqueueHeadRead(key, currentRepository); }
            };
            const notifyRemoteRefsChanged = () => {
                // One Fetch can rewrite several loose refs plus packed-refs. Wait until that burst is quiet
                // so ahead/behind and cloud commits are reloaded once for the repository.
                if (remoteRefsNotifyTimer) { clearTimeout(remoteRefsNotifyTimer); }
                remoteRefsNotifyTimer = setTimeout(() => {
                    remoteRefsNotifyTimer = undefined;
                    const currentRepository = this.repositories.get(key);
                    if (currentRepository) { this.remoteRefsChangedEmitter.fire({ repositoryPath: currentRepository.path }); }
                }, 75);
            };
            return vscode.Disposable.from(
                headWatcher,
                remoteRefsWatcher,
                stashWatcher,
                { dispose: () => {
                    if (stashNotifyTimer) { clearTimeout(stashNotifyTimer); stashNotifyTimer = undefined; }
                    if (remoteRefsNotifyTimer) { clearTimeout(remoteRefsNotifyTimer); remoteRefsNotifyTimer = undefined; }
                } },
                stashWatcher.onDidCreate(notifyStashChanged),
                stashWatcher.onDidChange(notifyStashChanged),
                stashWatcher.onDidDelete(notifyStashChanged),
                headWatcher.onDidCreate(refresh),
                headWatcher.onDidChange(refresh),
                headWatcher.onDidDelete(refresh),
                remoteRefsWatcher.onDidCreate(notifyRemoteRefsChanged),
                remoteRefsWatcher.onDidChange(notifyRemoteRefsChanged),
                remoteRefsWatcher.onDidDelete(notifyRemoteRefsChanged),
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
        const head = await invokeNativeGit<{ branch?: string; hash?: string } | null>('head', {
            rootPath: rootUri.fsPath,
        }).catch(() => undefined);
        const branchName = head?.branch;
        const headHash = head?.hash;
        if (!headHash) { return undefined; }
        const branchRef = branchName && branchName.startsWith('refs/heads/')
            ? branchName
            : branchName ? `refs/heads/${branchName}` : undefined;
        return branchRef
            ? new GitBranchOption({
                repoOption: repository,
                name: branchRef,
                label: branchRef.replace(/^refs\/heads\//, ''),
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
        // Start full worktree status before the regular event starts refs/history
        // work. Keep the established event order for every other consumer.
        this.headBranchReadyEmitter.fire({ repositoryPath: repository.path, headBranch: next });
        this.headBranchEmitter.fire({ repositoryPath: repository.path, headBranch: next });
    }
}
