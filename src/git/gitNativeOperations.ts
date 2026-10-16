import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';

function isUnexpectedHttpContentType(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('unexpected content-type') && message.includes('class=Http');
}

function sanitizeGitOutput(output: string): string {
    return output.replace(/(https?:\/\/)([^\s/@]+)@/gi, '$1[credentials]@').trim();
}

function runGitCli(rootUri: vscode.Uri, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', rootUri.fsPath, ...args], {
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            const output = sanitizeGitOutput([stdout, stderr].filter(Boolean).join('\n'));
            if (!error) {
                resolve(output);
                return;
            }
            const reason = output || error.message;
            reject(new Error(`Git CLI 回退失败：${reason}`));
        });
    });
}

async function withHttpTransportFallback<T>(
    rootUri: vscode.Uri,
    operation: string,
    nativeOperation: () => Promise<T>,
    cliArgs: readonly string[],
    fallbackValue: T,
    fallbackResult?: (output: string) => T,
): Promise<T> {
    try {
        return await nativeOperation();
    } catch (error) {
        if (!isUnexpectedHttpContentType(error)) { throw error; }
        console.warn(`[Gitk][Git] libgit2 ${operation} 收到非 Git HTTP 内容，改用 Git CLI 兼容企业安全网关。`);
        const output = await runGitCli(rootUri, cliArgs);
        return fallbackResult ? fallbackResult(output) : fallbackValue;
    }
}

export interface NativeStatusSummary { hasStagedChanges: boolean; hasUnstagedChanges: boolean; }
export interface NativeSyncResult { changed?: boolean; fastForward?: boolean; }

export async function configGet(rootUri: vscode.Uri, key: string, defaultValue = ''): Promise<string> {
    return invokeNativeGit<string>('configGet', { rootPath: rootUri.fsPath, key, defaultValue });
}

export async function statusSummary(rootUri: vscode.Uri): Promise<NativeStatusSummary> {
    const value = await invokeNativeGit<{ staged: unknown[]; changes: unknown[] }>('status', {
        rootPath: rootUri.fsPath, paths: [], recurseUntrackedDirs: false,
    });
    return { hasStagedChanges: value.staged.length > 0, hasUnstagedChanges: value.changes.length > 0 };
}

export const stageAll = (rootUri: vscode.Uri): Promise<void> =>
    invokeNativeGit<void>('stageAll', { rootPath: rootUri.fsPath });
export const commit = (rootUri: vscode.Uri, message: string, amend = false): Promise<string> =>
    invokeNativeGit<string>('commit', { rootPath: rootUri.fsPath, message, amend });
export const createTag = (rootUri: vscode.Uri, name: string, revision: string, message: string): Promise<string> =>
    invokeNativeGit<string>('createTag', { rootPath: rootUri.fsPath, name, revision, message });
export const createBranch = (rootUri: vscode.Uri, name: string, revision: string): Promise<void> =>
    invokeNativeGit<void>('createBranch', { rootPath: rootUri.fsPath, name, revision });
export const checkout = (rootUri: vscode.Uri, revision: string, detach = false): Promise<void> =>
    invokeNativeGit<void>('checkout', { rootPath: rootUri.fsPath, revision, detach });
export const checkoutBranch = (rootUri: vscode.Uri, branch: string): Promise<void> =>
    invokeNativeGit<void>('checkoutBranch', { rootPath: rootUri.fsPath, branch });

/** Git CLI provides safe checkout + upstream setup for a new remote-tracking local branch. */
export async function checkoutRemoteBranch(rootUri: vscode.Uri, remoteRef: string, localName: string): Promise<void> {
    if (!remoteRef.startsWith('refs/remotes/') || remoteRef.endsWith('/HEAD') || localName.startsWith('-')) {
        throw new Error('远程分支或本地分支名称无效');
    }
    await runGitCli(rootUri, ['check-ref-format', '--branch', localName]);
    await runGitCli(rootUri, ['checkout', '--track', '-b', localName, remoteRef]);
}
export const cherryPick = (rootUri: vscode.Uri, revision: string): Promise<string> =>
    invokeNativeGit<string>('cherryPick', { rootPath: rootUri.fsPath, revision });
export const revertCommit = (rootUri: vscode.Uri, revision: string): Promise<string> =>
    invokeNativeGit<string>('revert', { rootPath: rootUri.fsPath, revision });
export const merge = (rootUri: vscode.Uri, revision: string): Promise<NativeSyncResult> =>
    invokeNativeGit<NativeSyncResult>('merge', { rootPath: rootUri.fsPath, revision });
export const rebase = (rootUri: vscode.Uri, revision: string): Promise<void> =>
    invokeNativeGit<void>('rebase', { rootPath: rootUri.fsPath, revision });
export const reset = (rootUri: vscode.Uri, revision: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> =>
    invokeNativeGit<void>('reset', { rootPath: rootUri.fsPath, revision, mode });
export function fetchRemotes(rootUri: vscode.Uri, remote?: string): Promise<void> {
    const cliArgs = remote
        ? ['fetch', '--prune', remote]
        : ['fetch', '--all', '--prune'];
    return withHttpTransportFallback(
        rootUri,
        'fetch',
        () => invokeNativeGit<void>('fetch', { rootPath: rootUri.fsPath, remote, prune: true }),
        cliArgs,
        undefined,
    );
}

export function pull(
    rootUri: vscode.Uri,
    remote?: string,
    remoteBranch?: string,
    localBranch?: string,
): Promise<NativeSyncResult> {
    const cliArgs = ['pull'];
    if (remote) { cliArgs.push(remote); }
    if (remote && remoteBranch) { cliArgs.push(remoteBranch); }
    return withHttpTransportFallback(
        rootUri,
        'pull',
        () => invokeNativeGit<NativeSyncResult>('pull', { rootPath: rootUri.fsPath, remote, remoteBranch, localBranch }),
        cliArgs,
        {},
    );
}

/** 一次 Push 请求: 推送源(当前 HEAD)与目标远程分支分开描述。 */
export interface NativePushRequest {
    /** 远程名, 例如 origin。 */
    readonly remote: string;
    /** 远程分支名(不含远程前缀), 例如 master。 */
    readonly remoteBranch: string;
    /** 推送源的本地分支名; detached HEAD 时为 undefined。仅用于远程/upstream 的配置回退与结果展示。 */
    readonly sourceBranchName?: string;
    /** 推送源提交(完整 hash); 实际推送内容始终是当前 HEAD。 */
    readonly sourceHash?: string;
}

export interface NativePushResult {
    readonly remote?: string;
    /** 推送源的本地分支名(由请求透传或原生返回)。 */
    readonly sourceBranchName?: string;
    /** 实际推送的提交(完整 hash)。 */
    readonly sourceHash?: string;
    readonly remoteBranch?: string;
    readonly output?: string;
}

/**
 * 推送当前 checkout 的 HEAD 到指定远程分支。
 * 分支名与提交 hash 在结果里分列两个字段, 调用方不得互相替代。
 */
export async function push(rootUri: vscode.Uri, request: NativePushRequest): Promise<NativePushResult> {
    const sourceHash = request.sourceHash
        ?? (await invokeNativeGit<string[]>('resolveRevision', {
            rootPath: rootUri.fsPath,
            specs: ['HEAD^{}'],
        }))[0];
    // libgit2 已在进入网络传输前执行 pre-push；回退时使用 --no-verify，避免同一 hook 执行两次。
    const cliArgs = ['push', '--no-verify', request.remote, `HEAD:${request.remoteBranch}`];
    const requestedTarget: NativePushResult = {
        remote: request.remote,
        remoteBranch: request.remoteBranch,
        sourceBranchName: request.sourceBranchName,
        sourceHash,
    };
    return withHttpTransportFallback(
        rootUri,
        'push',
        async () => {
            // 原生协议字段名保持 localBranch: 它只用于补全未指定的 remote/upstream 配置。
            const result = await invokeNativeGit<{
                remote?: string;
                localBranch?: string;
                sourceHash?: string;
                remoteBranch?: string;
                output?: string;
            }>('push', {
                rootPath: rootUri.fsPath,
                remote: request.remote,
                localBranch: request.sourceBranchName,
                remoteBranch: request.remoteBranch,
            });
            return {
                remote: result.remote ?? request.remote,
                remoteBranch: result.remoteBranch ?? request.remoteBranch,
                sourceBranchName: request.sourceBranchName ?? result.localBranch,
                sourceHash: result.sourceHash ?? sourceHash,
                output: result.output,
            };
        },
        cliArgs,
        requestedTarget,
        output => ({ ...requestedTarget, output }),
    );
}

export function updateSubmodules(rootUri: vscode.Uri, paths: readonly string[] = []): Promise<void> {
    return withHttpTransportFallback(
        rootUri,
        'submodule update',
        () => invokeNativeGit<void>('updateSubmodules', { rootPath: rootUri.fsPath, paths }),
        ['submodule', 'update', '--init', '--recursive', ...(paths.length > 0 ? ['--', ...paths] : [])],
        undefined,
    );
}
export const restoreSubmodule = (rootUri: vscode.Uri, revision: string): Promise<void> =>
    invokeNativeGit<void>('restoreSubmodule', { rootPath: rootUri.fsPath, revision });
export const indexGitlink = (rootUri: vscode.Uri, path: string): Promise<string | null> =>
    invokeNativeGit<string | null>('indexGitlink', { rootPath: rootUri.fsPath, path });
export const hasConflicts = (rootUri: vscode.Uri): Promise<boolean> =>
    invokeNativeGit<boolean>('hasConflicts', { rootPath: rootUri.fsPath });
export const trackedPaths = (rootUri: vscode.Uri, paths: readonly string[]): Promise<string[]> =>
    invokeNativeGit<string[]>('trackedPaths', { rootPath: rootUri.fsPath, paths });
export const restoreAll = (rootUri: vscode.Uri): Promise<void> =>
    invokeNativeGit<void>('restoreAll', { rootPath: rootUri.fsPath });


export interface NativeCommitDetails {
    hash: string;
    shortHash: string;
    message: string;
    subject?: string;
}

export async function resolveRevision(rootUri: vscode.Uri, spec: string): Promise<string | undefined> {
    const values = await invokeNativeGit<string[]>('resolveRevision', { rootPath: rootUri.fsPath, specs: [spec] });
    return values[0];
}
export const commitDetails = (rootUri: vscode.Uri, hashes: readonly string[]): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('commitDetails', { rootPath: rootUri.fsPath, hashes });
export const rangeCommits = (rootUri: vscode.Uri, from: string, to: string): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('rangeCommits', { rootPath: rootUri.fsPath, from, to });
