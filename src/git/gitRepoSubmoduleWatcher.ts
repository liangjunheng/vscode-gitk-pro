import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitRepositoryOption } from '../types';

const execFileAsync = promisify(execFile);

function repoKey(filePath: string): string {
    return process.platform === 'win32' ? path.normalize(filePath).toLowerCase() : path.normalize(filePath);
}

/** 维护工作区所有仓库及其递归子模块，并监听每个仓库的 .gitmodules。 */
export class RepoSubmoduleWatcher implements vscode.Disposable {
    private _totalRepoList: GitRepositoryOption[] = [];
    private _isLoading = false;
    private readonly rootPaths = new Map<string, string>();
    private readonly parentByRepository = new Map<string, string>();
    private readonly moduleWatchers = new Map<string, vscode.Disposable>();
    private readonly totalEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly loadingEmitter = new vscode.EventEmitter<boolean>();
    private rescanPromise?: Promise<GitRepositoryOption[]>;
    private fullRescanRequested = false;
    private readonly partialRescanPaths = new Set<string>();

    readonly onTotalRepoListChanged = this.totalEmitter.event;
    readonly onLoadingChanged = this.loadingEmitter.event;

    get totalRepoList(): readonly GitRepositoryOption[] { return this._totalRepoList; }
    get isLoading(): boolean { return this._isLoading; }

    async initialize(): Promise<GitRepositoryOption[]> {
        const nextRootPaths = new Map<string, string>();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const rootPath = await this.resolveRepositoryRoot(folder.uri.fsPath);
            if (rootPath) { nextRootPaths.set(repoKey(rootPath), rootPath); }
        }
        this.rootPaths.clear();
        for (const [key, rootPath] of nextRootPaths) { this.rootPaths.set(key, rootPath); }
        this.fullRescanRequested = true;
        return this.startQueuedScan();
    }

    async rescan(): Promise<GitRepositoryOption[]> {
        this.fullRescanRequested = true;
        return this.startQueuedScan();
    }

    private rescanRepository(repositoryPath: string): Promise<GitRepositoryOption[]> {
        this.partialRescanPaths.add(repoKey(repositoryPath));
        return this.startQueuedScan();
    }

    private startQueuedScan(): Promise<GitRepositoryOption[]> {
        if (this.rescanPromise) { return this.rescanPromise; }
        this.rescanPromise = (async () => {
            let result = this._totalRepoList;
            while (this.fullRescanRequested || this.partialRescanPaths.size > 0) {
                const fullRescan = this.fullRescanRequested;
                const partialPaths = new Set(this.partialRescanPaths);
                this.fullRescanRequested = false;
                this.partialRescanPaths.clear();
                result = await this.scan(fullRescan ? undefined : partialPaths);
            }
            return result;
        })().finally(() => {
            this.rescanPromise = undefined;
        });
        return this.rescanPromise;
    }

    dispose(): void {
        for (const watcher of this.moduleWatchers.values()) { watcher.dispose(); }
        this.moduleWatchers.clear();
        this.totalEmitter.dispose();
        this.loadingEmitter.dispose();
    }

    private async scan(startPaths?: ReadonlySet<string>): Promise<GitRepositoryOption[]> {
        if (this._isLoading) { return this._totalRepoList; }
        this._isLoading = true;
        this.loadingEmitter.fire(true);
        try {
            const isFull = !startPaths;
            const starts = startPaths
                ? [...startPaths].flatMap(start => {
                    const rootPath = this.rootPaths.get(start);
                    if (rootPath) { return [rootPath]; }
                    const repository = this._totalRepoList.find(item => repoKey(vscode.Uri.parse(item.path).fsPath) === start);
                    return repository ? [vscode.Uri.parse(repository.path).fsPath] : [];
                })
                : [...this.rootPaths.values()];
            const roots = await Promise.all(starts.map(async start => {
                const startKey = repoKey(start);
                const existing = this._totalRepoList.find(repository => repoKey(vscode.Uri.parse(repository.path).fsPath) === startKey);
                return existing ?? this.createRepositoryOption(start, this.rootPaths.has(startKey) ? 'repo' : 'subrepo');
            }));
            const found = new Map<string, GitRepositoryOption>();
            const localParents = new Map<string, string>();
            const layer = roots.filter((root): root is GitRepositoryOption => Boolean(root));
            for (const root of layer) { found.set(repoKey(vscode.Uri.parse(root.path).fsPath), root); }
            // 根仓库已识别即可发布；子模块扫描继续进行，不能阻塞初始化默认选择。
            if (isFull) {
                this.applyTotal(this.withSubmoduleFlags([...found.values()]));
            }
            let currentLayer = layer;
            while (currentLayer.length > 0) {
                const candidates = (await Promise.all(currentLayer.map(async parent => {
                    const parentPath = vscode.Uri.parse(parent.path).fsPath;
                    const paths = await this.readSubmodulePaths(parentPath);
                    return paths.map(rootPath => ({ rootPath, parentPath }));
                }))).flat();
                const nextLayer: GitRepositoryOption[] = [];
                await Promise.all(candidates.map(async candidate => {
                    const candidateKey = repoKey(candidate.rootPath);
                    localParents.set(candidateKey, repoKey(candidate.parentPath));
                    if (found.has(candidateKey)) { return; }
                    const rootPath = await this.resolveRepositoryRoot(candidate.rootPath);
                    if (!rootPath || repoKey(rootPath) !== candidateKey || found.has(candidateKey)) { return; }
                    const option = await this.createRepositoryOption(rootPath, 'subrepo');
                    if (!option) { return; }
                    found.set(candidateKey, option);
                    nextLayer.push(option);
                }));
                currentLayer = nextLayer;
            }
            if (isFull) {
                this.parentByRepository.clear();
                for (const [child, parent] of localParents) { this.parentByRepository.set(child, parent); }
                this.applyTotal(this.withSubmoduleFlags([...found.values()]));
            } else {
                const removed = this.collectDescendants(starts);
                for (const repositoryPath of removed) {
                    this.parentByRepository.delete(repositoryPath);
                }
                for (const [child, parent] of localParents) { this.parentByRepository.set(child, parent); }
                const merged = this._totalRepoList.filter(repository => !removed.has(repoKey(vscode.Uri.parse(repository.path).fsPath)));
                for (const repository of found.values()) {
                    const key = repoKey(vscode.Uri.parse(repository.path).fsPath);
                    const index = merged.findIndex(existing => repoKey(vscode.Uri.parse(existing.path).fsPath) === key);
                    if (index >= 0) { merged[index] = repository; } else { merged.push(repository); }
                }
                this.applyTotal(this.withSubmoduleFlags(merged));
            }
            this.syncModuleWatchers(this._totalRepoList);
            return this._totalRepoList;
        } finally {
            this._isLoading = false;
            this.loadingEmitter.fire(false);
        }
    }

    private collectDescendants(starts: readonly string[]): Set<string> {
        const removed = new Set<string>();
        let changed = true;
        while (changed) {
            changed = false;
            for (const [child, parent] of this.parentByRepository) {
                if (starts.includes(parent) || removed.has(parent)) {
                    if (!removed.has(child)) { removed.add(child); changed = true; }
                }
            }
        }
        return removed;
    }

    private withSubmoduleFlags(repositories: GitRepositoryOption[]): GitRepositoryOption[] {
        return repositories.map(repository => new GitRepositoryOption({
            path: repository.path,
            label: repository.label,
            description: repository.description,
            hasSubmodules: [...this.parentByRepository.values()].includes(repoKey(vscode.Uri.parse(repository.path).fsPath)),
        })).sort((left, right) => {
            const leftSub = left.description === 'subrepo';
            const rightSub = right.description === 'subrepo';
            return Number(leftSub) - Number(rightSub) || left.label.localeCompare(right.label);
        });
    }

    private async createRepositoryOption(rootPath: string, description: 'repo' | 'subrepo'): Promise<GitRepositoryOption | undefined> {
        const normalized = path.normalize(rootPath);
        return new GitRepositoryOption({
            path: vscode.Uri.file(normalized).toString(),
            label: path.basename(normalized) || normalized,
            description,
        });
    }

    private syncModuleWatchers(repositories: readonly GitRepositoryOption[]): void {
        const next = new Set(repositories.map(repository => repoKey(vscode.Uri.parse(repository.path).fsPath)));
        for (const [repositoryPath, watcher] of this.moduleWatchers) {
            if (!next.has(repositoryPath)) {
                watcher.dispose();
                this.moduleWatchers.delete(repositoryPath);
            }
        }
        for (const repository of repositories) {
            const repositoryPath = vscode.Uri.parse(repository.path).fsPath;
            const key = repoKey(repositoryPath);
            if (this.moduleWatchers.has(key)) { continue; }
            const moduleWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(repositoryPath), '.gitmodules'),
            );
            const watcher = vscode.Disposable.from(
                moduleWatcher,
                moduleWatcher.onDidCreate(() => { void this.rescanRepository(repositoryPath); }),
                moduleWatcher.onDidChange(() => { void this.rescanRepository(repositoryPath); }),
                moduleWatcher.onDidDelete(() => { void this.rescanRepository(repositoryPath); }),
            );
            this.moduleWatchers.set(key, watcher);
        }
    }

    private async resolveRepositoryRoot(directory: string): Promise<string | undefined> {
        try {
            const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--show-toplevel'], { windowsHide: true });
            const rootPath = stdout.trim();
            return rootPath ? path.normalize(rootPath) : undefined;
        } catch {
            return undefined;
        }
    }

    private async readSubmodulePaths(rootPath: string): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync('git', [
                '--no-optional-locks', '-C', rootPath,
                'config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
            ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
            return stdout.split('\0').flatMap(record => {
                const separator = record.indexOf('\n');
                if (separator === -1) { return []; }
                const submodulePath = record.slice(separator + 1);
                return submodulePath ? [path.resolve(rootPath, submodulePath)] : [];
            });
        } catch {
            return [];
        }
    }

    private applyTotal(options: GitRepositoryOption[]): void {
        const same = options.length === this._totalRepoList.length
            && options.every((option, index) => option.equals(this._totalRepoList[index]));
        if (same) { return; }
        this._totalRepoList = options;
        this.totalEmitter.fire([...options]);
    }
}
