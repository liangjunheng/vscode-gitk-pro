import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';

interface SystemProxy {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy?: string;
}

let pendingSystemProxyRead: Promise<SystemProxy> | undefined;
const pendingFetches = new Map<string, Promise<void>>();

function sanitizeGitOutput(output: string): string {
    return output.replace(/(https?:\/\/)([^\s/@]+)@/gi, '$1[credentials]@').trim();
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) { return undefined; }
    return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function parseWindowsProxyServer(value: string | undefined): Pick<SystemProxy, 'http' | 'https'> {
    const entries = value?.split(';').map(entry => entry.trim()).filter(Boolean) ?? [];
    const byScheme = new Map<string, string>();
    let defaultProxy: string | undefined;
    for (const entry of entries) {
        const separator = entry.indexOf('=');
        if (separator < 0) {
            defaultProxy ??= entry;
            continue;
        }
        byScheme.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim());
    }
    return {
        http: normalizeProxyUrl(byScheme.get('http') ?? defaultProxy),
        https: normalizeProxyUrl(byScheme.get('https') ?? defaultProxy),
    };
}

function parseWindowsProxyOverride(value: string | undefined): string[] {
    const entries = value?.split(';').map(entry => entry.trim()).filter(Boolean) ?? [];
    return entries.flatMap(entry => entry === '<local>' ? ['localhost', '127.0.0.1', '::1'] : [entry]);
}

function readWindowsRegistryValue(name: string): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('reg', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v',
            name,
        ], { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
            if (error) {
                resolve(undefined);
                return;
            }
            const valueLine = stdout.split(/\r?\n/).find(line => line.trimStart().startsWith(name));
            const value = valueLine?.trim().match(new RegExp(`^${name}\\s+REG_\\w+\\s+(.+)$`, 'i'))?.[1];
            resolve(value?.trim());
        });
    });
}

function mergeNoProxy(...values: readonly (string | undefined)[]): string | undefined {
    const entries = values
        .flatMap(value => value?.split(',') ?? [])
        .map(value => value.trim())
        .filter(Boolean);
    return entries.length > 0 ? [...new Set(entries)].join(',') : undefined;
}

async function readSystemProxy(): Promise<SystemProxy> {
    const vscodeProxy = normalizeProxyUrl(vscode.workspace.getConfiguration('http').get<string>('proxy', ''));
    if (vscodeProxy) { return { http: vscodeProxy, https: vscodeProxy }; }
    if (process.platform !== 'win32') { return {}; }

    const [enabled, server, override, autoConfigUrl, autoDetect] = await Promise.all([
        readWindowsRegistryValue('ProxyEnable'),
        readWindowsRegistryValue('ProxyServer'),
        readWindowsRegistryValue('ProxyOverride'),
        readWindowsRegistryValue('AutoConfigURL'),
        readWindowsRegistryValue('AutoDetect'),
    ]);
    // PAC/WPAD requires Windows' proxy-resolution API. Do not guess a single
    // manual proxy when the user has selected automatic proxy discovery.
    if (autoConfigUrl || autoDetect === '1' || /^0x1+$/i.test(autoDetect ?? '')) { return {}; }
    if (!enabled || /^0x0+$/i.test(enabled) || enabled === '0') { return {}; }
    return { ...parseWindowsProxyServer(server), noProxy: parseWindowsProxyOverride(override).join(',') || undefined };
}

function readSystemProxyShared(): Promise<SystemProxy> {
    if (pendingSystemProxyRead) { return pendingSystemProxyRead; }
    const task = readSystemProxy().finally(() => {
        if (pendingSystemProxyRead === task) { pendingSystemProxyRead = undefined; }
    });
    pendingSystemProxyRead = task;
    return task;
}

function isNetworkCommand(args: readonly string[]): boolean {
    return ['fetch', 'pull', 'push', 'submodule', 'ls-remote'].includes(args[0] ?? '');
}

async function hasExplicitGitProxy(rootUri: vscode.Uri): Promise<boolean> {
    return new Promise(resolve => {
        execFile('git', ['-C', rootUri.fsPath, 'config', '--get-regexp', '^(http\\.proxy|remote\\..*\\.proxy)$'], {
            windowsHide: true,
            encoding: 'utf8',
            env: process.env,
        }, (error, stdout) => resolve(!error && Boolean(stdout.trim())));
    });
}

async function gitCliEnvironment(rootUri: vscode.Uri, args: readonly string[]): Promise<NodeJS.ProcessEnv> {
    const environment = { ...process.env };
    if (!isNetworkCommand(args)
        || !vscode.workspace.getConfiguration('fastergit').get<boolean>('useSystemProxy', true)
        || await hasExplicitGitProxy(rootUri)) {
        return environment;
    }
    const proxy = await readSystemProxyShared();
    if (proxy.http && !environment.HTTP_PROXY && !environment.http_proxy) {
        environment.HTTP_PROXY = proxy.http;
        environment.http_proxy = proxy.http;
    }
    if (proxy.https && !environment.HTTPS_PROXY && !environment.https_proxy) {
        environment.HTTPS_PROXY = proxy.https;
        environment.https_proxy = proxy.https;
    }
    const noProxy = mergeNoProxy(environment.NO_PROXY, environment.no_proxy, proxy.noProxy);
    if (noProxy) { environment.NO_PROXY = noProxy; environment.no_proxy = noProxy; }
    return environment;
}

async function runGitCli(rootUri: vscode.Uri, args: readonly string[]): Promise<string> {
    const env = await gitCliEnvironment(rootUri, args);
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', rootUri.fsPath, ...args], {
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env,
        }, (error, stdout, stderr) => {
            const output = sanitizeGitOutput([stdout, stderr].filter(Boolean).join('\n'));
            if (!error) {
                resolve(output);
                return;
            }
            const reason = output || error.message;
            reject(new Error(`Git CLI 执行失败：${reason}`));
        });
    });
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

export interface RemoteTagRef {
    readonly remote: string;
    readonly name: string;
}

export interface CommitTagState {
    readonly localTags: readonly string[];
    readonly remoteTags: readonly RemoteTagRef[];
    readonly pushableTags: readonly RemoteTagRef[];
    readonly remoteErrors: readonly { remote: string; message: string }[];
}

type RemoteTagSnapshot = {
    readonly remote: string;
    readonly targetsByName: Map<string, string>;
};

function parseLocalTagTargets(output: string): Map<string, string> {
    const targets = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        if (!line) { continue; }
        const [name, peeled, direct] = line.split('\0');
        if (name && (peeled || direct)) { targets.set(name, peeled || direct); }
    }
    return targets;
}

function parseRemoteTagTargets(output: string): Map<string, string> {
    const direct = new Map<string, string>();
    const peeled = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        const [hash, ref] = line.trim().split(/\s+/, 2);
        if (!hash || !ref?.startsWith('refs/tags/')) { continue; }
        const isPeeled = ref.endsWith('^{}');
        const name = ref.slice('refs/tags/'.length, isPeeled ? -3 : undefined);
        if (!name) { continue; }
        (isPeeled ? peeled : direct).set(name, hash);
    }
    for (const [name, hash] of peeled) { direct.set(name, hash); }
    return direct;
}

/** Read local tags and live remote-tag availability for one commit. Failed remotes stay unavailable instead of being guessed. */
export async function readCommitTagState(rootUri: vscode.Uri, revision: string): Promise<CommitTagState> {
    const [resolved, localOutput, remoteOutput] = await Promise.all([
        invokeNativeGit<string[]>('resolveRevision', { rootPath: rootUri.fsPath, specs: [`${revision}^{commit}`] }),
        runGitCli(rootUri, ['for-each-ref', '--format=%(refname:strip=2)%00%(*objectname)%00%(objectname)', 'refs/tags']),
        runGitCli(rootUri, ['remote']),
    ]);
    const targetHash = resolved[0];
    if (!targetHash) { throw new Error('无法解析所选提交'); }
    const localTargets = parseLocalTagTargets(localOutput);
    const localTags = [...localTargets]
        .filter(([, hash]) => hash === targetHash)
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b));
    const remotes = remoteOutput.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const remoteErrors: Array<{ remote: string; message: string }> = [];
    const snapshots = (await Promise.all(remotes.map(async remote => {
        try {
            const output = await runGitCli(rootUri, ['ls-remote', '--tags', remote]);
            return { remote, targetsByName: parseRemoteTagTargets(output) } satisfies RemoteTagSnapshot;
        } catch (error) {
            remoteErrors.push({ remote, message: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }))).filter((value): value is RemoteTagSnapshot => Boolean(value));
    const remoteTags: RemoteTagRef[] = [];
    const pushableTags: RemoteTagRef[] = [];
    for (const snapshot of snapshots) {
        for (const [name, hash] of snapshot.targetsByName) {
            if (hash === targetHash) { remoteTags.push({ remote: snapshot.remote, name }); }
        }
        for (const name of localTags) {
            if (!snapshot.targetsByName.has(name)) { pushableTags.push({ remote: snapshot.remote, name }); }
        }
    }
    const compare = (a: RemoteTagRef, b: RemoteTagRef): number =>
        a.remote.localeCompare(b.remote) || a.name.localeCompare(b.name);
    remoteTags.sort(compare);
    pushableTags.sort(compare);
    return { localTags, remoteTags, pushableTags, remoteErrors };
}

export const deleteLocalTag = (rootUri: vscode.Uri, name: string): Promise<void> =>
    runGitCli(rootUri, ['tag', '--delete', '--', name]).then(() => undefined);
export const deleteRemoteTag = (rootUri: vscode.Uri, remote: string, name: string): Promise<void> =>
    runGitCli(rootUri, ['push', remote, `:refs/tags/${name}`]).then(() => undefined);
export const pushTag = (rootUri: vscode.Uri, remote: string, name: string): Promise<void> =>
    runGitCli(rootUri, ['push', remote, `refs/tags/${name}:refs/tags/${name}`]).then(() => undefined);
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
    const normalizedRoot = path.resolve(rootUri.fsPath);
    const repositoryKey = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
    const key = JSON.stringify([repositoryKey, remote ?? null]);
    const pending = pendingFetches.get(key);
    if (pending) { return pending; }
    // Submodules are discovered and fetched by the extension's parallel repository scheduler.
    // Keep Git from recursively fetching the same repositories again inside each parent Fetch.
    const cliArgs = remote
        ? ['fetch', '--prune', '--no-recurse-submodules', remote]
        : ['fetch', '--all', '--prune', '--no-recurse-submodules'];
    const task = runGitCli(rootUri, cliArgs).then(() => undefined).finally(() => {
        if (pendingFetches.get(key) === task) { pendingFetches.delete(key); }
    });
    pendingFetches.set(key, task);
    return task;
}

export interface NativePullOptions {
    /** 工作区有未提交改动时先暂存再还原; 否则 pull.rebase 会因脏工作区直接拒绝。 */
    readonly autostash?: boolean;
}

export function pull(
    rootUri: vscode.Uri,
    remote?: string,
    remoteBranch?: string,
    localBranch?: string,
    options: NativePullOptions = {},
): Promise<NativeSyncResult> {
    const cliArgs = ['pull'];
    if (options.autostash) { cliArgs.push('--autostash'); }
    if (remote) { cliArgs.push(remote); }
    if (remote && remoteBranch) { cliArgs.push(remoteBranch); }
    return runGitCli(rootUri, cliArgs).then(() => ({}));
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
    const cliArgs = ['push', request.remote, `HEAD:${request.remoteBranch}`];
    const requestedTarget: NativePushResult = {
        remote: request.remote,
        remoteBranch: request.remoteBranch,
        sourceBranchName: request.sourceBranchName,
        sourceHash,
    };
    return runGitCli(rootUri, cliArgs).then(output => ({ ...requestedTarget, output }));
}

export function updateSubmodules(rootUri: vscode.Uri, paths: readonly string[] = []): Promise<void> {
    return runGitCli(
        rootUri,
        ['submodule', 'update', '--init', '--recursive', ...(paths.length > 0 ? ['--', ...paths] : [])],
    ).then(() => undefined);
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
    author?: string;
    authorEmail?: string;
    authorDate?: string;
}

export async function resolveRevision(rootUri: vscode.Uri, spec: string): Promise<string | undefined> {
    const values = await invokeNativeGit<string[]>('resolveRevision', { rootPath: rootUri.fsPath, specs: [spec] });
    return values[0];
}
export const commitDetails = (rootUri: vscode.Uri, hashes: readonly string[]): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('commitDetails', { rootPath: rootUri.fsPath, hashes });
export const rangeCommits = (rootUri: vscode.Uri, from: string, to: string): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('rangeCommits', { rootPath: rootUri.fsPath, from, to });
