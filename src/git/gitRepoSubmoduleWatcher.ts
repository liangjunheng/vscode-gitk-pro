import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
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

    /** 返回从根仓库到指定仓库的模块归属链。 */
    getRepositoryAncestry(repositoryPath: string): readonly GitRepositoryOption[] {
        const repositoriesByKey = new Map(this._totalRepoList.map(repository => [
            repoKey(vscode.Uri.parse(repository.path).fsPath), repository,
        ]));
        const ancestry: GitRepositoryOption[] = [];
        let currentKey = repoKey(vscode.Uri.parse(repositoryPath).fsPath);
        let repository = repositoriesByKey.get(currentKey);
        while (repository) {
            ancestry.unshift(repository);
            const parentKey = this.parentByRepository.get(currentKey);
            if (!parentKey) { break; }
            currentKey = parentKey;
            repository = repositoriesByKey.get(currentKey);
        }
        return ancestry;
    }

    /** 返回指定仓库及其全部嵌套子模块，按最深层到当前仓库排序。 */
    getRepositorySubtree(repositoryPath: string): readonly GitRepositoryOption[] {
        const repositoryKey = repoKey(vscode.Uri.parse(repositoryPath).fsPath);
        const subtreeKeys = this.collectDescendants([repositoryKey]);
        subtreeKeys.add(repositoryKey);
        return this._totalRepoList
            .filter(repository => subtreeKeys.has(repoKey(vscode.Uri.parse(repository.path).fsPath)))
            .sort((left, right) => this.getRepositoryAncestry(right.path).length - this.getRepositoryAncestry(left.path).length);
    }

    /** 按父仓库中的 gitlink 路径查找已初始化的直接子模块仓库。 */
    findSubmoduleRepository(parentRepositoryPath: string, gitlinkPath: string): GitRepositoryOption | undefined {
        const parentPath = vscode.Uri.parse(parentRepositoryPath).fsPath;
        const parentKey = repoKey(parentPath);
        const normalizedGitlinkPath = gitlinkPath.split('\\').join('/');
        return this._totalRepoList.find(repository => {
            const repositoryPath = vscode.Uri.parse(repository.path).fsPath;
            if (this.parentByRepository.get(repoKey(repositoryPath)) !== parentKey) { return false; }
            return path.relative(parentPath, repositoryPath).split(path.sep).join('/') === normalizedGitlinkPath;
        });
    }

    async initialize(): Promise<GitRepositoryOption[]> {
        const resolvedRoots = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async folder =>
            this.resolveRepositoryRoot(folder.uri.fsPath),
        ));
        const nextRootPaths = new Map<string, string>();
        for (const rootPath of resolvedRoots) {
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

    rescanRepository(repositoryPath: string): Promise<GitRepositoryOption[]> {
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
            for (const root of roots) {
                if (root) { found.set(repoKey(vscode.Uri.parse(root.path).fsPath), root); }
            }
            // 增量中间态：只叠加本次已发现的父子关系，并用上一轮列表补齐尚未重新扫描到的仓库。
            // 清空 parentByRepository 会让 hasSubmodules 退回 false，导致图标反复跳变；
            // 只用 found 发布会让尚未扫到的仓库从列表里消失，同样造成闪烁。
            const publishIntermediate = () => {
                // 局部重扫期间不发布中间态：结束时会与既有列表合并，中途发布只会干扰 removed 计算。
                if (!isFull) { return; }
                for (const [child, parent] of localParents) { this.parentByRepository.set(child, parent); }
                const baseline = this._totalRepoList.filter(repository =>
                    !found.has(repoKey(vscode.Uri.parse(repository.path).fsPath)));
                this.applyTotal(this.withSubmoduleFlags([...found.values(), ...baseline]));
            };
            // 根仓库已识别即可发布；子模块扫描继续进行，不能阻塞初始化默认选择。
            publishIntermediate();
            await Promise.all(roots.filter((root): root is GitRepositoryOption => Boolean(root)).map(async root => {
                const rootPath = vscode.Uri.parse(root.path).fsPath;
                await this.scanSubmodules(rootPath, found, localParents, publishIntermediate);
            }));
            if (isFull) {
                // 本轮完整扫描结束，父子关系与列表都以最终结果为准，清理已不存在的仓库。
                this.parentByRepository.clear();
                for (const [child, parent] of localParents) { this.parentByRepository.set(child, parent); }
                this.applyTotal(this.withSubmoduleFlags([...found.values()]));
            } else {
                const removed = this.collectDescendants(starts.map(repoKey));
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
        const repositoriesByKey = new Map(repositories.map(repository => [
            repoKey(vscode.Uri.parse(repository.path).fsPath), repository,
        ]));
        const parentKeys = new Set(this.parentByRepository.values());
        const ancestryFor = (repositoryKey: string) => {
            const ancestry = [];
            let parentKey = this.parentByRepository.get(repositoryKey);
            while (parentKey) {
                const parent = repositoriesByKey.get(parentKey);
                if (!parent) { break; }
                ancestry.unshift({
                    path: parent.path,
                    label: parent.label,
                    hasSubmodules: parentKeys.has(parentKey),
                });
                parentKey = this.parentByRepository.get(parentKey);
            }
            return ancestry;
        };
        return repositories.map(repository => {
            const key = repoKey(vscode.Uri.parse(repository.path).fsPath);
            return new GitRepositoryOption({
                path: repository.path,
                label: repository.label,
                description: repository.description,
                hasSubmodules: parentKeys.has(key),
                ancestry: ancestryFor(key),
            });
        }).sort((left, right) => {
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

    private async scanSubmodules(
        parentPath: string,
        found: Map<string, GitRepositoryOption>,
        parents: Map<string, string>,
        publish: () => void,
    ): Promise<void> {
        const declaredPaths = await this.readDeclaredSubmodulePaths(parentPath);
        for (const modulePath of declaredPaths) {
            if (!await this.hasGitHead(modulePath)) { continue; }
            const moduleKey = repoKey(modulePath);
            if (found.has(moduleKey)) { continue; }
            const option = await this.createRepositoryOption(modulePath, 'subrepo');
            if (!option) { continue; }
            parents.set(moduleKey, repoKey(parentPath));
            found.set(moduleKey, option);
            publish();
            await this.scanSubmodules(modulePath, found, parents, publish);
        }
    }

    private async readDeclaredSubmodulePaths(parentPath: string): Promise<string[]> {
        try {
            const gitmodules = await fs.readFile(path.join(parentPath, '.gitmodules'), 'utf8');
            const paths: string[] = [];
            for (const line of gitmodules.split(/\r?\n/)) {
                const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
                if (match) { paths.push(path.resolve(parentPath, match[1])); }
            }
            return paths;
        } catch {
            return [];
        }
    }

    private async hasGitHead(modulePath: string): Promise<boolean> {
        const gitPath = path.join(modulePath, '.git');
        try {
            const stat = await fs.stat(gitPath);
            if (stat.isDirectory()) {
                await fs.access(path.join(gitPath, 'HEAD'));
                return true;
            }
            const gitDirFile = await fs.readFile(gitPath, 'utf8');
            const match = /^gitdir:\s*(.+)\s*$/m.exec(gitDirFile);
            if (!match) { return false; }
            const gitDir = path.resolve(modulePath, match[1]);
            await fs.access(path.join(gitDir, 'HEAD'));
            return true;
        } catch {
            return false;
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
