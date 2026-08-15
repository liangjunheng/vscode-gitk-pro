import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
// 类型定义统一从 types/ 导入, 消除重复
export type { ChangeSetMode, CommitFile, FileStatus, GitBranchOption, GitCommit, GitRepositoryOption, GitRepositoryState, WorkingTreeChanges } from '../types';
import type { ChangeSetMode, CommitFile, FileStatus, GitBranchOption, GitCommit, GitRepositoryOption, GitRepositoryState, WorkingTreeChanges } from '../types';

const execFileAsync = promisify(execFile);
const completeCommitFilesCache = new Map<string, CommitFile[]>();
const completeCommitFilesInFlight = new Map<string, Promise<CommitFile[]>>();
const maxCommitFilesCacheEntries = 100;

// 颜色池
const LANE_COLORS = [
    '#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b',
    '#56b6c2', '#ff7a7a', '#a6e22e', '#fd971f', '#ae81ff',
];

// 快速获取首个仓库路径
export async function getFirstRepoPath(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    for (const folder of workspaceFolders) {
        const rootPath = await resolveRepositoryRoot(folder.uri.fsPath);
        if (rootPath) { return vscode.Uri.file(rootPath).toString(); }
    }
    return undefined;
}

// 格式化日期
function formatDateLabel(date: Date | string): string {
    const raw = date instanceof Date ? date : new Date(date);
    const d = isNaN(raw.getTime()) ? new Date(0) : raw;
    if (isNaN(raw.getTime())) { return '0000-00-00 00:00:00'; }
    const parts = [
        d.getFullYear().toString().padStart(4, '0'),
        (d.getMonth() + 1).toString().padStart(2, '0'),
        d.getDate().toString().padStart(2, '0'),
        d.getHours().toString().padStart(2, '0'),
        d.getMinutes().toString().padStart(2, '0'),
        d.getSeconds().toString().padStart(2, '0'),
    ];
    return `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`;
}

function repositoryKey(filePath: string): string {
    return process.platform === 'win32' ? path.normalize(filePath).toLowerCase() : path.normalize(filePath);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) { return; }
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    throw error;
}

interface RepositoryRecord {
    rootPath: string;
    parentPath?: string;
}

function isNestedRepository(childPath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function getTopLevelRepositories(repositories: RepositoryRecord[]): RepositoryRecord[] {
    return repositories.filter(repository => !repositories.some(candidate =>
        repositoryKey(candidate.rootPath) !== repositoryKey(repository.rootPath)
        && isNestedRepository(repository.rootPath, candidate.rootPath)
    ));
}

function toGitRepositoryOptions(repositories: Iterable<RepositoryRecord>): GitRepositoryOption[] {
    const entries = [...repositories];
    const parentPaths = new Set(entries.flatMap(repository => repository.parentPath ? [repositoryKey(repository.parentPath)] : []));
    return entries.map(repository => ({
        path: vscode.Uri.file(repository.rootPath).toString(),
        label: path.basename(repository.rootPath) || repository.rootPath,
        description: repository.parentPath ? 'subrepo' : 'repo',
        hasSubmodules: parentPaths.has(repositoryKey(repository.rootPath)),
    })).sort((left, right) => {
        const leftSubrepository = left.description === 'subrepo';
        const rightSubrepository = right.description === 'subrepo';
        return Number(leftSubrepository) - Number(rightSubrepository) || left.label.localeCompare(right.label);
    });
}

async function getInitializedSubmodulePaths(rootPath: string, signal?: AbortSignal): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootPath,
            'config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
        return stdout.split('\0').flatMap(record => {
            if (!record) { return []; }
            const separator = record.indexOf('\n');
            if (separator === -1) { return []; }
            const submodulePath = record.slice(separator + 1);
            return submodulePath ? [path.resolve(rootPath, submodulePath)] : [];
        });
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        return [];
    }
}

// 递归任务调度: 同层验证并行，只有实际初始化的子模块才扫描下一层
async function collectSubmoduleRepositories(
    initialRepositories: RepositoryRecord[],
    onDiscovered?: (count: number) => void,
    signal?: AbortSignal
): Promise<RepositoryRecord[]> {
    const repositories = new Map<string, RepositoryRecord>();
    const batch = initialRepositories.slice();
    for (const repository of batch) {
        repositories.set(repositoryKey(repository.rootPath), repository);
    }
    const scanTasks = new Map<string, Promise<void>>();
    const scanRepository = (repository: RepositoryRecord): Promise<void> => {
        const key = repositoryKey(repository.rootPath);
        const existing = scanTasks.get(key);
        if (existing) { return existing; }
        const task = (async () => {
            const submodulePaths = await getInitializedSubmodulePaths(repository.rootPath, signal);
            const childTasks = submodulePaths.map(submodulePath =>
                resolveRepositoryRoot(submodulePath, signal).then(rootPath => {
                    if (!rootPath) { return undefined; }
                    const childKey = repositoryKey(rootPath);
                    if (repositories.has(childKey)) { return undefined; }
                    const child = { rootPath, parentPath: repository.rootPath };
                    repositories.set(childKey, child);
                    batch.push(child);
                    onDiscovered?.(batch.length - initialRepositories.length);
                    return scanRepository(child);
                })
            );
            await Promise.all(childTasks);
        })();
        scanTasks.set(key, task);
        return task;
    };
    await Promise.all(initialRepositories.map(scanRepository));
    return batch;
}

async function resolveRepositoryRoot(directory: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
            windowsHide: true,
            signal,
        });
        return stdout.trim() || undefined;
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        return undefined;
    }
}

// 仓库列表按工作区拓扑缓存；仅由工作区或 .gitmodules 变化主动失效。
let repositoriesCache: { repos: GitRepositoryOption[]; sourceKeys: string } | null = null;
const repositoriesInFlight = new Map<string, Promise<GitRepositoryOption[]>>();
let repositoriesCacheVersion = 0;

function awaitWithAbort<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) { return request; }
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            const error = new Error('请求已取消');
            error.name = 'AbortError';
            reject(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void request.then(
            value => { signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

function getWorkspaceSourceKeys(): string {
    return (vscode.workspace.workspaceFolders ?? [])
        .map(folder => repositoryKey(folder.uri.fsPath))
        .sort()
        .join('\0');
}

export function invalidateGitRepositoriesCache(): void {
    repositoriesCache = null;
    repositoriesCacheVersion++;
    repositoriesInFlight.clear();
}

export function invalidateGitRefsCache(rootUri?: vscode.Uri): void {
    const invalidateCommitPages = (rootKey: string): void => {
        commitPagesVersions.set(rootKey, (commitPagesVersions.get(rootKey) ?? 0) + 1);
        for (const key of commitPagesCache.keys()) {
            if (key.startsWith(`${rootKey}\0`)) { commitPagesCache.delete(key); }
        }
    };
    if (rootUri) {
        const key = rootUri.fsPath;
        branchesCache.delete(key);
        branchesCacheVersions.set(key, (branchesCacheVersions.get(key) ?? 0) + 1);
        invalidateCommitPages(key);
    } else {
        const keys = new Set([
            ...branchesCache.keys(), ...branchesInFlight.keys(), ...branchesCacheVersions.keys(),
            ...commitPagesVersions.keys(),
        ]);
        for (const key of keys) {
            branchesCacheVersions.set(key, (branchesCacheVersions.get(key) ?? 0) + 1);
            invalidateCommitPages(key);
        }
        branchesCache.clear();
    }
}

export async function getGitRepositories(
    onProgress?: (current: number, total: number, message?: string) => void,
    signal?: AbortSignal,
    onInitialRepositories?: (repositories: GitRepositoryOption[]) => void,
): Promise<GitRepositoryOption[]> {
    throwIfAborted(signal);
    const sourceKeys = getWorkspaceSourceKeys();
    if (repositoriesCache?.sourceKeys === sourceKeys) {
        onInitialRepositories?.(repositoriesCache.repos);
        return repositoriesCache.repos;
    }

    let scan = repositoriesInFlight.get(sourceKeys);
    if (!scan) {
        const cacheVersion = repositoriesCacheVersion;
        scan = getGitRepositoriesInternal(sourceKeys, onProgress, undefined, onInitialRepositories).then(repositories => {
            if (repositoriesCacheVersion === cacheVersion) {
                repositoriesCache = { repos: repositories, sourceKeys };
            }
            return repositories;
        });
        repositoriesInFlight.set(sourceKeys, scan);
        void scan.then(
            () => { if (repositoriesInFlight.get(sourceKeys) === scan) { repositoriesInFlight.delete(sourceKeys); } },
            () => { if (repositoriesInFlight.get(sourceKeys) === scan) { repositoriesInFlight.delete(sourceKeys); } },
        );
    } else {
        onProgress?.(0, 0, '正在等待子模块扫描完成...');
    }
    return awaitWithAbort(scan, signal);
}

async function getGitRepositoriesInternal(
    sourceKeys: string,
    onProgress?: (current: number, total: number, message?: string) => void,
    signal?: AbortSignal,
    onInitialRepositories?: (repositories: GitRepositoryOption[]) => void,
): Promise<GitRepositoryOption[]> {
    throwIfAborted(signal);

    const repositories = new Map<string, RepositoryRecord>();
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const pending: RepositoryRecord[] = [];

    // 2. 初始化仓库 (并行 git rev-parse)
    if (workspaceFolders.length > 0 && onProgress) { onProgress(0, 0, '初始化仓库...'); }
    const folderRoots = await Promise.all(workspaceFolders.map(folder => resolveRepositoryRoot(folder.uri.fsPath, signal)));
    throwIfAborted(signal);
    for (const rootPath of folderRoots) {
        if (rootPath && !pending.some(repository => repositoryKey(repository.rootPath) === repositoryKey(rootPath))) {
            pending.push({ rootPath });
        }
    }

    for (const repository of pending) {
        const key = repositoryKey(repository.rootPath);
        if (!repositories.has(key)) {
            repositories.set(key, repository);
        }
    }
    onInitialRepositories?.(toGitRepositoryOptions(repositories.values()));

    // 3. 只从顶层仓库扫描，已登记的嵌套仓库不会重复递归。
    if (onProgress) { onProgress(0, 0, '正在扫描子模块...'); }
    const scanRoots = getTopLevelRepositories(pending);
    const scanTaskResults = new Map<string, Promise<RepositoryRecord[]>>();
    const scanRoot = (root: RepositoryRecord): Promise<RepositoryRecord[]> => {
        const key = repositoryKey(root.rootPath);
        let task = scanTaskResults.get(key);
        if (!task) {
            task = collectSubmoduleRepositories([root], discovered => {
                if (onProgress) { onProgress(0, 0, `已扫描到子模块 ${discovered} 个...`); }
            }, signal);
            scanTaskResults.set(key, task);
        }
        return task;
    };
    const allRepositories = (await Promise.all(scanRoots.map(scanRoot))).flat();
    throwIfAborted(signal);
    for (const repository of allRepositories) {
        repositories.set(repositoryKey(repository.rootPath), repository);
    }

    return toGitRepositoryOptions(repositories.values());
}

interface GitRefRecord {
    hash: string;
    name: string;
    label: string;
}

// 分支缓存与单飞请求；分支变更沿用 invalidateGitRefsCache 主动失效。// 批量解析 ref -> commit hash, 单次 git rev-parse 调用
async function resolveCommitRefs(rootUri: vscode.Uri, refs: readonly string[], signal?: AbortSignal): Promise<string[]> {
    if (refs.length === 0) { return []; }
    const hashPattern = /^[0-9a-f]{40}$/i;
    const parseHashes = (stdout: string) =>
        [...new Set(stdout.split('\n').map(line => line.trim()).filter(line => hashPattern.test(line)))];
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootUri.fsPath, 'rev-parse', ...refs.map(ref => `${ref}^{commit}`),
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
        return parseHashes(stdout);
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        // 部分失败时 stdout 仍含有效哈希
        return error.stdout ? parseHashes(error.stdout) : [];
    }
}


interface CommitAuthorDetails {
    name: string;
    email: string;
    date: string;
}

async function getCommitAuthorDetails(rootUri: vscode.Uri, hashes: readonly string[]): Promise<Map<string, CommitAuthorDetails>> {
    if (hashes.length === 0) { return new Map(); }
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootUri.fsPath, 'show', '-s', '--format=%H%x00%an%x00%ae%x00%aI%x00', ...hashes,
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        const values = stdout.split('\0');
        const details = new Map<string, CommitAuthorDetails>();
        for (let index = 0; index + 3 < values.length; index += 4) {
            const [rawHash, name, email, date] = values.slice(index, index + 4);
            const hash = rawHash.trim();
            if (hash) { details.set(hash, { name, email, date: date.trim() }); }
        }
        return details;
    } catch {
        return new Map();
    }
}

async function readBranchRefsFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<{ currentBranch?: string; local: GitRefRecord[]; remote: GitRefRecord[] }> {
    const parseRefs = (stdout: string) => stdout.split(/\r?\n/).flatMap(line => {
        if (!line) { return []; }
        const [hash, label, name] = line.split('\t');
        if (!hash || !label || !name || label.endsWith('/HEAD')) { return []; }
        return [{ hash, label, name }];
    });
    const [currentResult, refsResult] = await Promise.all([
        execFileAsync('git', ['-C', rootUri.fsPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true, signal }).catch(error => {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
            return { stdout: '' };
        }),
        execFileAsync('git', [
            '-C', rootUri.fsPath,
            'for-each-ref', '--format=%(objectname)%09%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
    ]);
    const refs = parseRefs(refsResult.stdout);
    const currentName = currentResult.stdout.trim();
    return {
        currentBranch: currentName ? `refs/heads/${currentName}` : undefined,
        local: refs.filter(ref => ref.name.startsWith('refs/heads/')),
        remote: refs.filter(ref => ref.name.startsWith('refs/remotes/')),
    };
}

// 分支缓存与单飞请求；分支变更沿用 invalidateGitRefsCache 主动失效。
const branchesCache = new Map<string, GitBranchOption[]>();
const branchesInFlight = new Map<string, Promise<GitBranchOption[]>>();
const branchesCacheVersions = new Map<string, number>();
const BRANCHES_CACHE_MAX = 20;

export async function getGitBranches(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitBranchOption[]> {
    throwIfAborted(signal);
    const key = rootUri.fsPath;
    const cached = branchesCache.get(key);
    if (cached) { return cached; }
    let request = branchesInFlight.get(key);
    if (!request) {
        const requestVersion = branchesCacheVersions.get(key) ?? 0;
        request = (async () => {
            try {
                const { currentBranch, local, remote } = await readBranchRefsFromCli(rootUri);
                const branchRefs = [...local, ...remote];
                const currentRef = currentBranch ? local.find(ref => ref.name === currentBranch) : undefined;
                const current = currentRef ? [{
                    name: currentRef.name,
                    label: currentRef.label,
                    hash: currentRef.hash,
                    kind: 'current' as const,
                }] : [];
                const branches = branchRefs.map(ref => ({
                    name: ref.name,
                    label: ref.label,
                    hash: ref.hash,
                    kind: ref.name.startsWith('refs/remotes/') ? 'remote' as const : 'local' as const,
                })).sort((left, right) => Number(left.kind === 'remote') - Number(right.kind === 'remote') || left.label.localeCompare(right.label));
                const result = [...current, ...branches];
                if ((branchesCacheVersions.get(key) ?? 0) === requestVersion) {
                    if (branchesCache.size >= BRANCHES_CACHE_MAX) {
                        branchesCache.delete(branchesCache.keys().next().value!);
                    }
                    branchesCache.set(key, result);
                }
                return result;
            } catch (error) {
                throw new Error(`无法读取分支: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
        branchesInFlight.set(key, request);
        void request.then(
            () => { if (branchesInFlight.get(key) === request) { branchesInFlight.delete(key); } },
            () => { if (branchesInFlight.get(key) === request) { branchesInFlight.delete(key); } },
        );
    }
    return awaitWithAbort(request, signal);
}

export async function getCurrentGitBranch(rootUri: vscode.Uri): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', rootUri.fsPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
            windowsHide: true,
        });
        const label = stdout.trim();
        return label ? `refs/heads/${label}` : undefined;
    } catch {
        // Detached HEAD 时 symbolic-ref 按 Git 约定返回非零。
        return undefined;
    }
}

export async function getCurrentGitHeadHash(rootUri: vscode.Uri, signal?: AbortSignal): Promise<string | undefined> {
    const { stdout } = await execFileAsync('git', ['-C', rootUri.fsPath, 'rev-parse', 'HEAD'], {
        windowsHide: true,
        signal,
    });
    const hash = stdout.trim();
    return hash || undefined;
}

export interface GitSyncResult {
    headChanged: boolean;
    submodulesNeedUpdate: boolean;
    submoduleTopologyChanged: boolean;
}

interface GitlinkChange {
    status: string;
    path: string;
}

async function getGitlinkChanges(rootUri: vscode.Uri, beforeHead: string, afterHead: string): Promise<GitlinkChange[]> {
    const output = await runGitCommand(rootUri, [
        'diff', '--raw', '-z', '--no-abbrev', '--no-renames', beforeHead, afterHead, '--',
    ]);
    const fields = output.split('\0');
    const changes: GitlinkChange[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const header = fields[index];
        const path = fields[index + 1];
        const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(header);
        if (match && path && (match[1] === '160000' || match[2] === '160000')) {
            changes.push({ status: match[3], path });
        }
    }
    return changes;
}

export async function runGitSync(
    rootUri: vscode.Uri,
    action: 'fetch' | 'pull' | 'push',
    onProgress?: (message: string) => void,
): Promise<GitSyncResult> {
    if (action === 'fetch') {
        onProgress?.('正在获取所有远程仓库，并清理过期引用...');
        await runGitCommand(rootUri, ['fetch', '--all', '--prune', '--recurse-submodules=on-demand']);

        const repositories = await collectSubmoduleRepositories([{ rootPath: rootUri.fsPath }]);
        const submodules = repositories.slice(1);
        for (let index = 0; index < submodules.length; index++) {
            const submodule = submodules[index];
            onProgress?.(`正在获取 Submodule 模块（${index + 1}/${submodules.length}）：${submodule.rootPath}`);
            await runGitCommand(vscode.Uri.file(submodule.rootPath), ['fetch', '--all', '--prune']);
            onProgress?.(`已完成 Submodule 模块（${index + 1}/${submodules.length}）：${submodule.rootPath}`);
        }
        return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false };
    }

    if (action === 'pull') {
        const beforeHead = await getCurrentGitHeadHash(rootUri);
        onProgress?.('正在拉取远程代码...');
        await runGitCommand(rootUri, ['pull']);
        const afterHead = await getCurrentGitHeadHash(rootUri);
        if (!beforeHead || !afterHead || beforeHead === afterHead) {
            return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false };
        }

        const gitlinkChanges = await getGitlinkChanges(rootUri, beforeHead, afterHead);
        return {
            headChanged: true,
            submodulesNeedUpdate: gitlinkChanges.some(change => change.status !== 'D'),
            submoduleTopologyChanged: gitlinkChanges.some(change => change.status === 'A' || change.status === 'D'),
        };
    }

    onProgress?.('正在推送本地提交...');
    await runGitCommand(rootUri, ['push']);
    return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false };
}

export async function updateGitSubmodules(
    rootUri: vscode.Uri,
    onProgress?: (message: string) => void,
): Promise<void> {
    onProgress?.('正在递归初始化并更新 Submodule 模块...');
    await runGitCommand(rootUri, ['submodule', 'update', '--init', '--recursive']);
    const status = await runGitCommand(rootUri, ['submodule', 'status', '--recursive']);
    for (const line of status.split(/\r?\n/)) {
        const match = /^[ +\-U]?\S+\s+(.+?)(?:\s+\(|$)/.exec(line);
        if (match) {
            onProgress?.(`已完成 Submodule 模块：${match[1]}`);
        }
    }
}

export async function runGitCommand(rootUri: vscode.Uri, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', rootUri.fsPath, ...args], {
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
    }
}

// 解析 git log --format 输出
function parseLogOutput(stdout: string): GitCommit[] {
    return stdout.split('\x1e').flatMap(record => {
        const [hash, parentText, author, authorEmail, committer, committerEmail, dateText, subject, body, decorations] = record.trim().split('\x1f');
        if (!hash) { return []; }
        const authorDate = new Date(dateText);
        return [{
            hash,
            shortHash: hash.slice(0, 8),
            parents: parentText ? parentText.split(' ').filter(Boolean) : [],
            author: author || authorEmail || 'Unknown author',
            authorEmail,
            committer: committer || committerEmail || author || authorEmail || 'Unknown committer',
            committerEmail,
            authorDate: !isNaN(authorDate.getTime()) ? authorDate.toISOString() : '',
            authorDateLabel: formatDateLabel(authorDate),
            message: subject || '',
            body: body || '',
            refs: decorations ? decorations.split(', ').map(ref => ref.replace(/^HEAD -> /, '')).filter(Boolean) : [],
        }];
    });
}

async function readCommitsFromCli(rootUri: vscode.Uri, limit: number, refs: readonly string[], skip: number, signal?: AbortSignal): Promise<GitCommit[]> {
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const { stdout } = await execFileAsync('git', [
        '-C', rootUri.fsPath, 'log', '--topo-order', `--max-count=${limit}`, ...(skip > 0 ? [`--skip=${skip}`] : []),
        '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1f%D%x1e', ...commitRefs,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
    return parseLogOutput(stdout);
}

// 提交页缓存与单飞请求；HEAD 或 refs 变化时由 invalidateGitRefsCache 失效。
const commitPagesCache = new Map<string, GitCommit[]>();
const commitPagesInFlight = new Map<string, Promise<GitCommit[]>>();
const commitPagesVersions = new Map<string, number>();
const COMMIT_PAGES_CACHE_MAX = 20;

function getCommitPageCacheKey(rootUri: vscode.Uri, limit: number, refs: readonly string[], skip: number): string {
    return `${rootUri.fsPath}\0${refs.slice().sort().join('\0')}\0${skip}\0${limit}`;
}

// 获取仓库提交列表
export async function getGitCommits(rootUri: vscode.Uri, limit: number = 500, refs: readonly string[] = [], skip: number = 0, onProgress?: (current: number, total: number) => void, signal?: AbortSignal): Promise<GitCommit[]> {
    throwIfAborted(signal);
    if (onProgress) { onProgress(0, 1); }
    const rootKey = rootUri.fsPath;
    const cacheKey = getCommitPageCacheKey(rootUri, limit, refs, skip);
    const cached = commitPagesCache.get(cacheKey);
    if (cached) {
        if (onProgress) { onProgress(1, 1); }
        return cached;
    }
    let request = commitPagesInFlight.get(cacheKey);
    if (!request) {
        const requestVersion = commitPagesVersions.get(rootKey) ?? 0;
        commitPagesVersions.set(rootKey, requestVersion);
        request = readCommitsFromCli(rootUri, limit, refs, skip).then(commits => {
            if ((commitPagesVersions.get(rootKey) ?? 0) === requestVersion) {
                if (commitPagesCache.size >= COMMIT_PAGES_CACHE_MAX) {
                    commitPagesCache.delete(commitPagesCache.keys().next().value!);
                }
                commitPagesCache.set(cacheKey, commits);
            }
            return commits;
        });
        commitPagesInFlight.set(cacheKey, request);
        void request.then(
            () => { if (commitPagesInFlight.get(cacheKey) === request) { commitPagesInFlight.delete(cacheKey); } },
            () => { if (commitPagesInFlight.get(cacheKey) === request) { commitPagesInFlight.delete(cacheKey); } },
        );
    }
    const commits = await awaitWithAbort(request, signal);
    if (onProgress) { onProgress(1, 1); }
    return commits;
}

// 搜索提交: 全量获取后在 TS 端过滤, 任意关键词命中任意字段即返回
export async function searchCommits(rootUri: vscode.Uri, keywords: string[], refs: readonly string[] = [], signal?: AbortSignal): Promise<GitCommit[]> {
    if (keywords.length === 0) { return []; }
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const { stdout } = await execFileAsync('git', [
        '-C', rootUri.fsPath, 'log', '--topo-order',
        '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1f%D%x1e', ...commitRefs,
    ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, signal });
    const allCommits = parseLogOutput(stdout);
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    return allCommits.filter(c => {
        const fields = [
            c.hash, c.shortHash,
            c.parents.join(' '),
            c.author, c.authorEmail,
            c.committer, c.committerEmail,
            c.authorDate, c.authorDateLabel,
            c.message, c.body,
            c.refs.join(' '),
        ].map(f => (f || '').toLowerCase());
        return lowerKeywords.some(kw => fields.some(f => f.includes(kw)));
    });
}

// 图形布局：按 VS Code SCM History 的 inputSwimlanes → outputSwimlanes 状态机转换。
export function buildGraph(commits: GitCommit[]): GitCommit[] {
    interface Swimlane { hash: string; color: string; }
    let outputSwimlanes: Swimlane[] = [];
    let nextColor = 0;
    const createSwimlane = (hash: string, color?: string): Swimlane => ({
        hash,
        color: color ?? LANE_COLORS[nextColor++ % LANE_COLORS.length],
    });

    for (const commit of commits) {
        const inputSwimlanes = outputSwimlanes.map(lane => ({ ...lane }));
        const inputIndex = inputSwimlanes.findIndex(lane => lane.hash === commit.hash);
        const lane = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
        const nextSwimlanes: Swimlane[] = [];
        let firstParentAdded = false;

        // 首个命中 lane 是当前提交主轨；同 hash 的其余 lane 在此汇入，不再向下延续。
        for (let index = 0; index < inputSwimlanes.length; index++) {
            const inputLane = inputSwimlanes[index];
            if (inputLane.hash === commit.hash) {
                if (index === inputIndex && commit.parents.length > 0) {
                    nextSwimlanes.push(createSwimlane(commit.parents[0], inputLane.color));
                    firstParentAdded = true;
                }
                continue;
            }
            nextSwimlanes.push({ ...inputLane });
        }

        // 与 VS Code 一致：第一父原位替换当前轨道；其他父始终追加独立泳道。
        // 即使父提交已在别的泳道中也不能去重，否则 merge 与多轮分支的起点会丢失。
        for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
            nextSwimlanes.push(createSwimlane(commit.parents[index]));
        }

        commit.lane = lane;
        commit.laneColor = inputIndex >= 0
            ? inputSwimlanes[inputIndex].color
            : nextSwimlanes[lane]?.color ?? LANE_COLORS[nextColor % LANE_COLORS.length];
        commit.laneStartsHere = inputIndex < 0;
        commit.inputSwimlanes = inputSwimlanes;
        commit.outputSwimlanes = nextSwimlanes;
        outputSwimlanes = nextSwimlanes;
    }
    return commits;
}

// 判断是否 git 仓库
export async function isGitRepo(rootUri: vscode.Uri): Promise<boolean> {
    return !!await resolveRepositoryRoot(rootUri.fsPath);
}

// 通过 git 命令获取指定提交的变更文件列表
export async function getCommitFiles(rootUri: vscode.Uri, hash: string, signal?: AbortSignal): Promise<CommitFile[]> {
    return getCommitFilesWithLineStats(rootUri, hash, signal);
}

export async function getCommitFilesWithLineStats(rootUri: vscode.Uri, hash: string, signal?: AbortSignal, onProgress?: (current: number, total: number) => void): Promise<CommitFile[]> {
    const cacheKey = `${rootUri.fsPath}\0${hash}`;
    const cached = completeCommitFilesCache.get(cacheKey);
    if (cached) {
        onProgress?.(cached.length, cached.length);
        return cached;
    }
    // 可取消的前台请求不能复用预加载请求，避免旧调用者取消当前选择。
    const pending = signal ? undefined : completeCommitFilesInFlight.get(cacheKey);
    if (pending) { return pending; }
    const request = (async () => {
        onProgress?.(0, 0);
        const [rawResult, numStatResult] = await Promise.all([
            execFileAsync('git', [
                '-C', rootUri.fsPath,
                'diff-tree', '--root', '--no-commit-id', '--raw', '-z', '-M', '-C', '-r', hash,
            ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
            execFileAsync('git', [
                '-C', rootUri.fsPath,
                'diff-tree', '--root', '--no-commit-id', '--numstat', '-z', '-M', '-C', '-r', hash,
            ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        ]);
        const files = applyNumStat(parseRawStatus(rawResult.stdout), numStatResult.stdout);
        completeCommitFilesCache.set(cacheKey, files);
        if (completeCommitFilesCache.size > maxCommitFilesCacheEntries) {
            completeCommitFilesCache.delete(completeCommitFilesCache.keys().next().value!);
        }
        onProgress?.(files.length, files.length);
        return files;
    })();
    if (!signal) { completeCommitFilesInFlight.set(cacheKey, request); }
    try {
        return await request;
    } finally {
        if (!signal && completeCommitFilesInFlight.get(cacheKey) === request) {
            completeCommitFilesInFlight.delete(cacheKey);
        }
    }
}

export async function getGitRepositoryState(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    return readRepositoryStateFromCli(rootUri, signal);
}

// 从 git CLI 读状态签名 (4 条命令并行)
async function readRepositoryStateFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    try {
        const [headResult, branchResult, refsResult, statusResult] = await Promise.all([
            execFileAsync('git', ['-C', rootUri.fsPath, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true, signal }),
            execFileAsync('git', ['-C', rootUri.fsPath, 'branch', '--show-current'], { windowsHide: true, signal }),
            execFileAsync('git', ['-C', rootUri.fsPath, 'for-each-ref', '--format=%(refname) %(objectname)'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
            execFileAsync('git', ['-C', rootUri.fsPath, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        ]);
        return {
            head: headResult.stdout.trim(),
            branch: branchResult.stdout.trim() || 'HEAD',
            refs: refsResult.stdout,
            status: statusResult.stdout,
        };
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取仓库状态: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function getWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
    // 分支选择器发布前必须使用同一份完整 Git 状态快照。
    return readWorkingTreeChangesFromCli(rootUri, signal);
}

// 仅判断暂存区与工作区是否有变更，不读取 Diff 元数据。
export async function getWorkingTreeChangePresence(rootUri: vscode.Uri, signal?: AbortSignal): Promise<{ staged: boolean; changes: boolean }> {
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootUri.fsPath,
            'status', '--porcelain=v1', '-z', '--untracked-files=normal',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
        let staged = false;
        let changes = false;
        const entries = stdout.split('\0');
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry || entry.length < 3 || entry[2] !== ' ') { continue; }
            const indexStatus = entry[0];
            const workingTreeStatus = entry[1];
            staged ||= indexStatus !== ' ' && indexStatus !== '?';
            changes ||= workingTreeStatus !== ' ';
            if (indexStatus === 'R' || indexStatus === 'C' || workingTreeStatus === 'R' || workingTreeStatus === 'C') { index++; }
            if (staged && changes) { break; }
        }
        return { staged, changes };
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取工作区变更状态: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// 从 git CLI 读工作区变更
async function readWorkingTreeChangesFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
    try {
        const [statusResult, stagedMetadata, changesMetadata] = await Promise.all([
            execFileAsync('git', [
                '-C', rootUri.fsPath,
                'status', '--porcelain=v1', '-z', '--untracked-files=all',
            ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
            readDiffMetadata(rootUri, ['diff', '--cached'], signal),
            readDiffMetadata(rootUri, ['diff'], signal),
        ]);
        const stdout = statusResult.stdout;
        const staged: CommitFile[] = [];
        const changes: CommitFile[] = [];
        const entries = stdout.split('\0');
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry || entry.length < 4) { continue; }
            const indexStatus = entry[0];
            const workingTreeStatus = entry[1];
            const filePath = entry.slice(3);
            const hasRenameSource = indexStatus === 'R' || indexStatus === 'C' || workingTreeStatus === 'R' || workingTreeStatus === 'C';
            const renameSourcePath = hasRenameSource ? entries[++index] || undefined : undefined;
            if (indexStatus !== ' ' && indexStatus !== '?') {
                staged.push({
                    path: filePath,
                    status: porcelainStatus(indexStatus),
                    oldPath: indexStatus === 'R' || indexStatus === 'C' ? renameSourcePath : undefined,
                });
            }
            if (workingTreeStatus !== ' ') {
                changes.push({
                    path: filePath,
                    status: porcelainStatus(workingTreeStatus),
                    oldPath: workingTreeStatus === 'R' || workingTreeStatus === 'C' ? renameSourcePath : undefined,
                });
            }
        }
        return {
            staged: mergeDiffMetadata(staged, stagedMetadata),
            changes: mergeDiffMetadata(changes, changesMetadata),
        };
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取工作区变更: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function porcelainStatus(status: string): FileStatus {
    switch (status) {
        case 'A': case '?': return 'A';
        case 'D': return 'D';
        case 'R': return 'R';
        case 'C': return 'C';
        case 'T': return 'T';
        case 'U': return 'U';
        default: return 'M';
    }
}

async function readDiffMetadata(rootUri: vscode.Uri, args: string[], signal?: AbortSignal): Promise<CommitFile[]> {
    const [rawResult, numStatResult] = await Promise.all([
        execFileAsync('git', ['-C', rootUri.fsPath, ...args, '--raw', '-z', '-M', '-C'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        execFileAsync('git', ['-C', rootUri.fsPath, ...args, '--numstat', '-z', '-M', '-C'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
    ]);
    return applyNumStat(parseRawStatus(rawResult.stdout), numStatResult.stdout);
}

function mergeDiffMetadata(files: CommitFile[], metadata: CommitFile[]): CommitFile[] {
    return files.map(file => {
        const match = metadata.find(candidate => candidate.path === file.path && candidate.status === file.status)
            ?? metadata.find(candidate => candidate.path === file.path);
        return match ? { ...file, ...match, status: file.status } : file;
    });
}

function parseRawStatus(output: string): CommitFile[] {
    const files: CommitFile[] = [];
    const fields = output.split('\0');
    for (let index = 0; index < fields.length;) {
        const header = fields[index++];
        if (!header?.startsWith(':')) { continue; }
        const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(header);
        if (!match) { continue; }
        const [, oldMode, newMode, oldObjectId, newObjectId, status] = match;
        const code = status[0];
        const firstPath = fields[index++];
        if (!firstPath) { continue; }
        const oldPath = code === 'R' || code === 'C' ? firstPath : undefined;
        const path = oldPath ? fields[index++] : firstPath;
        if (!path) { continue; }
        files.push({ path, oldPath, status: porcelainStatus(code), oldObjectId, newObjectId, oldMode, newMode });
    }
    return files;
}

function applyNumStat(files: CommitFile[], output: string): CommitFile[] {
    const stats = new Map<string, { addedLines: number; removedLines: number; isBinary: boolean }>();
    const fields = output.split('\0');
    for (let index = 0; index < fields.length;) {
        const entry = fields[index++];
        if (!entry) { continue; }
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry);
        if (!match) { continue; }
        const path = match[3] || fields[index + 1];
        if (!path) { continue; }
        if (!match[3]) { index += 2; }
        const isBinary = match[1] === '-' && match[2] === '-';
        const addedLines = match[1] === '-' ? 0 : Number(match[1]);
        const removedLines = match[2] === '-' ? 0 : Number(match[2]);
        stats.set(path, { addedLines, removedLines, isBinary });
    }
    return files.map(file => {
        const stat = stats.get(file.path);
        return stat ? { ...file, ...stat } : file;
    });
}
