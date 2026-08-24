import * as vscode from 'vscode';
import { execFile, spawn } from 'child_process';
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
        const [hash, label, name] = line.split('\t');
        if (!hash || !label || !name || label.endsWith('/HEAD')) { return []; }
        return [{ hash, label, name }];
    });
    const [currentResult, refsResult, headResult] = await Promise.all([
        execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true, signal }).catch(error => {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
            return { stdout: '' };
        }),
        execFileAsync('git', [
            ...noOptionalLocks, '-C', rootUri.fsPath,
            'for-each-ref', '--format=%(objectname)%09%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes',
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
        })] : detachedHead ? [buildDetachedHeadBranch(rootUri, detachedHead)] : [];
        const branches = branchRefs.map(ref => new GitBranchOption({
            repoOption: repository,
            name: ref.name,
            label: ref.label,
            hash: ref.hash,
            kind: ref.name.startsWith('refs/remotes/') ? 'remote' : 'local',
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
    const status = await runGitReadCommand(rootUri, ['submodule', 'status', '--recursive']);
    for (const line of status.split(/\r?\n/)) {
        const match = /^[ +\-U]?\S+\s+(.+?)(?:\s+\(|$)/.exec(line);
        if (match) {
            onProgress?.(`已完成 Submodule 模块：${match[1]}`);
        }
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
        'diff-tree', '--root', '--no-commit-id', '--raw', '-z', '-M', '-C', '-r', hash,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
    const files = parseRawStatus(rawResult.stdout);
    onProgress?.(files.length, files.length);
    return files;
}

export async function getGitRepositoryState(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    return readRepositoryStateFromCli(rootUri, signal);
}

// 从 git CLI 读状态签名 (4 条命令并行)
async function readRepositoryStateFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitRepositoryState> {
    try {
        const [headResult, branchResult, refsResult, statusResult] = await Promise.all([
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true, signal }),
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'branch', '--show-current'], { windowsHide: true, signal }),
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'for-each-ref', '--format=%(refname) %(objectname)'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
            execFileAsync('git', [...noOptionalLocks, '-C', rootUri.fsPath, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
        ]);
        return new GitRepositoryState({
            head: headResult.stdout.trim(),
            branch: branchResult.stdout.trim() || 'HEAD',
            refs: refsResult.stdout,
            status: statusResult.stdout,
        });
    } catch (error: any) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { throw error; }
        throw new Error(`无法读取仓库状态: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function checkWorkingTreePresence(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error('请求已取消');
            error.name = 'AbortError';
            reject(error);
            return;
        }
        const child = spawn('git', [
            '--no-optional-locks', '-C', rootUri.fsPath,
            '-c', 'status.renames=true',
            'status', '--porcelain=v1', '-z', '--untracked-files=normal',
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        let stderr = '';
        const finish = (value: boolean) => {
            if (settled) { return; }
            settled = true;
            signal?.removeEventListener('abort', abort);
            resolve(value);
        };
        const fail = (error: Error) => {
            if (settled) { return; }
            settled = true;
            signal?.removeEventListener('abort', abort);
            reject(error);
        };
        const abort = () => {
            child.kill();
            const error = new Error('请求已取消');
            error.name = 'AbortError';
            fail(error);
        };
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.once('data', () => {
            finish(true);
            child.kill();
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', error => fail(error));
        child.once('close', code => {
            if (settled) { return; }
            if (code === 0) { finish(false); }
            else { fail(new Error(stderr.trim() || `Git 状态检测失败，退出码 ${code}`)); }
        });
    });
}

export async function getWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
    // 完整元数据仅供显式调用方使用；文件 watcher 使用下方的轻量 status 快照。
    return readWorkingTreeChangesFromCli(rootUri, signal);
}

export async function getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
    return readWorkingTreeStatus(rootUri, [], signal);
}

export async function getWorkingTreeStatusForPaths(
    rootUri: vscode.Uri,
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
    return readWorkingTreeStatus(rootUri, paths, signal);
}

async function readWorkingTreeStatus(
    rootUri: vscode.Uri,
    paths: readonly string[],
    signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
    try {
        const result = await execFileAsync('git', [
            '--no-optional-locks', '-C', rootUri.fsPath,
            'status', '--porcelain=v1', '-z', '--untracked-files=all',
            ...(paths.length > 0 ? ['--', ...paths] : []),
        ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
        return parseWorkingTreeStatus(result.stdout);
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

async function readWorkingTreeChangesFromCli(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
    try {
        const [statusResult, stagedMetadata, changesMetadata] = await Promise.all([
            execFileAsync('git', [
                '--no-optional-locks', '-C', rootUri.fsPath,
                'status', '--porcelain=v1', '-z', '--untracked-files=all',
            ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal }),
            readDiffMetadata(rootUri, ['diff', '--cached'], signal),
            readDiffMetadata(rootUri, ['diff'], signal),
        ]);
        const status = parseWorkingTreeStatus(statusResult.stdout);
        return new WorkingTreeChanges({
            staged: mergeDiffMetadata(status.staged, stagedMetadata),
            changes: mergeDiffMetadata(status.changes, changesMetadata),
        });
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
    const rawResult = await execFileAsync('git', [
        '--no-optional-locks', '-C', rootUri.fsPath,
        ...args, '--raw', '-z', '-M', '-C',
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
    return parseRawStatus(rawResult.stdout);
}

function mergeDiffMetadata(files: CommitFile[], metadata: CommitFile[]): CommitFile[] {
    return files.map(file => {
        const match = metadata.find(candidate => candidate.path === file.path && candidate.status === file.status)
            ?? metadata.find(candidate => candidate.path === file.path);
        return match ? new CommitFile({ ...file, ...match, status: file.status }) : file;
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
        files.push(new CommitFile({ path, oldPath, status: porcelainStatus(code), oldObjectId, newObjectId, oldMode, newMode }));
    }
    return files;
}

