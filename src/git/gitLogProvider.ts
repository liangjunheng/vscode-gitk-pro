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

/** 推送源: 当前 checkout 的本地分支名与它指向的提交; 两者永不互相替代。 */
export interface PushSourceBranch {
    /** 本地分支名(仓库卡片显示的名字); detached HEAD 时为 undefined。 */
    readonly branchName?: string;
    /** 该分支当前指向的提交(完整 hash)。 */
    readonly hash: string;
}

/** 推送目标: 一个远程分支。 */
export interface PushTargetOption {
    /** 远程名, 例如 origin。 */
    readonly remote: string;
    /** 远程分支名(不含远程前缀), 例如 master。 */
    readonly branch: string;
    /** 远程分支的完整显示名, 例如 origin/master。 */
    readonly remoteName: string;
    /** 该远程分支是否为当前本地分支配置的 upstream。 */
    readonly isUpstream: boolean;
    /** 远程分支 tip 的提交时间(秒), 用于按最新修改排序。 */
    readonly tipTimestamp: number;
    /** 当前 HEAD 相对该远程分支的未推送提交总数。 */
    readonly unpushedCommitCount: number;
}

/** 一次 Push 的完整计划: 一个源, 多个候选远程分支。 */
export interface PushPlan {
    readonly source: PushSourceBranch;
    readonly targets: readonly PushTargetOption[];
}

/** 原生 pushBranches 的单条记录; 它按“本地分支 x 远程分支”展开, 需要在 TS 侧收敛成远程分支列表。 */
interface NativePushBranchRecord {
    readonly name: string;
    readonly upstreamName: string;
    readonly upstreamRemote: string;
    readonly upstreamBranch: string;
    readonly isCurrent: boolean;
    readonly isUpstream?: boolean;
    readonly tipTimestamp?: number;
    readonly recentUnpushedCommits: readonly { readonly subject: string; readonly timestamp: number }[];
}

/**
 * 读取一次 Push 所需的最小数据集: 当前分支(源) + 可选远程分支(目标)。
 *
 * 原生 pushBranches 返回的是本地分支与远程分支的笛卡尔展开, 这里只保留当前 checkout
 * 对应的记录, 再按 remote/branch 去重成远程分支列表; 源分支名与 HEAD hash 由 head 操作提供,
 * 两者分别存放, 避免上层用 hash 冒充分支名。
 *
 * isUpstream/tipTimestamp 在此补齐, 不依赖原生返回: 旧版原生模块不返回这两个字段,
 * 一旦缺失, 目标排序的“绑定 upstream 优先 + 最新提交时间倒序”会整体失效。
 */
export async function getPushPlan(rootUri: vscode.Uri, commitLimit = 8): Promise<PushPlan | undefined> {
    const [records, head] = await Promise.all([
        invokeNativeGit<NativePushBranchRecord[]>('pushBranches', {
            rootPath: rootUri.fsPath,
            limit: commitLimit,
        }),
        invokeNativeGit<{ hash?: string; branch?: string } | null>('head', { rootPath: rootUri.fsPath })
            .catch(() => undefined),
    ]);
    if (!head?.hash) { return undefined; }
    const source: PushSourceBranch = { branchName: head.branch ?? undefined, hash: head.hash };
    if (records.length === 0) { return { source, targets: [] }; }
    const [refs, remoteTipTimestamps, unpushedCounts] = await Promise.all([
        readBranchRefsFromCli(rootUri).catch(() => undefined),
        readRemoteTipTimestamps(rootUri).catch(() => new Map<string, number>()),
        readUnpushedCommitCounts(rootUri, records).catch(() => new Map<string, number>()),
    ]);
    const configuredUpstream = (refs?.local ?? [])
        .find(ref => ref.label === source.branchName)?.upstreamName;
    // 源分支确定后, 其他本地分支的记录与本次推送无关: 它们只会重复同一组远程分支。
    const relevant = source.branchName
        ? records.filter(record => record.name === source.branchName)
        : records.filter(record => record.isCurrent);
    const candidates = relevant.length > 0 ? relevant : records;
    const targetsByKey = new Map<string, PushTargetOption>();
    for (const record of candidates) {
        if (!record.upstreamRemote || !record.upstreamBranch) { continue; }
        const key = `${record.upstreamRemote}\u0000${record.upstreamBranch}`;
        if (targetsByKey.has(key)) { continue; }
        targetsByKey.set(key, {
            remote: record.upstreamRemote,
            branch: record.upstreamBranch,
            remoteName: record.upstreamName,
            isUpstream: configuredUpstream
                ? configuredUpstream === record.upstreamName
                : record.isUpstream === true,
            tipTimestamp: Number.isFinite(record.tipTimestamp)
                ? record.tipTimestamp as number
                : remoteTipTimestamps.get(record.upstreamName) ?? 0,
            unpushedCommitCount: unpushedCounts.get(record.upstreamName)
                ?? record.recentUnpushedCommits.length,
        });
    }
    // 绑定的 upstream 永远第一, 其余按远程 tip 时间倒序; 同时间按名称稳定排序。
    const targets = [...targetsByKey.values()].sort((left, right) =>
        Number(right.isUpstream) - Number(left.isUpstream)
        || right.tipTimestamp - left.tipTimestamp
        || left.remoteName.localeCompare(right.remoteName));
    return { source, targets };
}

/** 当前分支配置的 upstream; 没有配置时退回第一个目标。 */
export function defaultPushTarget(plan: PushPlan): PushTargetOption | undefined {
    return plan.targets.find(target => target.isUpstream) ?? plan.targets[0];
}

/**
 * 每个远程分支的未推送提交总数。recentUnpushedCommits 受 limit 截断, 直接取其长度会把
 * 所有超过上限的分支显示成同一个数字, 因此这里按 <remote>..HEAD 单独统计真实数量。
 */
async function readUnpushedCommitCounts(
    rootUri: vscode.Uri,
    records: readonly NativePushBranchRecord[],
): Promise<Map<string, number>> {
    const remoteNames = [...new Set(records.map(record => record.upstreamName).filter(Boolean))];
    const counted = await Promise.all(remoteNames.map(async remoteName => {
        try {
            const commits = await invokeNativeGit<Array<{ hash: string }>>('rangeCommits', {
                rootPath: rootUri.fsPath,
                from: remoteName,
                to: 'HEAD',
            });
            return [remoteName, commits.length] as const;
        } catch {
            // 远程分支缺失或无法比较时退回样本长度, 不让计数失败阻断选择器。
            return undefined;
        }
    }));
    return new Map(counted.filter((entry): entry is readonly [string, number] => entry !== undefined));
}

/** 远程分支 tip 的提交时间(秒), 用于 Push 目标按最新修改排序。 */
async function readRemoteTipTimestamps(rootUri: vscode.Uri): Promise<Map<string, number>> {
    const { remote } = await readBranchRefsFromCli(rootUri);
    const hashes = [...new Set(remote.map(ref => ref.hash))];
    if (hashes.length === 0) { return new Map(); }
    const commits = await invokeNativeGit<Array<{ hash: string; authorDate: string }>>('commitDetails', {
        rootPath: rootUri.fsPath,
        hashes,
    });
    const secondsByHash = new Map(commits.map(commit => {
        const parsed = Date.parse(commit.authorDate);
        return [commit.hash, Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)] as const;
    }));
    return new Map(remote.map(ref => [ref.label, secondsByHash.get(ref.hash) ?? 0]));
}

export async function getGitBranches(rootUri: vscode.Uri, signal?: AbortSignal): Promise<GitBranchOption[]> {
    throwIfAborted(signal);
    try {
        const { currentBranch, detachedHead, local, remote } = await readBranchRefsFromCli(rootUri, signal);
        const branchRefs = [...local, ...remote];
        // A single detail lookup covers every local/remote ref tip. Sorting remains usable
        // when the optional enrichment fails, with branch names as its stable fallback.
        const tipTimestamps = await getCommitAuthorDetails(rootUri, [...new Set(branchRefs.map(ref => ref.hash))])
            .then(details => new Map([...details].map(([hash, detail]) => {
                const parsed = Date.parse(detail.date);
                return [hash, Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)] as const;
            })))
            .catch(() => new Map<string, number>());
        const currentRef = currentBranch ? local.find(ref => ref.name === currentBranch) : undefined;
        const repository = new GitRepositoryOption({ path: rootUri.toString(), label: rootUri.fsPath });
        const current = currentRef ? [new GitBranchOption({
            repoOption: repository,
            name: currentRef.name,
            label: currentRef.label,
            hash: currentRef.hash,
            kind: 'current',
            upstreamName: currentRef.upstreamName,
            tipTimestamp: tipTimestamps.get(currentRef.hash) ?? 0,
        })] : detachedHead ? [buildDetachedHeadBranch(rootUri, detachedHead)] : [];
        const branches = branchRefs.map(ref => new GitBranchOption({
            repoOption: repository,
            name: ref.name,
            label: ref.label,
            hash: ref.hash,
            kind: ref.name.startsWith('refs/remotes/') ? 'remote' : 'local',
            upstreamName: ref.upstreamName,
            tipTimestamp: tipTimestamps.get(ref.hash) ?? 0,
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
    pushResults?: readonly NativePushResult[];
    submoduleTopologyChanged: boolean;
    submodulePaths: readonly string[];
    summary?: string;
    details?: readonly string[];
}

async function readRemoteBranchHashes(rootUri: vscode.Uri): Promise<Map<string, string> | undefined> {
    try {
        const { remote } = await readBranchRefsFromCli(rootUri);
        return new Map(remote.map(ref => [ref.label, ref.hash]));
    } catch {
        // 读取结果失败不应把成功的网络操作误报为失败。
        return undefined;
    }
}

function describeRemoteBranchChanges(before: Map<string, string> | undefined, after: Map<string, string> | undefined): string[] {
    if (!before || !after) { return ['无法读取远程分支变化。']; }
    const changes: string[] = [];
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const previous = before.get(name);
        const current = after.get(name);
        if (previous === current) { continue; }
        if (!previous) { changes.push(`新增 ${name}：${current?.slice(0, 8)}`); }
        else if (!current) { changes.push(`删除 ${name}（原 ${previous.slice(0, 8)}）`); }
        else { changes.push(`更新 ${name}：${previous.slice(0, 8)} → ${current.slice(0, 8)}`); }
    }
    return changes;
}

interface GitlinkChange {
    status: string;
    path: string;
}

interface NativeSubmoduleState {
    path: string;
    absolutePath?: string;
    indexId?: string | null;
    workdirId?: string | null;
}

async function getSubmodulePathsNeedingUpdate(rootUri: vscode.Uri): Promise<string[]> {
    const repositoryHasSubmoduleUpdate = async (
        repositoryUri: vscode.Uri,
        ancestors: ReadonlySet<string>,
    ): Promise<boolean> => {
        const key = repositoryKey(repositoryUri.fsPath);
        if (ancestors.has(key)) { return false; }
        const childAncestors = new Set(ancestors);
        childAncestors.add(key);
        const modules = await invokeNativeGit<NativeSubmoduleState[]>('submodules', { rootPath: repositoryUri.fsPath });
        const updates = await Promise.all(modules.map(async module => {
            if (Boolean(module.indexId) && module.indexId !== module.workdirId) { return true; }
            if (!module.workdirId || !module.absolutePath) { return false; }
            const childRoot = await resolveRepositoryRoot(module.absolutePath);
            return childRoot
                ? repositoryHasSubmoduleUpdate(vscode.Uri.file(childRoot), childAncestors)
                : false;
        }));
        return updates.some(Boolean);
    };

    const modules = await invokeNativeGit<NativeSubmoduleState[]>('submodules', { rootPath: rootUri.fsPath });
    const rootAncestors = new Set<string>([repositoryKey(rootUri.fsPath)]);
    const paths = await Promise.all(modules.map(async module => {
        if (!module.indexId) { return undefined; }
        if (module.indexId !== module.workdirId) { return module.path; }
        if (!module.workdirId || !module.absolutePath) { return undefined; }
        const childRoot = await resolveRepositoryRoot(module.absolutePath);
        if (!childRoot) { return undefined; }
        // Nested paths belong to the child repository, so update their top-level owner from this root.
        return await repositoryHasSubmoduleUpdate(vscode.Uri.file(childRoot), rootAncestors) ? module.path : undefined;
    }));
    return paths.filter((modulePath): modulePath is string => Boolean(modulePath));
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
    pushTargets?: readonly PushTargetOption[],
): Promise<GitSyncResult> {
    if (action === 'fetch') {
        const repositories = await collectSubmoduleRepositories([{ rootPath: rootUri.fsPath }]);
        const submodules = repositories.slice(1);
        onProgress?.(`正在并行获取 ${repositories.length} 个仓库（含 ${submodules.length} 个子模块），并清理过期引用...`);
        let completed = 0;
        const changeGroups = await Promise.all(repositories.map(async (repository, index) => {
            const repositoryUri = index === 0 ? rootUri : vscode.Uri.file(repository.rootPath);
            const before = await readRemoteBranchHashes(repositoryUri);
            await fetchRemotes(repositoryUri);
            completed++;
            onProgress?.(`仓库获取完成（${completed}/${repositories.length}）：${repository.rootPath}`);
            const repositoryChanges = describeRemoteBranchChanges(
                before,
                await readRemoteBranchHashes(repositoryUri),
            );
            return index === 0
                ? repositoryChanges
                : repositoryChanges.map(change => `${repository.rootPath}：${change}`);
        }));
        const changes = changeGroups.flat();
        return {
            headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false, submodulePaths: [],
            summary: changes.length > 0
                ? `获取完成：检测到 ${changes.filter(change => !change.includes('无法读取远程分支变化')).length} 项远程分支变化，已获取 ${submodules.length} 个子模块`
                : `获取完成：远程分支无变化，已获取 ${submodules.length} 个子模块`,
            details: changes.length ? changes : ['远程分支无变化（标签等其他引用未列出）。'],
        };
    }
    if (action === 'pull') {
        const beforeHead = await getCurrentGitHeadHash(rootUri);
        const before = await readRemoteBranchHashes(rootUri);
        onProgress?.('正在通过 Git 拉取远程代码...');
        await pullNative(rootUri);
        const afterHead = await getCurrentGitHeadHash(rootUri);
        const changes = describeRemoteBranchChanges(before, await readRemoteBranchHashes(rootUri));
        const headChanged = Boolean(beforeHead && afterHead && beforeHead !== afterHead);
        const details = changes.map(change => change === '无法读取远程分支变化。'
            ? '远程跟踪分支变化无法确认'
            : `远程跟踪分支：${change}`);
        let submoduleTopologyChanged = false;
        if (beforeHead && afterHead && beforeHead !== afterHead) {
            const gitlinkChanges = await getGitlinkChanges(rootUri, beforeHead, afterHead);
            submoduleTopologyChanged = gitlinkChanges.some(change => change.status === 'A' || change.status === 'D');
        }
        onProgress?.('正在检查子模块是否需要更新...');
        let submodulePaths: string[] = [];
        try {
            submodulePaths = await getSubmodulePathsNeedingUpdate(rootUri);
        } catch (error) {
            details.push(`子模块状态检查失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const summary = !beforeHead || !afterHead
            ? '拉取完成，但无法确认本地提交是否变化'
            : headChanged
                ? `拉取完成：本地提交已更新（${beforeHead.slice(0, 8)} → ${afterHead.slice(0, 8)}）`
                : `拉取完成：当前分支已是最新（${afterHead.slice(0, 8)}）`;
        return {
            headChanged,
            submodulesNeedUpdate: submodulePaths.length > 0,
            submoduleTopologyChanged,
            submodulePaths,
            summary,
            details,
        };
    }
    onProgress?.('正在通过 Git 推送本地提交...');
    const plan = await getPushPlan(rootUri);
    const fallbackTarget = plan ? defaultPushTarget(plan) : undefined;
    const targets = pushTargets && pushTargets.length > 0
        ? pushTargets
        : fallbackTarget ? [fallbackTarget] : [];
    if (targets.length === 0) { throw new Error('当前仓库没有可推送的远程分支。'); }
    const pushResults: NativePushResult[] = [];
    for (const target of targets) {
        pushResults.push(await pushNative(rootUri, {
            remote: target.remote,
            remoteBranch: target.branch,
            sourceBranchName: plan?.source.branchName,
            sourceHash: plan?.source.hash,
        }));
    }
    return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false, submodulePaths: [], pushResults };
}

export async function updateGitSubmodules(
    rootUri: vscode.Uri,
    submodulePaths: readonly string[],
    onProgress?: (message: string) => void,
): Promise<void> {
    for (let index = 0; index < submodulePaths.length; index++) {
        const submodulePath = submodulePaths[index];
        onProgress?.(`正在更新子模块（${index + 1}/${submodulePaths.length}）：${submodulePath}`);
        await updateSubmodulesNative(rootUri, [submodulePath]);
        onProgress?.(`子模块更新完成（${index + 1}/${submodulePaths.length}）：${submodulePath}`);
    }
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

export async function getGitAheadBehind(rootUri: vscode.Uri): Promise<{ ahead: number; behind: number }> {
    try {
        return await invokeNativeGit<{ ahead: number; behind: number }>('aheadBehind', { rootPath: rootUri.fsPath });
    } catch {
        return { ahead: 0, behind: 0 };
    }
}

export async function getGitAheadCount(rootUri: vscode.Uri): Promise<number> {
    return (await getGitAheadBehind(rootUri)).ahead;
}

/** 云端提交最多下发到 Webview 的条数; 总数始终以 aheadBehind 的 behind 为准。 */
export const CLOUD_COMMIT_LIMIT = 200;

/**
 * HEAD..@{upstream} 中最新的 limit 条提交(含 parents)。只读取本地已有的远程跟踪分支, 不联网;
 * 没有 upstream、游离 HEAD 或上游已删除时返回空。
 */
export async function getCloudCommits(rootUri: vscode.Uri, limit: number = CLOUD_COMMIT_LIMIT): Promise<CommitMetadata[]> {
    try {
        const range = await invokeNativeGit<Array<{ hash: string }>>('rangeCommits', {
            rootPath: rootUri.fsPath,
            from: 'HEAD',
            to: '@{upstream}',
        });
        const wanted = new Set(range.slice(0, limit).map(commit => commit.hash));
        if (wanted.size === 0) { return []; }
        // rangeCommits 不带 parents/refs, 只能由 commits 补齐, 而 commits 没有 "排除 HEAD 可达" 的能力:
        // 上游历史里较新的公共祖先(合并提交的另一条父线)可能排在区间提交之前, 所以窗口不够就加倍重取。
        let window = wanted.size;
        for (let attempt = 0; attempt < 6; attempt++) {
            const upstreamCommits = await invokeNativeGit<NativeCommitMetadata[]>('commits', {
                rootPath: rootUri.fsPath,
                refs: ['@{upstream}'],
                limit: window,
                skip: 0,
            });
            const found = upstreamCommits.filter(commit => wanted.has(commit.hash));
            if (found.length === wanted.size || upstreamCommits.length < window) {
                return found.map(fromNativeCommit);
            }
            window *= 4;
        }
        return [];
    } catch {
        return [];
    }
}

/** 一条 stash: 带 isStash 标记与序号/引用名的 CommitMetadata。 */
export type StashEntry = CommitMetadata & { isStash: true; stashIndex: number; stashRef: string };

interface NativeStashEntry extends NativeCommitMetadata {
    stashIndex: number;
    stashRef: string;
}

/**
 * 读取仓库的全部 stash（最新在前）。只读，不联网；
 * 原生层不支持（旧二进制）或读取失败时返回空数组，保证状态刷新不被它打断。
 */
export async function getStashes(rootUri: vscode.Uri): Promise<StashEntry[]> {
    try {
        const entries = await invokeNativeGit<NativeStashEntry[]>('stashList', { rootPath: rootUri.fsPath });
        return entries.map(entry => new CommitMetadata({
            ...fromNativeCommit(entry),
            isStash: true,
            stashIndex: entry.stashIndex,
            stashRef: entry.stashRef,
        }) as StashEntry);
    } catch (error) {
        console.warn('无法读取 stash 列表:', rootUri.toString(), error);
        return [];
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

/** stash 的变更文件: 基线到 stash 树的差异，加上未跟踪文件。 */
export async function getStashFiles(rootUri: vscode.Uri, hash: string, signal?: AbortSignal): Promise<CommitFile[]> {
    throwIfAborted(signal);
    const files = await invokeNativeGit<Array<Partial<CommitFile> & { path: string }>>('stashFiles', {
        rootPath: rootUri.fsPath,
        revision: hash,
    });
    throwIfAborted(signal);
    return files.map(file => new CommitFile({ ...file, oldPath: file.oldPath ?? undefined }));
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

