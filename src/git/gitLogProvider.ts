import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
// 类型定义统一从 types/ 导入, 消除重复
export type { ChangeSetMode, CommitFile, FileStatus, GitBranchOption, GitCommit, GitRepositoryOption, GitRepositoryState, LaneInfo, WorkingTreeChanges } from '../types';
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
    // BFS: 通过 git rev-parse 递归解析已初始化子模块。
    let currentLevel = initialRepositories.slice();
    while (currentLevel.length > 0) {
        const levelResults = await Promise.all(currentLevel.map(async repo => {
            const submodulePaths = await getInitializedSubmodulePaths(repo.rootPath, signal);
            const roots = await Promise.all(submodulePaths.map(submodulePath => resolveRepositoryRoot(submodulePath, signal)));
            return { repo, roots };
        }));
        throwIfAborted(signal);
        currentLevel = [];
        for (const { repo, roots } of levelResults) {
            for (const rootPath of roots) {
                if (!rootPath || repositories.has(repositoryKey(rootPath))) { continue; }
                const child = { rootPath, parentPath: repo.rootPath };
                repositories.set(repositoryKey(rootPath), child);
                batch.push(child);
                currentLevel.push(child);
                onDiscovered?.(batch.length - initialRepositories.length);
            }
        }
    }
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

// 仓库列表缓存与单飞扫描, 避免首次重入时重复扫描子模块
let repositoriesCache: { repos: GitRepositoryOption[]; sourceKeys: string; timestamp: number } | null = null;
let repositoriesInFlight: Promise<GitRepositoryOption[]> | undefined;
const REPOSITORIES_CACHE_TTL = 10000;

function getWorkspaceSourceKeys(): string {
    return (vscode.workspace.workspaceFolders ?? [])
        .map(folder => repositoryKey(folder.uri.fsPath))
        .sort()
        .join('\0');
}

export function invalidateGitRepositoriesCache(): void {
    repositoriesCache = null;
}

export function invalidateGitRefsCache(rootUri?: vscode.Uri): void {
    if (rootUri) {
        const key = rootUri.fsPath;
        refsCache.delete(key);
        refsCacheVersions.set(key, (refsCacheVersions.get(key) ?? 0) + 1);
    } else {
        for (const key of new Set([...refsCache.keys(), ...refsInFlight.keys(), ...refsCacheVersions.keys()])) {
            refsCacheVersions.set(key, (refsCacheVersions.get(key) ?? 0) + 1);
        }
        refsCache.clear();
    }
}

export async function getGitRepositories(onProgress?: (current: number, total: number, message?: string) => void, signal?: AbortSignal): Promise<GitRepositoryOption[]> {
    throwIfAborted(signal);
    const sourceKeys = getWorkspaceSourceKeys();
    if (repositoriesCache
        && repositoriesCache.sourceKeys === sourceKeys
        && Date.now() - repositoriesCache.timestamp < REPOSITORIES_CACHE_TTL) {
        return repositoriesCache.repos;
    }
    if (!signal && repositoriesInFlight) {
        onProgress?.(0, 0, '正在等待子模块扫描完成...');
        return repositoriesInFlight;
    }
    const scan = getGitRepositoriesInternal(sourceKeys, onProgress, signal);
    if (signal) { return scan; }
    repositoriesInFlight = scan;
    try {
        const repositories = await scan;
        repositoriesCache = { repos: repositories, sourceKeys, timestamp: Date.now() };
        return repositories;
    } finally {
        if (repositoriesInFlight === scan) { repositoriesInFlight = undefined; }
    }
}

async function getGitRepositoriesInternal(sourceKeys: string, onProgress?: (current: number, total: number, message?: string) => void, signal?: AbortSignal): Promise<GitRepositoryOption[]> {
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

    // 计算哪些仓库包含子模块 (有子模块的仓库用不同图标)
    const parentPaths = new Set<string>();
    for (const repository of allRepositories) {
        if (repository.parentPath) {
            parentPaths.add(repositoryKey(repository.parentPath));
        }
    }

    const result = [...repositories.values()].map(repository => ({
        path: vscode.Uri.file(repository.rootPath).toString(),
        label: path.basename(repository.rootPath) || repository.rootPath,
        description: repository.parentPath ? 'subrepo' : 'repo',
        hasSubmodules: parentPaths.has(repositoryKey(repository.rootPath)),
    })).sort((left, right) => {
        const leftSubrepository = left.description === 'subrepo';
        const rightSubrepository = right.description === 'subrepo';
        return Number(leftSubrepository) - Number(rightSubrepository) || left.label.localeCompare(right.label);
    });
    return result;
}

interface GitRefRecord {
    hash: string;
    name: string;
    label: string;
}

// refs 缓存与单飞请求，避免分支、提交和预取并发重复扫描全部 refs。
const refsCache = new Map<string, { refs: GitRefRecord[]; timestamp: number }>();
const refsInFlight = new Map<string, Promise<GitRefRecord[]>>();
const refsCacheVersions = new Map<string, number>();
const REFS_CACHE_TTL = 5000;
const REFS_CACHE_MAX = 20;

async function getGitRefs(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRefRecord[]> {
    const key = rootUri.fsPath;
    const cached = refsCache.get(key);
    if (cached && Date.now() - cached.timestamp < REFS_CACHE_TTL) { return cached.refs; }
    if (!signal) {
        const inFlight = refsInFlight.get(key);
        if (inFlight) { return inFlight; }
    }
    const requestVersion = refsCacheVersions.get(key) ?? 0;
    const request = (async () => {
        const refs = await readRefsFromCli(rootUri, signal);
        if (refsCache.size >= REFS_CACHE_MAX) {
            let oldestKey: string | undefined;
            let oldestTime = Infinity;
            for (const [cacheKey, value] of refsCache) {
                if (value.timestamp < oldestTime) { oldestTime = value.timestamp; oldestKey = cacheKey; }
            }
            if (oldestKey) { refsCache.delete(oldestKey); }
        }
        if ((refsCacheVersions.get(key) ?? 0) === requestVersion) {
            refsCache.set(key, { refs, timestamp: Date.now() });
        }
        return refs;
    })();
    if (signal) { return request; }
    refsInFlight.set(key, request);
    try {
        return await request;
    } finally {
        if (refsInFlight.get(key) === request) { refsInFlight.delete(key); }
    }
}

// 从 git CLI 读 refs
async function readRefsFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRefRecord[]> {
    const { stdout } = await execFileAsync('git', [
        '-C', rootUri.fsPath,
        'for-each-ref', '--format=%(objectname)%09%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags',
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
    return stdout.split(/\r?\n/).flatMap(line => {
        if (!line) { return []; }
        const [hash, label, name] = line.split('\t');
        if (!hash || !label || !name || label.endsWith('/HEAD')) { return []; }
        return [{ hash, label, name }];
    });
}

// 批量解析 ref -> commit hash, 单次 git rev-parse 调用
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

export async function getGitBranches(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitBranchOption[]> {
    try {
        const [refs, currentBranch, currentHash] = await Promise.all([
            getGitRefs(rootUri, signal),
            getCurrentGitBranch(rootUri),
            getCurrentGitHeadHash(rootUri, signal),
        ]);
        const branchRefs = refs.filter(ref => !ref.name.startsWith('refs/tags/'));
        const currentRef = currentBranch ? branchRefs.find(ref => ref.name === currentBranch) : undefined;
        const current = currentHash ? [{
            name: currentBranch ?? currentHash,
            label: currentRef?.label ?? `HEAD (${currentHash.slice(0, 8)})`,
            hash: currentHash,
            kind: 'current' as const,
        }] : [];
        const branches = branchRefs.map(ref => ({
            name: ref.name,
            label: ref.label,
            hash: ref.hash,
            kind: ref.name.startsWith('refs/remotes/') ? 'remote' as const : 'local' as const,
        })).sort((left, right) => Number(left.kind === 'remote') - Number(right.kind === 'remote') || left.label.localeCompare(right.label));
        return [...current, ...branches];
    } catch (error) {
        throw new Error(`无法读取分支: ${error instanceof Error ? error.message : String(error)}`);
    }
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

export async function runGitSync(rootUri: vscode.Uri, action: 'fetch' | 'pull' | 'push'): Promise<void> {
    if (action === 'fetch') {
        await runGitCommand(rootUri, ['fetch', '--all', '--prune', '--recurse-submodules=on-demand']);
    } else if (action === 'pull') {
        await runGitCommand(rootUri, ['pull', '--recurse-submodules']);
        await runGitCommand(rootUri, ['submodule', 'update', '--init', '--recursive']);
    } else {
        await runGitCommand(rootUri, ['push']);
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
function parseLogOutput(stdout: string, refsByCommit: Map<string, string[]>): GitCommit[] {
    return stdout.split('\x1e').flatMap(record => {
        const [hash, parentText, author, authorEmail, committer, committerEmail, dateText, subject, body] = record.trim().split('\x1f');
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
            refs: refsByCommit.get(hash) || [],
        }];
    });
}

function buildRefsByCommit(gitRefs: GitRefRecord[]): Map<string, string[]> {
    const refsByCommit = new Map<string, string[]>();
    for (const ref of gitRefs) {
        const name = ref.name.startsWith('refs/tags/') ? `tag: ${ref.label}` : ref.label;
        const names = refsByCommit.get(ref.hash) || [];
        names.push(name);
        refsByCommit.set(ref.hash, names);
    }
    return refsByCommit;
}

async function readCommitsFromCli(rootUri: vscode.Uri, limit: number, refs: readonly string[], skip: number, signal?: AbortSignal): Promise<GitCommit[]> {
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const [logResult, gitRefs] = await Promise.all([
        execFileAsync('git', [
            '-C', rootUri.fsPath, 'log', '--topo-order', `--max-count=${limit}`, ...(skip > 0 ? [`--skip=${skip}`] : []),
            '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1e', ...commitRefs,
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        getGitRefs(rootUri, signal).catch(error => {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
            return [];
        }),
    ]);
    return parseLogOutput(logResult.stdout, buildRefsByCommit(gitRefs));
}

// 获取仓库提交列表
export async function getGitCommits(rootUri: vscode.Uri, limit: number = 500, refs: readonly string[] = [], skip: number = 0, onProgress?: (current: number, total: number) => void, signal?: AbortSignal): Promise<GitCommit[]> {
    if (onProgress) { onProgress(0, 1); }
    const commits = await readCommitsFromCli(rootUri, limit, refs, skip, signal);
    if (onProgress) { onProgress(1, 1); }
    return commits;
}

// 搜索提交: 全量获取后在 TS 端过滤, 任意关键词命中任意字段即返回
export async function searchCommits(rootUri: vscode.Uri, keywords: string[], refs: readonly string[] = [], signal?: AbortSignal): Promise<GitCommit[]> {
    if (keywords.length === 0) { return []; }
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const [logResult, gitRefs] = await Promise.all([
        execFileAsync('git', [
            '-C', rootUri.fsPath, 'log', '--topo-order',
            '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1e', ...commitRefs,
        ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, signal }),
        getGitRefs(rootUri, signal).catch(error => {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
            return [];
        }),
    ]);
    const refsByCommit = buildRefsByCommit(gitRefs);
    const allCommits = parseLogOutput(logResult.stdout, refsByCommit);
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

// 图形布局：每行完整描述顶部车道到下一行车道的转换。
export function buildGraph(commits: GitCommit[]): GitCommit[] {
    interface ActiveLane { hash: string; color: string; }
    const visibleHashes = new Set<string>();
    for (let i = 0; i < commits.length; i++) {
        const commit = commits[i];
        visibleHashes.add(commit.hash);
        for (const parent of commit.parents) {
            visibleHashes.add(parent);
        }
    }
    let activeLanes: Array<ActiveLane | undefined> = [];
    let nextColor = 0;
    const newLane = (hash: string, preferredColor?: string): ActiveLane => ({
        hash,
        color: preferredColor || LANE_COLORS[nextColor++ % LANE_COLORS.length],
    });
    const findEmptyLane = (lanes: Array<ActiveLane | undefined>): number => lanes.findIndex(lane => !lane);

    for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        let myLane = activeLanes.findIndex(lane => lane?.hash === c.hash);
        const laneStartsHere = myLane < 0;
        if (myLane < 0) {
            myLane = findEmptyLane(activeLanes);
            if (myLane < 0) { myLane = activeLanes.length; }
            activeLanes[myLane] = newLane(c.hash);
        }
        const lanesAtTop = activeLanes.slice();
        const commitLane = lanesAtTop[myLane]!;
        const visibleParents = c.parents.filter(parent => visibleHashes.has(parent));
        const binaryParents = visibleParents.slice(0, 2);
        const nextLanes = lanesAtTop.slice();
        nextLanes[myLane] = undefined;
        const parentTargets: Array<{ hash: string; lane: number; color: string }> = [];

        for (let index = 0; index < binaryParents.length; index++) {
            const parent = binaryParents[index];
            let targetLane = nextLanes.findIndex(lane => lane?.hash === parent);
            if (targetLane < 0) {
                targetLane = index === 0 ? myLane : findEmptyLane(nextLanes);
                if (targetLane < 0) { targetLane = nextLanes.length; }
                nextLanes[targetLane] = newLane(parent, index === 0 ? commitLane.color : undefined);
            }
            parentTargets.push({ hash: parent, lane: targetLane, color: nextLanes[targetLane]!.color });
        }

        c.lane = myLane;
        c.laneColor = commitLane.color;
        c.laneStartsHere = laneStartsHere;
        c.lanes = parentTargets.map(target => ({
            fromLane: myLane,
            toLane: target.lane,
            color: target.color,
            isCommit: false,
        }));
        for (let lane = 0; lane < lanesAtTop.length; lane++) {
            const topLane = lanesAtTop[lane];
            if (!topLane || lane === myLane) { continue; }
            const targetLane = nextLanes.findIndex(candidate => candidate?.hash === topLane.hash);
            if (targetLane >= 0) {
                c.lanes.push({ fromLane: lane, toLane: targetLane, color: topLane.color, isCommit: false });
            }
        }
        activeLanes = nextLanes;
        while (activeLanes.length > 0 && !activeLanes[activeLanes.length - 1]) { activeLanes.pop(); }
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
