import * as vscode from 'vscode';
import * as path from 'path';
import { invokeNativeGit } from './nativeGitBinding';
import { fetchRemotes, pull as pullNative, push as pushNative, updateSubmodules as updateSubmodulesNative, type NativePushResult } from './gitNativeOperations';
// 类型定义统一从 types/ 导入, 消除重复
export type { ChangeSetMode, FileStatus, GitBranchOption, GitRepositoryOption, GitRepositoryState, WorkingTreeChanges } from '../types';
export { CommitFile, CommitMetadata } from '../types';
import { CommitFile, CommitMetadata, GitBranchOption, GitRepositoryOption, GitRepositoryState, WorkingTreeChanges, type FileStatus } from '../types';


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

interface NativeCommitMetadata {
    hash: string;
    shortHash: string;
    parents: string[];
    author: string;
    authorEmail?: string;
    committer: string;
    committerEmail?: string;
    authorDate: string;
    message: string;
    body?: string;
    rawMessage?: string;
    refs: string[];
}

function fromNativeCommit(commit: NativeCommitMetadata): CommitMetadata {
    return new CommitMetadata({
        ...commit,
        authorDateLabel: formatDateLabel(commit.authorDate),
    });
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

async function getInitializedSubmodulePaths(rootPath: string, signal?: AbortSignal): Promise<string[]> {
    throwIfAborted(signal);
    const modules = await invokeNativeGit<Array<{ absolutePath: string }>>('submodules', { rootPath });
    throwIfAborted(signal);
    return modules.map(module => path.normalize(module.absolutePath));
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
    throwIfAborted(signal);
    try {
        const repository = await invokeNativeGit<{ workdir: string }>('discover', { path: directory });
        throwIfAborted(signal);
        return path.normalize(repository.workdir);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') { throw error; }
        return undefined;
    }
}

interface GitRefRecord {
    hash: string;
    name: string;
    label: string;
    upstreamName?: string;
}

// 分支缓存与单飞请求；分支变更沿用 invalidateGitRefsCache 主动失效。// 批量解析 ref -> commit hash, 单次 git rev-parse 调用
async function resolveCommitRefs(rootUri: vscode.Uri, refs: readonly string[], signal?: AbortSignal): Promise<string[]> {
    if (refs.length === 0) { return []; }
    throwIfAborted(signal);
    const hashes = await invokeNativeGit<string[]>('resolveRevision', {
        rootPath: rootUri.fsPath,
        specs: refs.map(ref => `${ref}^{commit}`),
    });
    throwIfAborted(signal);
    return [...new Set(hashes)];
}


interface CommitAuthorDetails {
    name: string;
    email: string;
    date: string;
}

async function getCommitAuthorDetails(rootUri: vscode.Uri, hashes: readonly string[]): Promise<Map<string, CommitAuthorDetails>> {
    if (hashes.length === 0) { return new Map(); }
    const commits = await invokeNativeGit<Array<{ hash: string; author: string; authorEmail: string; authorDate: string }>>('commitDetails', {
        rootPath: rootUri.fsPath,
        hashes,
    });
    return new Map(commits.map(commit => [commit.hash, {
        name: commit.author,
        email: commit.authorEmail,
        date: commit.authorDate,
    }]));
}

async function readBranchRefsFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<{ currentBranch?: string; detachedHead?: string; local: GitRefRecord[]; remote: GitRefRecord[] }> {
    throwIfAborted(signal);
    const result = await invokeNativeGit<{ currentBranch?: string; detachedHead?: string; local: GitRefRecord[]; remote: GitRefRecord[] }>('branches', {
        rootPath: rootUri.fsPath,
    });
    throwIfAborted(signal);
    return result;
}

// detached HEAD 的当前项：以裸 hash 作为 ref 名，git log 可直接接受。
export function buildDetachedHeadBranch(rootUri: vscode.Uri, headHash: string, repository?: GitRepositoryOption): GitBranchOption {
    return new GitBranchOption({
        repoOption: repository ?? new GitRepositoryOption({ path: rootUri.toString(), label: rootUri.fsPath }),
        name: headHash,
        label: headHash.slice(0, 8),
        hash: headHash,
        kind: 'current',
    });
}

export interface PushBranchOption {
    name: string;
    upstreamName: string;
    upstreamRemote: string;
    upstreamBranch: string;
    isCurrent: boolean;
    recentUnpushedCommits: readonly { subject: string; timestamp: number }[];
}

/**
 * 读取 Push 分支选择器所需的最小数据集：分支 upstream 与最近未推送提交。
 * 工作区状态由 UncommittedFilesWatcher 独占维护, 这里不再重复执行 git status。
 * 不按分支循环执行 Git 命令，始终只进行两次只读查询。
 */
export async function getPushBranches(rootUri: vscode.Uri, commitLimit = 8): Promise<PushBranchOption[]> {
    return invokeNativeGit<PushBranchOption[]>('pushBranches', {
        rootPath: rootUri.fsPath,
        limit: commitLimit,
    });
}

export async function getGitBranches(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitBranchOption[]> {
    throwIfAborted(signal);
    try {
        const { currentBranch, detachedHead, local, remote } = await readBranchRefsFromCli(rootUri, signal);
        const branchRefs = [...local, ...remote];
        const currentRef = currentBranch ? local.find(ref => ref.name === currentBranch) : undefined;
        const repository = new GitRepositoryOption({ path: rootUri.toString(), label: rootUri.fsPath });
        const current = currentRef ? [new GitBranchOption({
            repoOption: repository,
            name: currentRef.name,
            label: currentRef.label,
            hash: currentRef.hash,
            kind: 'current',
            upstreamName: currentRef.upstreamName,
        })] : detachedHead ? [buildDetachedHeadBranch(rootUri, detachedHead)] : [];
        const branches = branchRefs.map(ref => new GitBranchOption({
            repoOption: repository,
            name: ref.name,
            label: ref.label,
            hash: ref.hash,
            kind: ref.name.startsWith('refs/remotes/') ? 'remote' : 'local',
            upstreamName: ref.upstreamName,
        })).sort((left, right) => Number(left.kind === 'remote') - Number(right.kind === 'remote') || left.label.localeCompare(right.label));
        return [...current, ...branches];
    } catch (error) {
        throw new Error(`无法读取分支: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function getCurrentGitBranch(rootUri: vscode.Uri, signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal);
    try {
        const head = await invokeNativeGit<{ branch?: string } | null>('head', { rootPath: rootUri.fsPath });
        throwIfAborted(signal);
        return head?.branch;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') { throw error; }
        return undefined;
    }
}

export async function getCurrentGitHeadHash(rootUri: vscode.Uri, signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal);
    try {
        const head = await invokeNativeGit<{ hash?: string } | null>('head', { rootPath: rootUri.fsPath });
        throwIfAborted(signal);
        return head?.hash;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') { throw error; }
        return undefined;
    }
}

export interface GitSyncResult {
    headChanged: boolean;
    submodulesNeedUpdate: boolean;
    pushResult?: NativePushResult;
    submoduleTopologyChanged: boolean;
    submodulePaths: readonly string[];
}

interface GitlinkChange {
    status: string;
    path: string;
}

async function getGitlinkChanges(rootUri: vscode.Uri, beforeHead: string, afterHead: string): Promise<GitlinkChange[]> {
    return invokeNativeGit<GitlinkChange[]>('gitlinkChanges', {
        rootPath: rootUri.fsPath,
        before: beforeHead,
        after: afterHead,
    });
}

export async function runGitSync(
    rootUri: vscode.Uri,
    action: 'fetch' | 'pull' | 'push',
    onProgress?: (message: string) => void,
): Promise<GitSyncResult> {
    if (action === 'fetch') {
        onProgress?.('正在通过 libgit2 获取所有远程仓库，并清理过期引用...');
        await fetchRemotes(rootUri);
        const repositories = await collectSubmoduleRepositories([{ rootPath: rootUri.fsPath }]);
        const submodules = repositories.slice(1);
        for (let index = 0; index < submodules.length; index++) {
            const submodule = submodules[index];
            onProgress?.(`正在获取 Submodule 模块（${index + 1}/${submodules.length}）：${submodule.rootPath}`);
            await fetchRemotes(vscode.Uri.file(submodule.rootPath));
        }
        return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false, submodulePaths: [] };
    }
    if (action === 'pull') {
        const beforeHead = await getCurrentGitHeadHash(rootUri);
        onProgress?.('正在通过 libgit2 拉取远程代码...');
        await pullNative(rootUri);
        const afterHead = await getCurrentGitHeadHash(rootUri);
        if (!beforeHead || !afterHead || beforeHead === afterHead) {
            return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false, submodulePaths: [] };
        }
        const gitlinkChanges = await getGitlinkChanges(rootUri, beforeHead, afterHead);
        const submodulePaths = gitlinkChanges.filter(change => change.status !== 'D').map(change => change.path);
        return {
            headChanged: true,
            submodulesNeedUpdate: submodulePaths.length > 0,
            submoduleTopologyChanged: gitlinkChanges.some(change => change.status === 'A' || change.status === 'D'),
            submodulePaths,
        };
    }
    onProgress?.('正在通过 libgit2 推送本地提交...');
    const pushResult = await pushNative(rootUri);
    return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false, submodulePaths: [], pushResult };
}

export async function updateGitSubmodules(
    rootUri: vscode.Uri,
    submodulePaths: readonly string[],
    onProgress?: (message: string) => void,
): Promise<void> {
    onProgress?.(`正在通过 libgit2 初始化并更新 ${submodulePaths.length} 个 Submodule 模块...`);
    await updateSubmodulesNative(rootUri, submodulePaths);
}
export interface CommitHistoryMessage {
    readonly shortHash: string;
    readonly subject: string;
    readonly message: string;
}

export async function readCurrentCommitMessage(rootUri: vscode.Uri): Promise<string> {
    const commits = await invokeNativeGit<NativeCommitMetadata[]>('commits', {
        rootPath: rootUri.fsPath,
        refs: [],
        limit: 1,
        skip: 0,
    });
    return (commits[0]?.rawMessage ?? '').replace(/\s+$/, '');
}

export async function readCommitHistoryMessages(rootUri: vscode.Uri): Promise<CommitHistoryMessage[]> {
    const commits = await invokeNativeGit<NativeCommitMetadata[]>('commits', {
        rootPath: rootUri.fsPath,
        refs: [],
        all: true,
        limit: 50,
        skip: 0,
    });
    return commits.map(commit => ({
        shortHash: commit.shortHash,
        subject: commit.message,
        message: (commit.rawMessage ?? '').replace(/\s+$/, ''),
    }));
}

export async function getGitAheadCount(rootUri: vscode.Uri): Promise<number> {
    try {
        const result = await invokeNativeGit<{ ahead: number }>('aheadBehind', { rootPath: rootUri.fsPath });
        return result.ahead;
    } catch {
        return 0;
    }
}

async function readCommitsFromNative(rootUri: vscode.Uri, limit: number, refs: readonly string[], skip: number, signal?: AbortSignal): Promise<CommitMetadata[]> {
    throwIfAborted(signal);
    const commits = await invokeNativeGit<NativeCommitMetadata[]>('commits', {
        rootPath: rootUri.fsPath,
        refs,
        limit,
        skip,
    });
    throwIfAborted(signal);
    return commits.map(fromNativeCommit);
}

export async function getGitCommits(rootUri: vscode.Uri, limit: number = 500, refs: readonly string[] = [], skip: number = 0, onProgress?: (current: number, total: number) => void, signal?: AbortSignal): Promise<CommitMetadata[]> {
    throwIfAborted(signal);
    onProgress?.(0, 1);
    const commits = await readCommitsFromNative(rootUri, limit, refs, skip, signal);
    onProgress?.(1, 1);
    return commits;
}

// 搜索提交: 全量获取后在 TS 端过滤, 任意关键词命中任意字段即返回
export async function searchCommits(rootUri: vscode.Uri, keywords: string[], refs: readonly string[] = [], signal?: AbortSignal): Promise<CommitMetadata[]> {
    if (keywords.length === 0) { return []; }
    throwIfAborted(signal);
    const commits = (await invokeNativeGit<NativeCommitMetadata[]>('commits', {
        rootPath: rootUri.fsPath,
        refs,
        skip: 0,
    })).map(fromNativeCommit);
    throwIfAborted(signal);
    const lowerKeywords = keywords.map(keyword => keyword.toLowerCase());
    return commits.filter(commit => {
        const fields = [
            commit.hash, commit.shortHash, commit.parents.join(' '), commit.author, commit.authorEmail,
            commit.committer, commit.committerEmail, commit.authorDate, commit.authorDateLabel,
            commit.message, commit.body, commit.refs.join(' '),
        ].map(field => (field || '').toLowerCase());
        return lowerKeywords.some(keyword => fields.some(field => field.includes(keyword)));
    });
}

// 判断是否 git 仓库
export async function isGitRepo(rootUri: vscode.Uri): Promise<boolean> {
    return !!await resolveRepositoryRoot(rootUri.fsPath);
}

// 通过 git 命令获取指定提交的变更文件列表 (仅 --raw 清单, 不含行数统计)
export async function getCommitFiles(rootUri: vscode.Uri, hash: string, signal?: AbortSignal, onProgress?: (current: number, total: number) => void): Promise<CommitFile[]> {
    throwIfAborted(signal);
    onProgress?.(0, 0);
    const files = await invokeNativeGit<Array<Partial<CommitFile>>>('commitFiles', {
        rootPath: rootUri.fsPath,
        revision: hash,
    });
    throwIfAborted(signal);
    const result = files.map(file => new CommitFile(file));
    onProgress?.(result.length, result.length);
    return result;
}

/** 读取当前提交树中实际包含的 gitlink 路径。 */
export async function getGitlinkPathsInCommit(rootUri: vscode.Uri, hash: string): Promise<string[]> {
    return invokeNativeGit<string[]>('gitlinkPaths', { rootPath: rootUri.fsPath, revision: hash });
}

export async function getGitRepositoryState(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    throwIfAborted(signal);
    const state = await invokeNativeGit<Partial<GitRepositoryState>>('repositoryState', { rootPath: rootUri.fsPath });
    throwIfAborted(signal);
    return new GitRepositoryState(state);
}

export async function getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
    return readWorkingTreeStatus(rootUri, [], signal);
}

/**
 * 徽标专用：只判断仓库是否存在未提交变更。
 * 用 --untracked-files=normal 避免递归展开未跟踪目录(node_modules 等), 且不读取
 * --raw 元数据; 完整清单由 getWorkingTreeStatus 异步补齐, 二者互不阻塞。
 */
export async function hasWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const result = await invokeNativeGit<boolean>('hasChanges', { rootPath: rootUri.fsPath });
    throwIfAborted(signal);
    return result;
}

export async function getWorkingTreeStatusForPaths(
    rootUri: vscode.Uri,
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
    return readWorkingTreeStatus(rootUri, paths, signal);
}

export async function getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>> {
    throwIfAborted(signal);
    const paths = await invokeNativeGit<string[]>('indexChangedPaths', { rootPath: rootUri.fsPath });
    throwIfAborted(signal);
    return new Set(paths);
}

async function readWorkingTreeStatus(
    rootUri: vscode.Uri,
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
    throwIfAborted(signal);
    const changes = await invokeNativeGit<{ staged: Array<Partial<CommitFile>>; changes: Array<Partial<CommitFile>> }>('status', {
        rootPath: rootUri.fsPath,
        paths,
        recurseUntrackedDirs: true,
    });
    throwIfAborted(signal);
    return new WorkingTreeChanges({
        staged: changes.staged.map(file => new CommitFile(file)),
        changes: changes.changes.map(file => new CommitFile(file)),
    });
}

// porcelain v2 的普通/重命名记录直接携带 Diff 所需元数据。
function parseWorkingTreeStatusV2(stdout: string): WorkingTreeChanges {
    const staged: CommitFile[] = [];
    const changes: CommitFile[] = [];
    const entries = stdout.split('\0');
    const zeroObjectId = (objectId: string) => '0'.repeat(objectId.length || 40);
    const isGitlink = (submodule: string, ...modes: string[]) => submodule.startsWith('S') || modes.includes('160000');

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) { continue; }
        const fields = entry.split(' ');
        const recordType = fields[0];
        if (recordType === '?') {
            changes.push(new CommitFile({
                path: fields.slice(1).join(' '),
                status: 'A',
                isUntracked: true,
            }));
            continue;
        }
        if (recordType === '1' || recordType === '2') {
            const minimumFields = recordType === '2' ? 10 : 9;
            if (fields.length < minimumFields) { continue; }
            const xy = fields[1];
            const submodule = fields[2];
            const headMode = fields[3];
            const indexMode = fields[4];
            const worktreeMode = fields[5];
            const headObjectId = fields[6];
            const indexObjectId = fields[7];
            const pathStart = recordType === '2' ? 9 : 8;
            const filePath = fields.slice(pathStart).join(' ');
            const renameSourcePath = recordType === '2' ? entries[++index] || undefined : undefined;
            const indexStatus = xy[0];
            const worktreeStatus = xy[1];
            const gitlink = isGitlink(submodule, headMode, indexMode, worktreeMode);
            if (indexStatus !== '.') {
                staged.push(new CommitFile({
                    path: filePath,
                    status: porcelainStatus(indexStatus),
                    oldPath: indexStatus === 'R' || indexStatus === 'C' ? renameSourcePath : undefined,
                    oldObjectId: headObjectId,
                    newObjectId: indexObjectId,
                    oldMode: headMode,
                    newMode: indexMode,
                    isGitlink: gitlink,
                }));
            }
            if (worktreeStatus !== '.') {
                changes.push(new CommitFile({
                    path: filePath,
                    status: porcelainStatus(worktreeStatus),
                    oldPath: worktreeStatus === 'R' || worktreeStatus === 'C' ? renameSourcePath : undefined,
                    oldObjectId: indexObjectId,
                    newObjectId: zeroObjectId(indexObjectId),
                    oldMode: indexMode,
                    newMode: worktreeMode,
                    isGitlink: gitlink,
                }));
            }
            continue;
        }
        if (recordType === 'u' && fields.length >= 11) {
            const xy = fields[1];
            const submodule = fields[2];
            const baseMode = fields[3];
            const oursMode = fields[4];
            const worktreeMode = fields[6];
            const baseObjectId = fields[7];
            const oursObjectId = fields[8];
            const filePath = fields.slice(10).join(' ');
            const gitlink = isGitlink(submodule, baseMode, oursMode, worktreeMode);
            if (xy[0] !== '.') {
                staged.push(new CommitFile({
                    path: filePath,
                    status: 'U',
                    oldObjectId: baseObjectId,
                    newObjectId: oursObjectId,
                    oldMode: baseMode,
                    newMode: oursMode,
                    isGitlink: gitlink,
                    isConflict: true,
                }));
            }
            if (xy[1] !== '.') {
                changes.push(new CommitFile({
                    path: filePath,
                    status: 'U',
                    oldObjectId: oursObjectId,
                    newObjectId: zeroObjectId(oursObjectId),
                    oldMode: oursMode,
                    newMode: worktreeMode,
                    isGitlink: gitlink,
                    isConflict: true,
                }));
            }
        }
    }
    return new WorkingTreeChanges({ staged, changes });
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
        files.push(new CommitFile({
            path,
            oldPath,
            status: porcelainStatus(code),
            oldObjectId,
            newObjectId,
            oldMode,
            newMode,
            isGitlink: oldMode === '160000' || newMode === '160000',
        }));
    }
    return files;
}

