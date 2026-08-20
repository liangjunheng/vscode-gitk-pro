import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { copyRepositoryOption, equalsRepositoryOption, type GitRepositoryOption } from '../types';

const execFileAsync = promisify(execFile);

// 扫描期间的仓库记录; parentPath 存在即为子模块。
interface RepoRecord {
    rootPath: string;
    parentPath?: string;
}

function repoKey(filePath: string): string {
    return process.platform === 'win32' ? path.normalize(filePath).toLowerCase() : path.normalize(filePath);
}

// 属性全同即同一对象, 逐项 equals 相等就没变化, 不该 fire。
function sameOptionList(left: readonly GitRepositoryOption[], right: readonly GitRepositoryOption[]): boolean {
    return left.length === right.length && left.every((option, index) => equalsRepositoryOption(option, right[index]));
}

/**
 * 仓库维度状态的唯一写入者。
 *
 * 只管仓库与子模块, 不涉及分支/提交/变更文件, 也不直接操作 Webview。
 * 关键约束:
 * - scanning 只由扫描流程自身置回 false;
 * - 不接受外部 AbortSignal, 扫描有效性只取决于自身是否完成;
 * - scanning 为 true 时 rescan 直接丢弃, 不排队不打断, 因此无需代次机制;
 * - 扫描期间 totalRepoList 只增不减, selectedRepoList 不被清空。
 */
export class GitRepoController implements vscode.Disposable {
    private total: GitRepositoryOption[] = [];
    private selected: GitRepositoryOption[] = [];
    private isScanning = false;
    // 区分「默认选中当前仓库」与「用户显式选择」, 后者不随扫描结果改动。
    private hasUserSelection = false;
    private currentRepo?: GitRepositoryOption;

    private readonly totalEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly selectedEmitter = new vscode.EventEmitter<GitRepositoryOption[]>();
    private readonly scanningEmitter = new vscode.EventEmitter<boolean>();

    readonly ontotalRepoListChanged = this.totalEmitter.event;
    readonly onSelectedRepoListChanged = this.selectedEmitter.event;
    // scanning 是对外暴露的状态, 变化需可观测, 否则调用方无法呈现仓库加载态。
    readonly onScanningChanged = this.scanningEmitter.event;

    get totalRepoList(): readonly GitRepositoryOption[] { return this.total; }
    get selectedRepoList(): readonly GitRepositoryOption[] { return this.selected; }
    get scanning(): boolean { return this.isScanning; }

    /** 首次扫描: 先产出当前仓库让选择器立即可用, 再递归补齐子模块。 */
    async initialize(): Promise<GitRepositoryOption[]> {
        return this.runScan(true);
    }

    /** 强制重扫; scanning 时直接丢弃。 */
    async rescan(): Promise<GitRepositoryOption[]> {
        return this.runScan(false);
    }

    /** 用户操作入口, 唯一允许改 selectedRepoList 的公开方法; scanning 期间同样生效。 */
    selectRepositories(selectedRepoList: GitRepositoryOption[]): void {
        const next: GitRepositoryOption[] = [];
        for (const candidate of selectedRepoList) {
            const option = this.total.find(item => item.path === candidate.path);
            // 校验 1: 任一项不在 totalRepoList 中则整个调用忽略。
            if (!option) { return; }
            if (!next.some(item => item.path === option.path)) { next.push(option); }
        }
        // 校验 2: 与当前选择完全相同直接返回, 避免重复点击引发无意义的下游加载。
        // 属性全同即同一对象, 故用 equals 而非引用比较; 与顺序无关。
        if (next.length === this.selected.length
            && next.every(option => this.selected.some(item => equalsRepositoryOption(item, option)))) { return; }
        this.hasUserSelection = true;
        this.applySelected(next);
    }

    dispose(): void {
        this.totalEmitter.dispose();
        this.selectedEmitter.dispose();
        this.scanningEmitter.dispose();
    }

    private async runScan(isInitialize: boolean): Promise<GitRepositoryOption[]> {
        // 同步置位必须在任何 await 之前, 否则并发请求都能通过下面这道检查。
        if (this.isScanning) { return this.total; }
        this.isScanning = true;
        this.scanningEmitter.fire(true);
        try {
            const roots = await this.resolveWorkspaceRepositories();
            if (roots.length > 0) {
                // 当前仓库先落地, 选择器立即有内容, 不等子模块扫描。
                this.mergeIntoTotal(roots);
                this.currentRepo = this.total.find(option => option.path === this.toOptionPath(roots[0].rootPath));
                if (isInitialize && !this.hasUserSelection && this.selected.length === 0 && this.currentRepo) {
                    this.applySelected([this.currentRepo]);
                }
            }
            const scanned = await this.scanSubmodules(roots);
            this.converge(scanned);
            return this.total;
        } finally {
            // 扫描抛异常时 totalRepoList 保留已发现的部分, scanning 仍必须置回 false。
            this.isScanning = false;
            this.scanningEmitter.fire(false);
        }
    }

    private async resolveWorkspaceRepositories(): Promise<RepoRecord[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        // Promise.all 保序, 首个可解析的仓库即当前仓库。
        const resolved = await Promise.all(folders.map(folder => this.resolveRepositoryRoot(folder.uri.fsPath)));
        const records: RepoRecord[] = [];
        const seen = new Set<string>();
        for (const rootPath of resolved) {
            if (!rootPath) { continue; }
            const key = repoKey(rootPath);
            if (seen.has(key)) { continue; }
            seen.add(key);
            records.push({ rootPath });
        }
        return records;
    }

    // 逐层递归: 每层并行读 .gitmodules 并验证, 只有真实存在的子模块才进入下一层。
    private async scanSubmodules(roots: RepoRecord[]): Promise<RepoRecord[]> {
        const found = new Map<string, RepoRecord>();
        for (const root of roots) { found.set(repoKey(root.rootPath), root); }
        let layer = roots;
        while (layer.length > 0) {
            const candidates = (await Promise.all(layer.map(async parent => {
                const submodulePaths = await this.readSubmodulePaths(parent.rootPath);
                return submodulePaths.map(rootPath => ({ rootPath, parentPath: parent.rootPath }));
            }))).flat();
            const verified: RepoRecord[] = [];
            await Promise.all(candidates.map(async candidate => {
                if (found.has(repoKey(candidate.rootPath))) { return; }
                const rootPath = await this.resolveRepositoryRoot(candidate.rootPath);
                // 未初始化的子模块 rev-parse 会落到父仓库根, 路径不相等即视为未初始化。
                if (!rootPath || repoKey(rootPath) !== repoKey(candidate.rootPath)) { return; }
                if (found.has(repoKey(rootPath))) { return; }
                const record: RepoRecord = { rootPath, parentPath: candidate.parentPath };
                found.set(repoKey(rootPath), record);
                verified.push(record);
            }));
            // 增量合并即通知, 不必等全部完成。
            if (verified.length > 0) { this.mergeIntoTotal([...found.values()]); }
            layer = verified;
        }
        return [...found.values()];
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

    // 扫描期间只允许追加, 或用 copy 出的新对象替换旧对象; 禁止清空或收缩。
    private mergeIntoTotal(records: RepoRecord[]): void {
        const merged = [...this.total];
        for (const option of this.toOptions(records)) {
            const index = merged.findIndex(existing => existing.path === option.path);
            if (index === -1) { merged.push(option); continue; }
            // 属性全同视为同一对象, 不必替换; 有变化才换成 copy 出的新对象。
            if (equalsRepositoryOption(merged[index], option)) { continue; }
            merged[index] = copyRepositoryOption(merged[index], option);
        }
        this.applyTotal(this.sortOptions(merged));
    }

    // 扫描完成后的收敛: 整体替换列表, 已选项仅在确实消失时才剔除。
    private converge(records: RepoRecord[]): void {
        const options = this.sortOptions(this.toOptions(records));
        this.applyTotal(options);
        this.currentRepo = this.currentRepo
            ? options.find(option => option.path === this.currentRepo?.path)
            : undefined;
        // 按路径重映射到新选项, 4.5「当前仓库被识别为父仓库后更新默认选中项」
        // 由此自动满足: 重映射拿到的就是 copy 出的带最新 hasSubmodules 的那份。
        let next = this.selected.flatMap(selected => {
            const option = options.find(item => item.path === selected.path);
            return option ? [option] : [];
        });
        if (next.length === 0) {
            // 默认选中被删除时回退当前仓库; 用户显式选择则变为未选择仓库。
            next = !this.hasUserSelection && this.currentRepo ? [this.currentRepo] : [];
        }
        this.applySelected(next);
    }

    private applyTotal(options: GitRepositoryOption[]): void {
        if (sameOptionList(this.total, options)) { return; }
        this.total = options;
        this.totalEmitter.fire([...this.total]);
    }

    private applySelected(options: GitRepositoryOption[]): void {
        if (sameOptionList(this.selected, options)) { return; }
        this.selected = options;
        this.selectedEmitter.fire([...this.selected]);
    }

    private toOptionPath(rootPath: string): string {
        return vscode.Uri.file(rootPath).toString();
    }

    private toOptions(records: readonly RepoRecord[]): GitRepositoryOption[] {
        const parentPaths = new Set(records.flatMap(record => record.parentPath ? [repoKey(record.parentPath)] : []));
        return records.map(record => ({
            path: this.toOptionPath(record.rootPath),
            label: path.basename(record.rootPath) || record.rootPath,
            description: record.parentPath ? 'subrepo' : 'repo',
            hasSubmodules: parentPaths.has(repoKey(record.rootPath)),
        }));
    }

    private sortOptions(options: GitRepositoryOption[]): GitRepositoryOption[] {
        return [...options].sort((left, right) => {
            const leftSub = left.description === 'subrepo';
            const rightSub = right.description === 'subrepo';
            return Number(leftSub) - Number(rightSub) || left.label.localeCompare(right.label);
        });
    }
}
