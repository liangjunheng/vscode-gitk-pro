import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { invokeNativeGit, invokeNativeGitMutation, invokeNativeGitPriorityRead } from './nativeGitBinding';

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
    try {
        return await invokeNativeGitPriorityRead<boolean>('explicitProxyConfigured', { rootPath: rootUri.fsPath });
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
    }
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
    if (isNetworkCommand(args)) {
        // The extension has no terminal: an interactive prompt can only fail with an opaque error.
        // Credential helpers (GCM, keychain, askpass) still run; only the TTY prompt is disabled.
        environment.GIT_TERMINAL_PROMPT = '0';
    }
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

/** Network Git commands get an upper bound so an unresponsive host cannot hang the operation forever. */
export const NETWORK_GIT_TIMEOUT_MS = 10 * 60 * 1000;

const AUTHENTICATION_FAILURE = /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|HTTP Basic: Access denied|returned error: 40[13]\b/i;

/** Translate a failed Git CLI run into a message the user can act on. Exported for tests. */
export function describeGitCliFailure(args: readonly string[], output: string, timedOut: boolean): string {
    if (timedOut) {
        return `Git 网络操作超过 ${NETWORK_GIT_TIMEOUT_MS / 60000} 分钟未完成，已终止。请检查网络或远程地址后重试。`;
    }
    if (isNetworkCommand(args) && AUTHENTICATION_FAILURE.test(output)) {
        return '远程仓库需要认证，但当前没有可用的凭据。请在终端对该仓库执行一次 git fetch 完成登录，'
            + `或配置 Git 凭据管理器 / SSH 密钥后重试。\n\nGit 输出：${output}`;
    }
    return `Git CLI 执行失败：${output}`;
}

async function runGitCli(rootUri: vscode.Uri, args: readonly string[]): Promise<string> {
    const env = await gitCliEnvironment(rootUri, args);
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', rootUri.fsPath, ...args], {
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env,
            timeout: isNetworkCommand(args) ? NETWORK_GIT_TIMEOUT_MS : 0,
        }, (error, stdout, stderr) => {
            const output = sanitizeGitOutput([stdout, stderr].filter(Boolean).join('\n'));
            if (!error) {
                resolve(output);
                return;
            }
            const timedOut = Boolean((error as { killed?: boolean }).killed) && isNetworkCommand(args);
            reject(new Error(describeGitCliFailure(args, output || error.message, timedOut)));
        });
    });
}

export interface NativeStatusSummary { hasStagedChanges: boolean; hasUnstagedChanges: boolean; }
export interface NativeSyncResult { changed?: boolean; fastForward?: boolean; }

export async function configGet(rootUri: vscode.Uri, key: string, defaultValue = ''): Promise<string> {
    return invokeNativeGitPriorityRead<string>('configGet', { rootPath: rootUri.fsPath, key, defaultValue });
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

export interface GitRemote {
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
}

interface NativeRemoteState {
    remotes: GitRemote[];
    operations: Record<string, Partial<Record<FasterGitRemoteOperation, boolean>>>;
    upstreamRemote: string;
}


/** Read remote metadata and local FasterGit operation settings through libgit2. */
export async function readNativeRemoteState(rootUri: vscode.Uri): Promise<{
    remotes: GitRemote[];
    operations: Map<string, Map<FasterGitRemoteOperation, boolean>>;
    upstreamRemote: string;
}> {
    const state = await invokeNativeGitPriorityRead<NativeRemoteState>('remoteState', { rootPath: rootUri.fsPath });
    const operations = new Map<string, Map<FasterGitRemoteOperation, boolean>>();
    for (const [name, values] of Object.entries(state.operations ?? {})) {
        const entries = Object.entries(values).filter(([operation]) => operation === 'fetch' || operation === 'pull');
        operations.set(name, new Map(entries as Array<[FasterGitRemoteOperation, boolean]>));
    }
    return { remotes: state.remotes, operations, upstreamRemote: state.upstreamRemote ?? '' };
}

function validateRemoteName(name: string): string {
    const value = name.trim();
    if (!value || value.startsWith('-') || /\s/.test(value)) {
        throw new Error('remote 名称不能为空、不能以 - 开头或包含空白字符');
    }
    return value;
}

function validateRemoteUrl(url: string): string {
    const value = url.trim();
    if (!value) { throw new Error('remote URL 不能为空'); }
    return value;
}

export type FasterGitRemoteOperation = 'fetch' | 'pull';

export async function readFasterGitRemoteOperations(
    rootUri: vscode.Uri,
    remotes: readonly string[],
): Promise<Map<string, Map<FasterGitRemoteOperation, boolean>>> {
    const operations = new Map<string, Map<FasterGitRemoteOperation, boolean>>();
    if (remotes.length === 0) { return operations; }
    try {
        const state = await readNativeRemoteState(rootUri);
        return new Map(remotes.filter(name => state.operations.has(name)).map(name => [name, state.operations.get(name)!]));
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
    }
    let output = '';
    try {
        output = await runGitCli(rootUri, ['config', '--local', '--get-regexp', '^fastergit\\.remote\\..+\\.(fetch|pull)$']);
    } catch {
        return operations;
    }
    // Git lowercases section/key names, but remote subsection names stay case-sensitive.
    const knownRemotes = new Set(remotes);
    for (const line of output.split(/\r?\n/)) {
        const separator = line.search(/\s/);
        if (separator < 0) { continue; }
        const key = line.slice(0, separator);
        const value = line.slice(separator).trim().toLowerCase();
        const enabled = ['true', 'yes', 'on', '1'].includes(value)
            ? true
            : ['false', 'no', 'off', '0'].includes(value) ? false : undefined;
        if (enabled === undefined) { continue; }
        const match = key.match(/^fastergit\.remote\.(.+)\.(fetch|pull)$/i);
        if (!match) { continue; }
        const remote = match[1];
        if (!knownRemotes.has(remote)) { continue; }
        const configured = operations.get(remote) ?? new Map<FasterGitRemoteOperation, boolean>();
        configured.set(match[2].toLowerCase() as FasterGitRemoteOperation, enabled);
        operations.set(remote, configured);
    }
    return operations;
}

export async function setFasterGitRemoteOperation(
    rootUri: vscode.Uri,
    remoteName: string,
    operation: FasterGitRemoteOperation,
    enabled: boolean,
): Promise<void> {
    const remote = validateRemoteName(remoteName);
    try {
        await invokeNativeGitMutation<void>('setRemoteOperation', {
            rootPath: rootUri.fsPath, remoteName: remote, operation, enabled,
        });
    } catch (error) {
        // Keep compatibility with an older installed native binary until it is rebuilt.
        if (!isUnsupportedNativeOperation(error)) { throw error; }
        const key = `fastergit.remote.${remote}.${operation}`;
        await runGitCli(rootUri, ['config', '--local', key, enabled ? 'true' : 'false']);
    }
}

export async function clearFasterGitRemoteOperations(rootUri: vscode.Uri, remoteName: string): Promise<void> {
    const remote = validateRemoteName(remoteName);
    try {
        await invokeNativeGitMutation<void>('clearRemoteOperations', { rootPath: rootUri.fsPath, remoteName: remote });
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
        // Remove the retired Push key as migration cleanup when a remote is deleted.
        for (const operation of ['fetch', 'pull', 'push']) {
            await runGitCli(rootUri, ['config', '--local', '--unset-all', `fastergit.remote.${remote}.${operation}`]).catch(() => undefined);
        }
    }
}

export async function listRemoteBranchesContaining(rootUri: vscode.Uri): Promise<string[]> {
    try {
        return await invokeNativeGitPriorityRead<string[]>('remoteBranchesContainingHead', { rootPath: rootUri.fsPath });
    } catch {
        // A stale native module may not expose the operation. Keep the previous
        // exact Git result instead of silently changing upstream selection.
        try {
            const output = await runGitCli(rootUri, ['for-each-ref', '--contains=HEAD', '--format=%(refname:short)', 'refs/remotes']);
            return output.split(/\r?\n/)
                .map(value => value.trim())
                .filter(value => Boolean(value) && !value.endsWith('/HEAD'));
        } catch {
            return [];
        }
    }
}

export async function listRemotes(rootUri: vscode.Uri): Promise<GitRemote[]> {
    try {
        return (await readNativeRemoteState(rootUri)).remotes.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
    }
    const output = await runGitCli(rootUri, ['remote', '-v']);
    const remotes = new Map<string, { fetchUrl: string; pushUrl: string }>();
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
        if (!match) { continue; }
        const [, name, url, direction] = match;
        const current = remotes.get(name) ?? { fetchUrl: '', pushUrl: '' };
        current[direction === 'fetch' ? 'fetchUrl' : 'pushUrl'] = url;
        remotes.set(name, current);
    }
    return [...remotes.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, urls]) => ({ name, fetchUrl: urls.fetchUrl || urls.pushUrl, pushUrl: urls.pushUrl || urls.fetchUrl }));
}

function isUnsupportedNativeOperation(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('不支持的 libgit2 操作')
        || /^invokeMutation 只允许修改操作: (addRemote|removeRemote|clearRemoteOperations|setRemoteOperation|deleteTag|checkoutRemoteBranch)$/.test(message);
}

export async function addRemote(rootUri: vscode.Uri, name: string, url: string): Promise<void> {
    const remoteName = validateRemoteName(name);
    const remoteUrl = validateRemoteUrl(url);
    try {
        await invokeNativeGitMutation<void>('addRemote', { rootPath: rootUri.fsPath, remoteName, url: remoteUrl });
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
        await runGitCli(rootUri, ['remote', 'add', remoteName, remoteUrl]);
    }
}

export async function removeRemote(rootUri: vscode.Uri, name: string): Promise<void> {
    const remoteName = validateRemoteName(name);
    try {
        await invokeNativeGitMutation<void>('removeRemote', { rootPath: rootUri.fsPath, remoteName });
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
        await clearFasterGitRemoteOperations(rootUri, remoteName);
        await runGitCli(rootUri, ['remote', 'remove', remoteName]);
    }
}

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
    const [resolved, local] = await Promise.all([
        invokeNativeGit<string[]>('resolveRevision', { rootPath: rootUri.fsPath, specs: [`${revision}^{commit}`] }),
        readLocalTagTargets(rootUri),
    ]);
    const targetHash = resolved[0];
    if (!targetHash) { throw new Error('无法解析所选提交'); }
    const localTags = [...local.targets]
        .filter(([, hash]) => hash === targetHash)
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b));
    const remotes = local.remotes;
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

/** Local tag targets and remote names; ls-remote for the live remote view stays on Git CLI. */
async function readLocalTagTargets(rootUri: vscode.Uri): Promise<{ targets: Map<string, string>; remotes: string[] }> {
    try {
        const state = await invokeNativeGitPriorityRead<{ tags: Record<string, string>; remotes: string[] }>('tagTargets', { rootPath: rootUri.fsPath });
        return { targets: new Map(Object.entries(state.tags)), remotes: state.remotes };
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
    }
    const [localOutput, remoteOutput] = await Promise.all([
        runGitCli(rootUri, ['for-each-ref', '--format=%(refname:strip=2)%00%(*objectname)%00%(objectname)', 'refs/tags']),
        runGitCli(rootUri, ['remote']),
    ]);
    return {
        targets: parseLocalTagTargets(localOutput),
        remotes: remoteOutput.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
    };
}

export async function deleteLocalTag(rootUri: vscode.Uri, name: string): Promise<void> {
    try {
        await invokeNativeGitMutation<void>('deleteTag', { rootPath: rootUri.fsPath, name });
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
        await runGitCli(rootUri, ['tag', '--delete', '--', name]);
    }
}
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

/** Create a local branch tracking a remote branch and switch to it with a safe checkout. */
export async function checkoutRemoteBranch(rootUri: vscode.Uri, remoteRef: string, localName: string): Promise<void> {
    if (!remoteRef.startsWith('refs/remotes/') || remoteRef.endsWith('/HEAD') || localName.startsWith('-')) {
        throw new Error('远程分支或本地分支名称无效');
    }
    try {
        await invokeNativeGitMutation<void>('checkoutRemoteBranch', { rootPath: rootUri.fsPath, remoteRef, localName });
        return;
    } catch (error) {
        if (!isUnsupportedNativeOperation(error)) { throw error; }
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

async function readDeclaredSubmodulePaths(rootUri: vscode.Uri): Promise<string[]> {
    let output: string;
    try {
        output = await runGitCli(rootUri, [
            'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$',
        ]);
    } catch {
        return [];
    }
    return output.split(/\r?\n/).flatMap(line => {
        const separator = line.search(/\s/);
        const submodulePath = separator < 0 ? '' : line.slice(separator).trim();
        return submodulePath ? [submodulePath] : [];
    });
}

async function isGitWorkingTree(rootUri: vscode.Uri): Promise<boolean> {
    try {
        return await runGitCli(rootUri, ['rev-parse', '--show-prefix']) === '';
    } catch {
        return false;
    }
}

async function localBranchExists(rootUri: vscode.Uri, branch: string): Promise<boolean> {
    try {
        await runGitCli(rootUri, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
        return true;
    } catch {
        return false;
    }
}

async function switchNewSubmoduleTreeToRemoteBranch(
    submoduleUri: vscode.Uri,
    visited: Set<string>,
): Promise<void> {
    const normalizedPath = path.resolve(submoduleUri.fsPath);
    const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    if (visited.has(key)) { return; }
    visited.add(key);
    if (!await isGitWorkingTree(submoduleUri)) { return; }

    await runGitCli(submoduleUri, ['fetch', 'origin', '--prune']);
    await runGitCli(submoduleUri, ['remote', 'set-head', 'origin', '--auto']);
    const remoteHead = await runGitCli(
        submoduleUri,
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    );
    if (!remoteHead.startsWith('origin/') || remoteHead.length <= 'origin/'.length) {
        throw new Error('无法确定子模块远程默认分支：' + submoduleUri.fsPath);
    }
    const branch = remoteHead.slice('origin/'.length);
    if (await localBranchExists(submoduleUri, branch)) {
        await runGitCli(submoduleUri, ['switch', branch]);
    } else {
        await runGitCli(submoduleUri, ['switch', '-c', branch, '--track', remoteHead]);
    }

    // The remote branch may declare a different nested-submodule topology.
    await runGitCli(submoduleUri, ['submodule', 'update', '--init', '--recursive']);
    for (const nestedPath of await readDeclaredSubmodulePaths(submoduleUri)) {
        await switchNewSubmoduleTreeToRemoteBranch(
            vscode.Uri.file(path.resolve(submoduleUri.fsPath, nestedPath)),
            visited,
        );
    }
}

export async function updateSubmodules(rootUri: vscode.Uri, paths: readonly string[] = []): Promise<void> {
    const requestedPaths = paths.length > 0 ? [...paths] : await readDeclaredSubmodulePaths(rootUri);
    const uninitializedPaths: string[] = [];
    for (const submodulePath of requestedPaths) {
        const submoduleUri = vscode.Uri.file(path.resolve(rootUri.fsPath, submodulePath));
        if (!await isGitWorkingTree(submoduleUri)) { uninitializedPaths.push(submodulePath); }
    }

    await runGitCli(
        rootUri,
        ['submodule', 'update', '--init', '--rebase', '--recursive', ...(paths.length > 0 ? ['--', ...paths] : [])],
    );

    const visited = new Set<string>();
    for (const submodulePath of uninitializedPaths) {
        await switchNewSubmoduleTreeToRemoteBranch(
            vscode.Uri.file(path.resolve(rootUri.fsPath, submodulePath)),
            visited,
        );
    }
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
export async function resolveRevisionPriority(rootUri: vscode.Uri, spec: string): Promise<string | undefined> {
    const values = await invokeNativeGitPriorityRead<string[]>('resolveRevision', { rootPath: rootUri.fsPath, specs: [spec] });
    return values[0];
}
export const commitDetails = (rootUri: vscode.Uri, hashes: readonly string[]): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('commitDetails', { rootPath: rootUri.fsPath, hashes });
export const commitDetailsPriority = (rootUri: vscode.Uri, hashes: readonly string[]): Promise<NativeCommitDetails[]> =>
    invokeNativeGitPriorityRead<NativeCommitDetails[]>('commitDetails', { rootPath: rootUri.fsPath, hashes });
export const rangeCommits = (rootUri: vscode.Uri, from: string, to: string): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('rangeCommits', { rootPath: rootUri.fsPath, from, to });
export const rangeCommitsPriority = (rootUri: vscode.Uri, from: string, to: string): Promise<NativeCommitDetails[]> =>
    invokeNativeGitPriorityRead<NativeCommitDetails[]>('rangeCommits', { rootPath: rootUri.fsPath, from, to });
