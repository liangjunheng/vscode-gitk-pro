import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitRepositoryOption } from '../types';

const execFileAsync = promisify(execFile);


function repoKey(filePath: string): string {
    return process.platform === 'win32' ? path.normalize(filePath).toLowerCase() : path.normalize(filePath);
}

/**
 * 仓库维度状态的唯一写入者。
 *
 * 只管仓库与子模块, 不涉及分支/提交/变更文件, 也不直接操作 Webview。
 * 关键约束:
 * - loading 只由仓库加载流程自身置回 false;
 * - 不接受外部 AbortSignal, 加载有效性只取决于自身是否完成;
 * - loading 为 true 时 rescan 直接丢弃, 不排队不打断, 因此无需代次机制;
 * - 加载期间 total 只增不减, selected 不被清空。
 */
export class GitRepoController implements vscode.Disposable {
    private _totalRepoList: GitRepositoryOption[] = [];
    private _selectedRepoList: GitRepositoryOption[] = [];
    private _isLoading = false;
    // 区分「默认选中当前仓库」与「用户显式选择」, 后者不随扫描结果改动。
    private hasUserSelection = false;

    private readonly totalEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly selectedEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly reposLoadingEmitter = new vscode.EventEmitter<boolean>();

    readonly ontotalRepoListChanged = this.totalEmitter.event;
    readonly onSelectedRepoListChanged = this.selectedEmitter.event;
    // loading 是对外暴露的状态, 变化需可观测, 否则调用方无法呈现仓库加载态。
    readonly onReposLoadingChanged = this.reposLoadingEmitter.event;

    get totalRepoList(): readonly GitRepositoryOption[] { return this._totalRepoList; }
    get selectedRepoList(): readonly GitRepositoryOption[] { return this._selectedRepoList; }
    get isLoading(): boolean { return this._isLoading; }

    /** 首次加载: 先产出当前仓库让选择器立即可用, 再递归补齐子模块。 */
    async initialize(): Promise<GitRepositoryOption[]> {
        return this.runScan(true);
    }

    /** 强制重载; loading 时直接丢弃。 */
    async rescan(): Promise<GitRepositoryOption[]> {
        return this.runScan(false);
    }

    /** 用户操作入口, 唯一允许改 selected 的公开方法; loading 期间同样生效。 */
    selectRepositories(selected: GitRepositoryOption[]): boolean {
        console.log('[GitRepoController] selectRepositories', performance.now(), selected.map(repository => repository.path));
        this.hasUserSelection = true;
        this.applySelected(selected);
        return true;
    }

    dispose(): void {
        this.totalEmitter.dispose();
        this.selectedEmitter.dispose();
        this.reposLoadingEmitter.dispose();
    }

    private async runScan(isInitialize: boolean): Promise<GitRepositoryOption[]> {
        // 同步置位必须在任何 await 之前, 否则并发请求都能通过下面这道检查。
        if (this._isLoading) { return this._totalRepoList; }
        this._isLoading = true;
        this.reposLoadingEmitter.fire(true);
        try {
            const roots = await this.resolveWorkspaceRepositories();
            const scanned = await this.scanSubmodules(roots);
            const options = [...scanned].sort((left, right) => {
                const leftSub = left.description === 'subrepo';
                const rightSub = right.description === 'subrepo';
                return Number(leftSub) - Number(rightSub) || left.label.localeCompare(right.label);
            });
            this.applyTotal(options);
            if (isInitialize && !this.hasUserSelection && this._selectedRepoList.length === 0 && options.length > 0) {
                this.applySelected([options[0]]);
            }
            return this._totalRepoList;
        } finally {
            // 加载抛异常时 total 保留已发现的部分，loading 仍必须置回 false。
            this._isLoading = false;
            this.reposLoadingEmitter.fire(false);
        }
    }

    private async resolveWorkspaceRepositories(): Promise<GitRepositoryOption[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        // Promise.all 保序, 首个可解析的仓库即当前仓库。
        const resolved = await Promise.all(folders.map(folder => this.resolveRepositoryRoot(folder.uri.fsPath)));
        const records: GitRepositoryOption[] = [];
        const seen = new Set<string>();
        for (const rootPath of resolved) {
            if (!rootPath) { continue; }
            const key = repoKey(rootPath);
            if (seen.has(key)) { continue; }
            seen.add(key);
            records.push(new GitRepositoryOption({
                path: vscode.Uri.file(rootPath).toString(),
                label: path.basename(rootPath) || rootPath,
                description: 'repo',
            }));
        }
        return records;
    }

    // 逐层递归: 每层并行读 .gitmodules 并验证, 只有真实存在的子模块才进入下一层。
    private async scanSubmodules(roots: GitRepositoryOption[]): Promise<GitRepositoryOption[]> {
        const found = new Map<string, GitRepositoryOption>();
        const parentPaths = new Set<string>();
        for (const root of roots) { found.set(repoKey(vscode.Uri.parse(root.path).fsPath), root); }
        let layer = roots;
        while (layer.length > 0) {
            const candidates = (await Promise.all(layer.map(async parent => {
                const parentPath = vscode.Uri.parse(parent.path).fsPath;
                const submodulePaths = await this.readSubmodulePaths(parentPath);
                return submodulePaths.map(rootPath => ({ rootPath, parentPath }));
            }))).flat();
            const verified: GitRepositoryOption[] = [];
            await Promise.all(candidates.map(async candidate => {
                if (found.has(repoKey(candidate.rootPath))) { return; }
                const rootPath = await this.resolveRepositoryRoot(candidate.rootPath);
                if (!rootPath || repoKey(rootPath) !== repoKey(candidate.rootPath) || found.has(repoKey(rootPath))) { return; }
                const option = new GitRepositoryOption({
                    path: vscode.Uri.file(rootPath).toString(),
                    label: path.basename(rootPath) || rootPath,
                    description: 'subrepo',
                });
                found.set(repoKey(rootPath), option);
                parentPaths.add(repoKey(candidate.parentPath));
                verified.push(option);
            }));
            layer = verified;
        }
        return [...found.values()].map(option => new GitRepositoryOption({
            path: option.path,
            label: option.label,
            description: option.description,
            hasSubmodules: parentPaths.has(repoKey(vscode.Uri.parse(option.path).fsPath)),
        }));
    }

    private async resolveRepositoryRoot(directory: string): Promise<string | undefined> {
        try {
            const { stdout } = await execFileAsync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { windowsHide: true });
            const rootPath = stdout.trim();
            return rootPath ? path.normalize(rootPath) : undefined;
        } catch {
            return undefined;
        }
    }

    private async readSubmodulePaths(rootPath: string): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync('git', [
                '-C', rootPath,
                'config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
            ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
            return stdout.split('\0').flatMap(record => {
                const separator = record.indexOf('\n');
                if (separator === -1) { return []; }
                const submodulePath = record.slice(separator + 1);
                return submodulePath ? [path.resolve(rootPath, submodulePath)] : [];
            });
        } catch {
            // 无 .gitmodules 属正常情况, 静默视为无子模块。
            return [];
        }
    }

    private applyTotal(options: GitRepositoryOption[]): void {
        this._totalRepoList = options;
        this.totalEmitter.fire([...this._totalRepoList]);
    }

    private applySelected(options: GitRepositoryOption[]): void {
        this._selectedRepoList = options;
        console.log('[GitRepoController] selectedEmitter.fire before', performance.now(), this._selectedRepoList.map(repository => repository.path));
        this.selectedEmitter.fire([...this._selectedRepoList]);
        console.log('[GitRepoController] selectedEmitter.fire after', performance.now());
    }
}
