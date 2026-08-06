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
    authorDate: string;
    authorDateLabel: string;
    message: string;
    body?: string;
    refs: string[];
    lane?: number;
    lanes?: LaneInfo[];
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

export async function getGitRepositories(): Promise<GitRepositoryOption[]> {
    const api = await getGitApi();
    if (!api) { throw new Error('Git 扩展不可用'); }

    const repositories = new Map<string, { rootPath: string; parentPath?: string }>();
    const pending = api.repositories.map(repo => ({ rootPath: repo.rootUri.fsPath }));
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const rootPath = await resolveRepositoryRoot(folder.uri.fsPath);
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

    for (let index = 0; index < pending.length; index++) {
        const repository = pending[index];
        for (const submodulePath of await getInitializedSubmodulePaths(repository.rootPath)) {
            const rootPath = await resolveRepositoryRoot(submodulePath);
            if (!rootPath) { continue; }
            const key = repositoryKey(rootPath);
            if (repositories.has(key)) { continue; }
            const child = { rootPath, parentPath: repository.rootPath };
            repositories.set(key, child);
            pending.push(child);
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

async function getGitRefs(rootUri: vscode.Uri): Promise<GitRefRecord[]> {
    const { stdout } = await execFileAsync('git', [
        '-C', rootUri.fsPath,
        'for-each-ref', '--format=%(objectname)%09%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags',
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split(/\r?\n/).flatMap(line => {
        if (!line) { return []; }
        const [hash, label, name] = line.split('\t');
        if (!hash || !label || !name || label.endsWith('/HEAD')) { return []; }
        return [{ hash, label, name }];
    });
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

// 获取仓库提交列表 (兼容 web)
export async function getGitCommits(rootUri: vscode.Uri, limit: number = 500, refs: readonly string[] = []): Promise<GitCommit[]> {
    const api = await getGitApi();
    if (!api) { throw new Error('Git 扩展不可用'); }
    const repo = findRepository(api, rootUri);
    if (!repo) { throw new Error('未找到 Git 仓库'); }

    const logRequests = refs.length > 0
        ? refs.map(ref => repo.log({ maxEntries: limit, hash: ref }))
        : [repo.log({ maxEntries: limit })];
    const [logGroups, gitRefs] = await Promise.all([
        Promise.all(logRequests),
        getGitRefs(rootUri).catch(() => []),
    ]);
    const seenHashes = new Set<string>();
    const logEntries = logGroups.flat().filter(entry => {
        if (seenHashes.has(entry.hash)) { return false; }
        seenHashes.add(entry.hash);
        return true;
    });
    const refsByCommit = new Map<string, string[]>();
    for (const ref of gitRefs) {
        const name = ref.name.startsWith('refs/tags/') ? `tag: ${ref.label}` : ref.label;
        const names = refsByCommit.get(ref.hash);
        if (names) {
            names.push(name);
        } else {
            refsByCommit.set(ref.hash, [name]);
        }
    }

    const commits: GitCommit[] = logEntries.map(entry => {
        const matchedRefs = refsByCommit.get(entry.hash) || [];
        const authorObject = typeof entry.author === 'object' ? entry.author : undefined;
        const committerObject = typeof entry.committer === 'object' ? entry.committer : undefined;
        const authorName = authorObject?.name || (typeof entry.author === 'string' ? entry.author : '') || committerObject?.name || (typeof entry.committer === 'string' ? entry.committer : '');
        const authorEmail = authorObject?.email || committerObject?.email || '';
        const authorTimestamp = authorObject?.timestamp || committerObject?.timestamp;
        const authorDate = entry.authorDate || (authorTimestamp ? new Date(authorTimestamp * 1000) : undefined);
        const dateIso = authorDate instanceof Date && !isNaN(authorDate.getTime()) ? authorDate.toISOString() : '';
        return {
            hash: entry.hash,
            shortHash: entry.hash.slice(0, 8),
            parents: (entry.parents || []).map(p => p.slice(0, 8)),
            author: authorName || authorEmail || 'Unknown author',
            authorEmail,
            authorDate: dateIso,
            authorDateLabel: formatDateLabel(authorDate),
            message: (entry.message || '').split('\n')[0],
            body: (entry.message || '').split('\n').slice(1).join('\n'),
            refs: matchedRefs,
        };
    });
    return commits;
}

// 图形布局
export function buildGraph(commits: GitCommit[]): GitCommit[] {
    let activeLanes: string[] = [];
    const colorMap = new Map<string, number>();
    let nextColor = 0;

    for (const c of commits) {
        let myLane = activeLanes.indexOf(c.shortHash);
        if (myLane === -1) {
            myLane = activeLanes.indexOf('');
            if (myLane === -1) {
                myLane = activeLanes.length;
                activeLanes.push(c.shortHash);
            } else {
                activeLanes[myLane] = c.shortHash;
            }
        }
        if (!colorMap.has(c.shortHash)) { colorMap.set(c.shortHash, nextColor++); }
        const myColor = LANE_COLORS[colorMap.get(c.shortHash)! % LANE_COLORS.length];
        c.lane = myLane;
        c.lanes = [{ fromLane: myLane, toLane: myLane, color: myColor, isCommit: true }];

        const parents = c.parents;
        if (parents.length > 0) {
            activeLanes[myLane] = parents[0];
            if (!colorMap.has(parents[0])) { colorMap.set(parents[0], colorMap.get(c.shortHash)!); }
            c.lanes.push({ fromLane: myLane, toLane: myLane, color: myColor, isCommit: false });
            for (let i = 1; i < parents.length; i++) {
                let newLane = activeLanes.indexOf('');
                if (newLane === -1) {
                    newLane = activeLanes.length;
                    activeLanes.push(parents[i]);
                } else {
                    activeLanes[newLane] = parents[i];
                }
                if (!colorMap.has(parents[i])) { colorMap.set(parents[i], nextColor++); }
                const pColor = LANE_COLORS[colorMap.get(parents[i])! % LANE_COLORS.length];
                c.lanes.push({ fromLane: newLane, toLane: myLane, color: pColor, isCommit: false });
            }
        } else {
            activeLanes[myLane] = '';
        }
        while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === '') { activeLanes.pop(); }
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
