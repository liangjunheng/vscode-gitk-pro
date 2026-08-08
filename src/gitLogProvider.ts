import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// 单条提交记录
export interface GitCommit {
    hash: string;
    shortHash: string;
    parents: string[];
    author: string;
    authorEmail?: string;
    committer: string;
    committerEmail?: string;
    authorDate: string;
    authorDateLabel: string;
    message: string;
    body?: string;
    refs: string[];
    lane?: number;
    lanes?: LaneInfo[];
    laneColor?: string;
    laneStartsHere?: boolean;
}

export interface LaneInfo {
    fromLane: number;
    toLane: number;
    color: string;
    isCommit: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface GitRepositoryOption {
    path: string;
    label: string;
    description?: string;
}

export interface GitBranchOption {
    name: string;
    label: string;
    description?: string;
}

export interface CommitFile {
    path: string;
    status: FileStatus;
    oldPath?: string;
}

export type ChangeSetMode = 'commit' | 'staged' | 'changes';

export interface WorkingTreeChanges {
    staged: CommitFile[];
    changes: CommitFile[];
}

// 颜色池
const LANE_COLORS = [
    '#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b',
    '#56b6c2', '#ff7a7a', '#a6e22e', '#fd971f', '#ae81ff',
];

// VS Code Git 扩展 API 类型 (部分字段)
interface GitCommitApi {
    hash: string;
    parents: string[];
    message: string;
    author?: { name?: string; email?: string; timestamp?: number } | string;
    committer?: { name?: string; email?: string; timestamp?: number } | string;
    authorDate?: Date;
}

interface GitChangeApi {
    readonly uri: vscode.Uri;
    readonly originalUri: vscode.Uri;
    readonly renameUri?: vscode.Uri;
    readonly status: number; // Git 扩展 Status 枚举
}

interface GitRefApi {
    readonly name?: string;
    readonly type?: number; // 0=Head, 1=RemoteHead, 2=Tag
    readonly commit?: string;
}

interface GitRepository {
    rootUri: vscode.Uri;
    log(options?: { maxEntries?: number; hash?: string; reverse?: boolean; sortByAuthorDate?: boolean }): Promise<GitCommitApi[]>;
    diffBetween(ref1: string, ref2: string, path?: string): Promise<GitChangeApi[]>;
    fetch(remote?: string, ref?: string, depth?: number, prune?: boolean): Promise<void>;
    pull(rebase?: boolean, remote?: string, branch?: string): Promise<void>;
    push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: boolean): Promise<void>;
    state: {
        refs?: GitRefApi[];
    };
}

interface GitApi {
    repositories: GitRepository[];
    getRepository(uri: vscode.Uri): GitRepository | undefined;
}

function findRepository(api: GitApi, rootUri: vscode.Uri): GitRepository | undefined {
    const target = repositoryKey(rootUri.fsPath);
    return api.getRepository(rootUri)
        || api.repositories.find(repository => repositoryKey(repository.rootUri.fsPath) === target);
}

// 缓存 Git API
let cachedGitApi: GitApi | undefined;
async function getGitApi(): Promise<GitApi | undefined> {
    if (cachedGitApi) { return cachedGitApi; }
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) { return undefined; }
    await ext.activate();
    const api = ext.exports?.getAPI?.(1);
    if (api) { cachedGitApi = api as unknown as GitApi; }
    return cachedGitApi;
}

// 快速获取首个仓库路径 (从 Git API, 无 git 命令)
export async function getFirstRepoPath(): Promise<string | undefined> {
    const api = await getGitApi();
    if (api && api.repositories.length > 0) {
        return vscode.Uri.file(api.repositories[0].rootUri.fsPath).toString();
    }
    // API 未就绪, 尝试工作区文件夹
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

// ref type -> 显示名, 带前缀
function refDisplayName(ref: GitRefApi): string {
    const name = ref.name || '';
    if (ref.type === 2) { return `tag: ${name}`; } // 标签
    return name;
}

// Git 扩展 Status 枚举: INDEX_MODIFIED=0, INDEX_ADDED=1, INDEX_DELETED=2,
// INDEX_RENAMED=3, INDEX_COPIED=4, MODIFIED=5, DELETED=6, UNTRACKED=7。
function statusFromChange(s: number): FileStatus {
    switch (s) {
        case 1: case 7: case 9: case 12: case 13: case 16: return 'A';
        case 2: case 6: case 14: case 15: case 17: return 'D';
        case 3: case 10: return 'R';
        case 4: return 'C';
        case 11: return 'T';
        case 0: case 5: case 18: return 'M';
        default: return 'M';
    }
}

function repositoryKey(filePath: string): string {
    return process.platform === 'win32' ? path.normalize(filePath).toLowerCase() : path.normalize(filePath);
}

async function getInitializedSubmodulePaths(rootPath: string): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootPath,
            'config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return stdout.split('\0').flatMap(record => {
            if (!record) { return []; }
            const separator = record.indexOf('\n');
            if (separator === -1) { return []; }
            const submodulePath = record.slice(separator + 1);
            return submodulePath ? [path.resolve(rootPath, submodulePath)] : [];
        });
    } catch {
        return [];
    }
}

async function resolveRepositoryRoot(directory: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
            windowsHide: true,
        });
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

export async function getGitRepositories(onProgress?: (current: number, total: number) => void): Promise<GitRepositoryOption[]> {
    const api = await getGitApi();
    if (!api) { throw new Error('Git 扩展不可用'); }

    const repositories = new Map<string, { rootPath: string; parentPath?: string }>();
    const apiRepos = api.repositories.map(repo => ({ rootPath: repo.rootUri.fsPath }));
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const pending: { rootPath: string; parentPath?: string }[] = [...apiRepos];

    // API 仓库 (即时, 无 git 命令)
    if (onProgress) { onProgress(0, Math.max(apiRepos.length, 1)); }
    if (onProgress) { onProgress(apiRepos.length, Math.max(apiRepos.length, 1)); }

    // 解析工作区文件夹 (并行 git rev-parse, 可能与 API 仓库重复, 用 indeterminate)
    if (workspaceFolders.length > 0 && onProgress) { onProgress(0, 0); }
    const folderRoots = await Promise.all(workspaceFolders.map(folder => resolveRepositoryRoot(folder.uri.fsPath)));
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

    // 扫描子模块 (并行 git config, 嵌套子模块串行处理)
    let total = pending.length + pending.length;
    let progress = pending.length;
    if (onProgress) { onProgress(progress, total); }
    let submoduleBatch = pending.slice();
    while (submoduleBatch.length > 0) {
        const results = await Promise.all(submoduleBatch.map(async repository => ({
            repository,
            submodules: await getInitializedSubmodulePaths(repository.rootPath),
        })));
        submoduleBatch = [];
        for (const { repository, submodules } of results) {
            for (const submodulePath of submodules) {
                const rootPath = await resolveRepositoryRoot(submodulePath);
                if (!rootPath) { continue; }
                const key = repositoryKey(rootPath);
                if (repositories.has(key)) { continue; }
                const child = { rootPath, parentPath: repository.rootPath };
                repositories.set(key, child);
                pending.push(child);
                submoduleBatch.push(child);
                total++;
            }
            progress++;
            if (onProgress) { onProgress(progress, total); }
        }
    }

    return [...repositories.values()].map(repository => ({
        path: vscode.Uri.file(repository.rootPath).toString(),
        label: path.basename(repository.rootPath) || repository.rootPath,
        description: repository.parentPath ? 'subrepo' : 'repo',
    })).sort((left, right) => {
        const leftSubrepository = left.description === 'subrepo';
        const rightSubrepository = right.description === 'subrepo';
        return Number(leftSubrepository) - Number(rightSubrepository) || left.label.localeCompare(right.label);
    });
}

interface GitRefRecord {
    hash: string;
    name: string;
    label: string;
}

// refs 缓存, 避免同一次刷新中 getGitBranches 和 getGitCommits 重复调用 git for-each-ref
const refsCache = new Map<string, { refs: GitRefRecord[]; timestamp: number }>();
const REFS_CACHE_TTL = 5000;
const REFS_CACHE_MAX = 20;

async function getGitRefs(rootUri: vscode.Uri): Promise<GitRefRecord[]> {
    const key = rootUri.fsPath;
    const cached = refsCache.get(key);
    if (cached && Date.now() - cached.timestamp < REFS_CACHE_TTL) { return cached.refs; }
    const { stdout } = await execFileAsync('git', [
        '-C', rootUri.fsPath,
        'for-each-ref', '--format=%(objectname)%09%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags',
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const refs = stdout.split(/\r?\n/).flatMap(line => {
        if (!line) { return []; }
        const [hash, label, name] = line.split('\t');
        if (!hash || !label || !name || label.endsWith('/HEAD')) { return []; }
        return [{ hash, label, name }];
    });
    if (refsCache.size >= REFS_CACHE_MAX) {
        let oldestKey: string | undefined;
        let oldestTime = Infinity;
        for (const [k, v] of refsCache) {
            if (v.timestamp < oldestTime) { oldestTime = v.timestamp; oldestKey = k; }
        }
        if (oldestKey) { refsCache.delete(oldestKey); }
    }
    refsCache.set(key, { refs, timestamp: Date.now() });
    return refs;
}

// 批量解析 ref -> commit hash, 单次 git rev-parse 调用
async function resolveCommitRefs(rootUri: vscode.Uri, refs: readonly string[]): Promise<string[]> {
    if (refs.length === 0) { return []; }
    const hashPattern = /^[0-9a-f]{40}$/i;
    const parseHashes = (stdout: string) =>
        [...new Set(stdout.split('\n').map(line => line.trim()).filter(line => hashPattern.test(line)))];
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootUri.fsPath, 'rev-parse', ...refs.map(ref => `${ref}^{commit}`),
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return parseHashes(stdout);
    } catch (error: any) {
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

export async function getGitBranches(rootUri: vscode.Uri): Promise<GitBranchOption[]> {
    try {
        const refs = await getGitRefs(rootUri);
        return refs.filter(ref => !ref.name.startsWith('refs/tags/')).map(ref => ({
            name: ref.name,
            label: ref.label,
            description: ref.name.startsWith('refs/remotes/') ? '远程分支' : '本地分支',
        })).sort((left, right) => {
            const leftRemote = left.description === '远程分支';
            const rightRemote = right.description === '远程分支';
            return Number(leftRemote) - Number(rightRemote) || left.label.localeCompare(right.label);
        });
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
        return undefined;
    }
}

export async function runGitSync(rootUri: vscode.Uri, action: 'fetch' | 'pull' | 'push'): Promise<void> {
    const api = await getGitApi();
    const repo = api && findRepository(api, rootUri);
    if (!repo) { throw new Error('未找到 Git 仓库'); }
    if (action === 'fetch') { await repo.fetch(); }
    else if (action === 'pull') { await repo.pull(); }
    else { await repo.push(); }
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

// 预取全量 commit hash (仅 hash, 无格式化, 比 git log 快)
export async function getCommitHashes(rootUri: vscode.Uri, refs: readonly string[], limit: number = 10000): Promise<string[]> {
    const args = refs.length > 0 ? [...refs] : ['HEAD'];
    const { stdout } = await execFileAsync('git', [
        '-C', rootUri.fsPath, 'rev-list', '--topo-order', `--max-count=${limit}`, ...args,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean);
}

// 按指定 hash 列表获取提交 (git log --no-walk, 无遍历, O(N) N=hash数)
export async function getGitCommitsByHashes(rootUri: vscode.Uri, hashes: readonly string[], signal?: AbortSignal): Promise<GitCommit[]> {
    if (hashes.length === 0) { return []; }
    const [logResult, gitRefs] = await Promise.all([
        execFileAsync('git', [
            '-C', rootUri.fsPath, 'log', '--no-walk',
            '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1e',
            ...hashes,
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        getGitRefs(rootUri).catch(() => []),
    ]);
    const refsByCommit = buildRefsByCommit(gitRefs);
    const commits = parseLogOutput(logResult.stdout, refsByCommit);
    // --no-walk 不保证顺序, 按输入 hash 顺序排序
    const order = new Map(hashes.map((hash, index) => [hash, index]));
    return commits.sort((a, b) => (order.get(a.hash) ?? 0) - (order.get(b.hash) ?? 0));
}

// 获取仓库提交列表
export async function getGitCommits(rootUri: vscode.Uri, limit: number = 500, refs: readonly string[] = [], skip: number = 0, onProgress?: (current: number, total: number) => void): Promise<GitCommit[]> {
    const api = await getGitApi();
    if (!api || !findRepository(api, rootUri)) { throw new Error('未找到 Git 仓库'); }

    // 直接传 refs 给 git log, 跳过 resolveCommitRefs
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    if (commitRefs.length === 0) { return []; }
    if (onProgress) { onProgress(0, 1); }
    const [logResult, gitRefs] = await Promise.all([
        execFileAsync('git', [
            '-C', rootUri.fsPath, 'log', '--topo-order', `--max-count=${limit}`, ...(skip > 0 ? [`--skip=${skip}`] : []),
            '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1e', ...commitRefs,
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
        getGitRefs(rootUri).catch(() => []),
    ]);
    if (onProgress) { onProgress(1, 1); }
    const refsByCommit = buildRefsByCommit(gitRefs);
    return parseLogOutput(logResult.stdout, refsByCommit);
}

// 搜索提交: 全量获取后在 TS 端过滤, 任意关键词命中任意字段即返回
export async function searchCommits(rootUri: vscode.Uri, keywords: string[], refs: readonly string[] = []): Promise<GitCommit[]> {
    if (keywords.length === 0) { return []; }
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const [logResult, gitRefs] = await Promise.all([
        execFileAsync('git', [
            '-C', rootUri.fsPath, 'log', '--topo-order',
            '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1e', ...commitRefs,
        ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }),
        getGitRefs(rootUri).catch(() => []),
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

// 图形布局状态, 用于增量构建
export interface GraphState {
    activeLanes: Array<{ hash: string; color: string } | undefined>;
    visibleHashes: Set<string>;
    nextColor: number;
}

// 图形布局：每行完整描述顶部车道到下一行车道的转换。
// state + startIndex 支持增量构建: 只处理新追加的提交, 跳过已处理的
export function buildGraph(commits: GitCommit[], state?: GraphState, startIndex: number = 0): GitCommit[] {
    interface ActiveLane { hash: string; color: string; }
    const visibleHashes = state?.visibleHashes ?? new Set<string>();
    const firstNewIndex = Math.min(Math.max(startIndex, 0), commits.length);
    // 首次全量建立；追加分页时仅记录新提交，避免重复扫描全部历史。
    for (let i = state ? firstNewIndex : 0; i < commits.length; i++) {
        const commit = commits[i];
        visibleHashes.add(commit.hash);
        // 预留未加载页中的父提交车道，避免分页追加时父提交重新开线。
        for (const parent of commit.parents) {
            visibleHashes.add(parent);
        }
    }
    let activeLanes: Array<ActiveLane | undefined> = state ? state.activeLanes.map(l => l ? { ...l } : undefined) : [];
    let nextColor = state?.nextColor ?? 0;
    const newLane = (hash: string, preferredColor?: string): ActiveLane => ({
        hash,
        color: preferredColor || LANE_COLORS[nextColor++ % LANE_COLORS.length],
    });
    const findEmptyLane = (lanes: Array<ActiveLane | undefined>): number => lanes.findIndex(lane => !lane);

    for (let i = startIndex; i < commits.length; i++) {
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
        // Git 的八爪合并在图中以连续二叉合并表达，避免同一节点出现三叉以上的车道连接。
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
    if (state) {
        state.activeLanes = activeLanes;
        state.visibleHashes = visibleHashes;
        state.nextColor = nextColor;
    }
    return commits;
}

// 判断是否 git 仓库
export async function isGitRepo(rootUri: vscode.Uri): Promise<boolean> {
    const api = await getGitApi();
    if (!api) { return false; }
    return !!api.getRepository(rootUri);
}

// 获取指定提交的变更文件列表 (兼容 web)
// 使用 diffBetween(parent, commit) 获取 Change[] 再转换
export async function getCommitFiles(rootUri: vscode.Uri, hash: string): Promise<CommitFile[]> {
    const api = await getGitApi();
    if (!api) { throw new Error('Git 扩展不可用'); }
    const repo = api.getRepository(rootUri);
    if (!repo) { throw new Error('未找到 Git 仓库'); }

    // 使用本地 Git 读取变更列表，绕过 Git 扩展 `diffBetween` 的内部缓存异常。
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', repo.rootUri.fsPath,
            'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-C', hash,
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return parseNameStatus(stdout);
    } catch (error) {
        throw new Error(`无法读取变更文件: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function getWorkingTreeChanges(rootUri: vscode.Uri): Promise<WorkingTreeChanges> {
    try {
        const { stdout } = await execFileAsync('git', [
            '-C', rootUri.fsPath,
            'status', '--porcelain=v1', '-z', '--untracked-files=all',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
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
        return { staged, changes };
    } catch (error) {
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

function parseNameStatus(output: string): CommitFile[] {
    const files: CommitFile[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line) { continue; }
        const parts = line.split('\t');
        const status = parts[0] || '';
        const code = status[0];
        if ((code === 'R' || code === 'C') && parts.length >= 3) {
            files.push({ path: parts[2], status: code, oldPath: parts[1] });
        } else if (parts[1]) {
            const mapped: FileStatus = code === 'A' ? 'A' : code === 'D' ? 'D' : code === 'T' ? 'T' : 'M';
            files.push({ path: parts[1], status: mapped });
        }
    }
    return files;
}

// 构造 git scheme URI (用于 diff 编辑器)
// VS Code Git 扩展期望格式 (fromGitUri/toGitUri 源码):
//   git:///<原始文件路径>?{"path":"<fsPath>","ref":"<ref>"}
// 即: scheme=git, authority 为空, path 保留原文件路径, query 是 JSON.stringify(GitUriParams)
// GitUriParams = { path: fsPath, ref: string }
export function buildGitFileUri(rootUri: vscode.Uri, ref: string, filePath: string): vscode.Uri {
    // filePath 是相对 repo root 的路径, 拼接成完整文件路径
    const fullUri = vscode.Uri.joinPath(rootUri, filePath);
    // GitUriParams: path 用 fsPath (完整文件系统路径), ref 是 git 引用
    const params = JSON.stringify({ path: fullUri.fsPath, ref: ref });
    // 用 with() 改 scheme 和 query, 保留 path
    return fullUri.with({
        scheme: 'git',
        query: params,
    });
}

// Git 扩展 Repository 接口扩展 (内部方法, 非公开 API 但可调用)
// 注意: getCommitDiffText 已移至 src/diffContentProvider.ts
