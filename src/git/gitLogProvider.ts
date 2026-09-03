import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
// 类型定义统一从 types/ 导入, 消除重复
export type { ChangeSetMode, FileStatus, GitBranchOption, GitRepositoryOption, GitRepositoryState, WorkingTreeChanges } from '../types';
export { CommitFile, CommitMetadata } from '../types';
import { CommitFile, CommitMetadata, GitBranchOption, GitRepositoryOption, GitRepositoryState, WorkingTreeChanges, type FileStatus } from '../types';

const execFileAsync = promisify(execFile);
const noOptionalLocks = ['--no-optional-locks'] as const;

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

async function getInitializedSubmodulePaths(rootPath: string, signal?: AbortSignal): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('git', [
            ...noOptionalLocks, '-C', rootPath,
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
        const { stdout } = await execFileAsync('git', [...noOptionalLocks, '-C', directory, 'rev-parse', '--show-toplevel'], {
            windowsHide: true,
            signal,
        });
        return stdout.trim() || undefined;
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
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
    const hashPattern = /^[0-9a-f]{40}$/i;
    const parseHashes = (stdout: string) =>
        [...new Set(stdout.split('\n').map(line => line.trim()).filter(line => hashPattern.test(line)))];
    try {
        const { stdout } = await execFileAsync('git', [
            ...noOptionalLocks, '-C', rootUri.fsPath, 'rev-parse', ...refs.map(ref => `${ref}^{commit}`),
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
            ...noOptionalLocks, '-C', rootUri.fsPath, 'show', '-s', '--format=%H%x00%an%x00%ae%x00%aI%x00', ...hashes,
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

async function readBranchRefsFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<{ currentBranch?: string; detachedHead?: string; local: GitRefRecord[]; remote: GitRefRecord[] }> {
    const parseRefs = (stdout: string) => stdout.split(/\r?\n/).flatMap(line => {
        if (!line) { return []; }
        const [hash, label, name, upstream] = line.split('\t');
        if (!hash || !label || !name || label.endsWith('/HEAD')) { return []; }
        return [{ hash, label, name, upstreamName: upstream || undefined }];
    });
    const [currentResult, refsResult, headResult] = await Promise.all([
        execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true, signal }).catch(error => {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
            return { stdout: '' };
        }),
        execFileAsync('git', [
            ...noOptionalLocks, '-C', rootUri.fsPath,
            'for-each-ref', '--format=%(objectname)%09%(refname:short)%09%(refname)%09%(upstream)', 'refs/heads', 'refs/remotes',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        // detached HEAD 时用裸 hash 兜底当前项；空仓库解析失败按无 HEAD 处理。
        execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'rev-parse', 'HEAD'], { windowsHide: true, signal }).catch(error => {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
            return { stdout: '' };
        }),
    ]);
    const refs = parseRefs(refsResult.stdout);
    const currentName = currentResult.stdout.trim();
    const headHash = headResult.stdout.trim();
    return {
        currentBranch: currentName ? `refs/heads/${currentName}` : undefined,
        detachedHead: !currentName && headHash ? headHash : undefined,
        local: refs.filter(ref => ref.name.startsWith('refs/heads/')),
        remote: refs.filter(ref => ref.name.startsWith('refs/remotes/')),
    };
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
    const [refsOutput, commitsOutput] = await Promise.all([
        runGitReadCommand(rootUri, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(HEAD)', 'refs/heads', 'refs/remotes']),
        runGitReadCommand(rootUri, [
            'log', '--branches', '--not', '--remotes', `--max-count=${commitLimit}`,
            '--format=%ct%x1f%D%x1f%s%x1e',
        ]),
    ]);
    const commitsByBranch = new Map<string, { subject: string; timestamp: number }[]>();
    for (const record of commitsOutput.split('\x1e')) {
        const [timestampText, decorations, subject] = record.replace(/^\r?\n/, '').split('\x1f');
        const timestamp = Number(timestampText);
        if (!subject || !Number.isFinite(timestamp)) { continue; }
        for (const decoration of (decorations ?? '').split(', ')) {
            const branch = decoration.replace(/^HEAD -> /, '').trim();
            if (!branch || branch === 'HEAD' || branch.startsWith('tag: ') || branch.includes(' -> ')) { continue; }
            const commits = commitsByBranch.get(branch) ?? [];
            commits.push({ subject, timestamp });
            commitsByBranch.set(branch, commits);
        }
    }
    const localBranches: { name: string; upstreamName: string; upstreamRemote: string; upstreamBranch: string; isCurrent: boolean }[] = [];
    const remoteBranches: { remote: string; branch: string; label: string }[] = [];
    for (const line of refsOutput.split(/\r?\n/)) {
        const [refname, shortName, upstreamName, upstreamRemote, upstreamRef, head] = line.split('\0');
        if (!refname || !shortName) { continue; }
        if (refname.startsWith('refs/heads/')) {
            localBranches.push({
                name: shortName,
                upstreamName,
                upstreamRemote,
                upstreamBranch: upstreamRef?.replace(/^refs\/heads\//, '') ?? '',
                isCurrent: head === '*',
            });
        } else if (refname.startsWith('refs/remotes/')) {
            const [remote, ...branchParts] = shortName.split('/');
            const branch = branchParts.join('/');
            if (remote && branch && branch !== 'HEAD') { remoteBranches.push({ remote, branch, label: shortName }); }
        }
    }
    const candidates = localBranches.flatMap(local => {
        const preferredTargets = local.upstreamRemote && local.upstreamBranch
            ? [{ remote: local.upstreamRemote, branch: local.upstreamBranch, label: local.upstreamName }]
            : [];
        const targets = [...preferredTargets, ...remoteBranches.filter(remote =>
            !preferredTargets.some(preferred => preferred.remote === remote.remote && preferred.branch === remote.branch))];
        return targets.map(target => ({
            name: local.name,
            upstreamName: target.label,
            upstreamRemote: target.remote,
            upstreamBranch: target.branch,
            isCurrent: local.isCurrent,
            recentUnpushedCommits: commitsByBranch.get(local.name) ?? [],
        }));
    });
    return candidates.sort((left, right) => {
        const leftTimestamp = left.recentUnpushedCommits[0]?.timestamp ?? 0;
        const rightTimestamp = right.recentUnpushedCommits[0]?.timestamp ?? 0;
        return Number(right.isCurrent) - Number(left.isCurrent)
            || rightTimestamp - leftTimestamp
            || left.upstreamName.localeCompare(right.upstreamName)
            || left.name.localeCompare(right.name);
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
    try {
        const { stdout } = await execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
            windowsHide: true,
            signal,
        });
        const label = stdout.trim();
        return label ? `refs/heads/${label}` : undefined;
    } catch (error) {
        // 中止需向上传播，避免被当成 detached HEAD 处理。
        if ((error as { name?: string; code?: string })?.name === 'AbortError'
            || (error as { name?: string; code?: string })?.code === 'ABORT_ERR') {
            throw error;
        }
        // Detached HEAD 时 symbolic-ref 按 Git 约定返回非零。
        return undefined;
    }
}

export async function getCurrentGitHeadHash(rootUri: vscode.Uri, signal?: AbortSignal): Promise<string | undefined> {
    const { stdout } = await execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'rev-parse', 'HEAD'], {
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
    submodulePaths: readonly string[];
}

interface GitlinkChange {
    status: string;
    path: string;
}

async function getGitlinkChanges(rootUri: vscode.Uri, beforeHead: string, afterHead: string): Promise<GitlinkChange[]> {
    const output = await runGitReadCommand(rootUri, [
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
        return {
            headChanged: false,
            submodulesNeedUpdate: false,
            submoduleTopologyChanged: false,
            submodulePaths: [],
        };
    }

    if (action === 'pull') {
        const beforeHead = await getCurrentGitHeadHash(rootUri);
        onProgress?.('正在拉取远程代码...');
        await runGitCommand(rootUri, ['pull']);
        const afterHead = await getCurrentGitHeadHash(rootUri);
        if (!beforeHead || !afterHead || beforeHead === afterHead) {
            return {
                headChanged: false,
                submodulesNeedUpdate: false,
                submoduleTopologyChanged: false,
                submodulePaths: [],
            };
        }

        const gitlinkChanges = await getGitlinkChanges(rootUri, beforeHead, afterHead);
        const submodulePaths = gitlinkChanges
            .filter(change => change.status !== 'D')
            .map(change => change.path);
        return {
            headChanged: true,
            submodulesNeedUpdate: submodulePaths.length > 0,
            submoduleTopologyChanged: gitlinkChanges.some(change => change.status === 'A' || change.status === 'D'),
            submodulePaths,
        };
    }

    onProgress?.('正在推送本地提交...');
    await runGitCommand(rootUri, ['push']);
    return {
        headChanged: false,
        submodulesNeedUpdate: false,
        submoduleTopologyChanged: false,
        submodulePaths: [],
    };
}

export async function updateGitSubmodules(
    rootUri: vscode.Uri,
    submodulePaths: readonly string[],
    onProgress?: (message: string) => void,
): Promise<void> {
    for (let index = 0; index < submodulePaths.length; index++) {
        const path = submodulePaths[index];
        onProgress?.(`正在初始化并更新 Submodule 模块（${index + 1}/${submodulePaths.length}）：${path}`);
        await runGitCommand(rootUri, ['submodule', 'update', '--init', '--recursive', '--', path]);
        onProgress?.(`已完成 Submodule 模块（${index + 1}/${submodulePaths.length}）：${path}`);
    }
}

export interface CommitHistoryMessage {
    readonly shortHash: string;
    readonly subject: string;
    readonly message: string;
}

export async function readCurrentCommitMessage(rootUri: vscode.Uri): Promise<string> {
    const output = await runGitReadCommand(rootUri, ['log', '-1', '--format=%B']);
    return output.replace(/\s+$/, '');
}

export async function readCommitHistoryMessages(rootUri: vscode.Uri): Promise<CommitHistoryMessage[]> {
    const output = await runGitReadCommand(rootUri, [
        'log', '--max-count=50', '--all', '--format=%h%x1f%s%x1f%B%x1e',
    ]);
    const seen = new Set<string>();
    const messages: CommitHistoryMessage[] = [];
    for (const record of output.split('\x1e')) {
        const [shortHash, subject, body] = record.replace(/^\r?\n/, '').split('\x1f');
        if (!shortHash) { continue; }
        const message = (body ?? '').replace(/\s+$/, '');
        if (!message || seen.has(message)) { continue; }
        seen.add(message);
        messages.push({ shortHash, subject: subject || message.split('\n')[0], message });
        if (messages.length >= 10) { break; }
    }
    return messages;
}

/** 读取当前 HEAD 相对 upstream 的 ahead 数；没有 upstream 时返回 0。 */
export async function getGitAheadCount(rootUri: vscode.Uri): Promise<number> {
    try {
        const output = await runGitReadCommand(rootUri, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
        const [ahead] = output.trim().split(/\s+/).map(Number);
        return Number.isFinite(ahead) ? ahead : 0;
    } catch {
        return 0;
    }
}

export async function runGitReadCommand(rootUri: vscode.Uri, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, ...args], {
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
    }
}

/** 执行可能修改 index、refs、工作区或远程状态的 Git 命令，保留 Git 原子锁。 */
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
function parseLogOutput(stdout: string): CommitMetadata[] {
    return stdout.split('\x1e').flatMap(record => {
        const [hash, parentText, author, authorEmail, committer, committerEmail, dateText, subject, body, decorations] = record.trim().split('\x1f');
        if (!hash) { return []; }
        const authorDate = new Date(dateText);
        return [new CommitMetadata({
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
        })];
    });
}

async function readCommitsFromCli(rootUri: vscode.Uri, limit: number, refs: readonly string[], skip: number, signal?: AbortSignal): Promise<CommitMetadata[]> {
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const { stdout } = await execFileAsync('git', [
        ...noOptionalLocks, '-C', rootUri.fsPath, 'log', '--topo-order', `--max-count=${limit}`, ...(skip > 0 ? [`--skip=${skip}`] : []),
        '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%aI%x1f%s%x1f%b%x1f%D%x1e', ...commitRefs,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
    return parseLogOutput(stdout);
}

// 获取仓库提交列表。
export async function getGitCommits(rootUri: vscode.Uri, limit: number = 500, refs: readonly string[] = [], skip: number = 0, onProgress?: (current: number, total: number) => void, signal?: AbortSignal): Promise<CommitMetadata[]> {
    throwIfAborted(signal);
    onProgress?.(0, 1);
    const commits = await readCommitsFromCli(rootUri, limit, refs, skip, signal);
    onProgress?.(1, 1);
    return commits;
}

// 搜索提交: 全量获取后在 TS 端过滤, 任意关键词命中任意字段即返回
export async function searchCommits(rootUri: vscode.Uri, keywords: string[], refs: readonly string[] = [], signal?: AbortSignal): Promise<CommitMetadata[]> {
    if (keywords.length === 0) { return []; }
    const commitRefs = refs.length > 0 ? [...refs] : ['HEAD'];
    const { stdout } = await execFileAsync('git', [
        ...noOptionalLocks, '-C', rootUri.fsPath, 'log', '--topo-order',
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

// 判断是否 git 仓库
export async function isGitRepo(rootUri: vscode.Uri): Promise<boolean> {
    return !!await resolveRepositoryRoot(rootUri.fsPath);
}

// 通过 git 命令获取指定提交的变更文件列表 (仅 --raw 清单, 不含行数统计)
export async function getCommitFiles(rootUri: vscode.Uri, hash: string, signal?: AbortSignal, onProgress?: (current: number, total: number) => void): Promise<CommitFile[]> {
    onProgress?.(0, 0);
    const rawResult = await execFileAsync('git', [
        ...noOptionalLocks, '-C', rootUri.fsPath,
        'diff-tree', '--root', '--no-commit-id', '--raw', '-z', '-M', '-r', hash,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
    const files = parseRawStatus(rawResult.stdout);
    onProgress?.(files.length, files.length);
    return files;
}

/** 读取当前提交树中实际包含的 gitlink 路径。 */
export async function getGitlinkPathsInCommit(rootUri: vscode.Uri, hash: string): Promise<string[]> {
    const output = await runGitReadCommand(rootUri, ['ls-tree', '-r', '--full-tree', hash]);
    return output.split(/\r?\n/).flatMap(line => {
        const match = /^(160000)\s+commit\s+[0-9a-f]+\t(.+)$/.exec(line);
        return match ? [match[2]] : [];
    });
}

export async function getGitRepositoryState(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    return readRepositoryStateFromCli(rootUri, signal);
}

// 从 git CLI 读取 refs 身份；工作区状态由 UncommittedFilesWatcher 独占读取。
async function readRepositoryStateFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    try {
        const [headResult, branchResult, refsResult] = await Promise.all([
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true, signal }),
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'branch', '--show-current'], { windowsHide: true, signal }),
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'for-each-ref', '--format=%(refname) %(objectname)'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        ]);
        return new GitRepositoryState({
            head: headResult.stdout.trim(),
            branch: branchResult.stdout.trim() || 'HEAD',
            refs: refsResult.stdout,
        });
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取仓库状态: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    try {
        const result = await execFileAsync('git', [
            '--no-optional-locks', '-C', rootUri.fsPath,
            'status', '--porcelain=v1', '-z', '--untracked-files=normal',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
        return result.stdout.split('\0').some(entry => entry.length >= 4);
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取工作区状态: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function getWorkingTreeStatusForPaths(
    rootUri: vscode.Uri,
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
    return readWorkingTreeStatus(rootUri, paths, signal);
}

export async function getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>> {
    try {
        const result = await execFileAsync('git', [
            '--no-optional-locks', '-C', rootUri.fsPath,
            'diff', '--cached', '--ita-visible-in-index', '--name-only', '-z', '-M', '-C',
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
        return new Set(result.stdout.split('\0').filter(Boolean));
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取 index 变更路径: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function readWorkingTreeStatus(
    rootUri: vscode.Uri,
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
    try {
        const statusArgs = [
            '--no-optional-locks', '-C', rootUri.fsPath,
            'status', '--porcelain=v1', '-z', '--untracked-files=all',
            ...(paths.length > 0 ? ['--', ...paths] : []),
        ];
        const rawPaths = paths.length > 0 ? ['--', ...paths] : [];
        const [statusResult, stagedMetadata, unstagedMetadata] = await Promise.all([
            execFileAsync('git', statusArgs, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
            readWorkingTreeRawMetadata(rootUri, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '-M', ...rawPaths], signal),
            readWorkingTreeRawMetadata(rootUri, ['diff', '--raw', '-z', '--no-abbrev', '-M', ...rawPaths], signal),
        ]);
        const status = parseWorkingTreeStatus(statusResult.stdout);
        return new WorkingTreeChanges({
            staged: mergeWorkingTreeMetadata(status.staged, stagedMetadata),
            changes: mergeWorkingTreeMetadata(status.changes, unstagedMetadata),
        });
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取工作区状态: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// 从 git CLI 读完整工作区变更元数据。
function parseWorkingTreeStatus(stdout: string): WorkingTreeChanges {
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
            staged.push(new CommitFile({
                path: filePath,
                status: porcelainStatus(indexStatus),
                oldPath: indexStatus === 'R' || indexStatus === 'C' ? renameSourcePath : undefined,
            }));
        }
        if (workingTreeStatus !== ' ') {
            changes.push(new CommitFile({
                path: filePath,
                status: porcelainStatus(workingTreeStatus),
                oldPath: workingTreeStatus === 'R' || workingTreeStatus === 'C' ? renameSourcePath : undefined,
                isUntracked: indexStatus === '?' && workingTreeStatus === '?',
            }));
        }
    }
    return new WorkingTreeChanges({ staged, changes });
}

function readWorkingTreeRawMetadata(
    rootUri: vscode.Uri,
    args: string[],
    signal?: AbortSignal,
): Promise<CommitFile[]> {
    return execFileAsync('git', [
        '--no-optional-locks', '-C', rootUri.fsPath,
        ...args,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal })
        .then(result => parseRawStatus(result.stdout));
}

function mergeWorkingTreeMetadata(files: readonly CommitFile[], metadata: readonly CommitFile[]): CommitFile[] {
    const metadataByPath = new Map(metadata.map(file => [file.path, file]));
    return files.map(file => {
        const raw = metadataByPath.get(file.path);
        return raw ? new CommitFile({ ...file, ...raw, status: file.status, isUntracked: file.isUntracked }) : file;
    });
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

