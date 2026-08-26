import * as vscode from 'vscode';
import { GitRepositoryOption } from '../types';
import { RepoSubmoduleWatcher } from './gitRepoSubmoduleWatcher';

function repoKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

/** 仓库选择与对外状态门面；仓库拓扑由 RepoSubmoduleWatcher 唯一维护。 */
export class GitRepoController implements vscode.Disposable {
    private _totalRepoList: GitRepositoryOption[] = [];
    private _selectedRepoPaths: string[] = [];
    private hasUserSelection = false;
    private readonly totalEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly selectedEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly reposLoadingEmitter = new vscode.EventEmitter<boolean>();
    private readonly totalSubscription: vscode.Disposable;
    private readonly loadingSubscription: vscode.Disposable;

    readonly ontotalRepoListChanged = this.totalEmitter.event;
    readonly onSelectedRepoListChanged = this.selectedEmitter.event;
    readonly onReposLoadingChanged = this.reposLoadingEmitter.event;

    constructor(private readonly submoduleWatcher: RepoSubmoduleWatcher) {
        this.totalSubscription = submoduleWatcher.onTotalRepoListChanged(repositories => {
            this._totalRepoList = [...repositories];
            this.totalEmitter.fire([...this._totalRepoList]);
            // 根仓库列表已发布时立即默认选择；后续扫描更新不得覆盖已有选择。
            if (!this.hasUserSelection && this._selectedRepoPaths.length === 0 && repositories.length > 0) {
                this.applySelected([repositories[0]]);
            } else {
                this.applySelected(this.selectedRepoList);
            }
        });
        this.loadingSubscription = submoduleWatcher.onLoadingChanged(loading => {
            this.reposLoadingEmitter.fire(loading);
        });
    }

    get totalRepoList(): readonly GitRepositoryOption[] { return this._totalRepoList; }
    get selectedRepoList(): readonly GitRepositoryOption[] {
        const byPath = new Map(this._totalRepoList.map(repository => [repoKey(new URL(repository.path).pathname), repository]));
        return this._selectedRepoPaths.flatMap(repositoryPath => {
            const repository = byPath.get(repositoryPath);
            return repository ? [repository] : [];
        });
    }
    get isLoading(): boolean { return this.submoduleWatcher.isLoading; }

    async initialize(): Promise<GitRepositoryOption[]> {
        const repositories = await this.submoduleWatcher.initialize();
        this._totalRepoList = [...repositories];
        if (!this.hasUserSelection && this._selectedRepoPaths.length === 0 && repositories.length > 0) {
            this.applySelected([repositories[0]]);
        }
        return this._totalRepoList;
    }

    async rescan(): Promise<GitRepositoryOption[]> {
        const repositories = await this.submoduleWatcher.rescan();
        this._totalRepoList = [...repositories];
        return this._totalRepoList;
    }

    selectRepositories(selected: GitRepositoryOption[]): boolean {
        this.hasUserSelection = true;
        this.applySelected(selected);
        return true;
    }

    dispose(): void {
        this.totalSubscription.dispose();
        this.loadingSubscription.dispose();
        this.totalEmitter.dispose();
        this.selectedEmitter.dispose();
        this.reposLoadingEmitter.dispose();
    }

    private applySelected(options: readonly GitRepositoryOption[]): void {
        const paths = options.map(repository => repoKey(new URL(repository.path).pathname));
        if (paths.length === this._selectedRepoPaths.length && paths.every((value, index) => value === this._selectedRepoPaths[index])) { return; }
        this._selectedRepoPaths = paths;
        this.selectedEmitter.fire([...this.selectedRepoList]);
    }
}
