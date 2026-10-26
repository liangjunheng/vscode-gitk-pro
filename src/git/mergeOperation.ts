import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';

export type StashMergeOperation = 'stash-apply' | 'stash-pop';
export type MergeOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | StashMergeOperation;

type StashOperationMarker = {
    readonly version: 1;
    readonly action: StashMergeOperation;
    readonly stash: string;
    readonly head: string;
    readonly paths: readonly string[];
};

const STASH_OPERATION_FILE = 'fastergit-stash-operation.json';
const HASH_PATTERN = /^[0-9a-f]{40,64}$/i;

function runGit(root: vscode.Uri, args: readonly string[], editor = false): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile('git', ['-C', root.fsPath, ...args], {
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            env: editor ? { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } : process.env,
        }, (error, stdout, stderr) => error
            ? reject(new Error([stdout, stderr].filter(Boolean).join('\n') || error.message))
            : resolve(stdout));
    });
}

async function resolveHead(root: vscode.Uri): Promise<string | undefined> {
    const values = await invokeNativeGit<string[]>('resolveRevision', {
        rootPath: root.fsPath,
        specs: ['HEAD^{commit}'],
    });
    return values[0];
}

async function stashOperationPath(root: vscode.Uri): Promise<string> {
    const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: root.fsPath });
    return path.join(gitDir, STASH_OPERATION_FILE);
}

function normalizeStashPath(value: unknown): string {
    if (typeof value !== 'string'
        || value.length === 0
        || value.includes('\\')
        || value.startsWith('/')
        || value.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
        throw new Error(`Stash 冲突记录包含无效路径：${String(value)}`);
    }
    return value;
}

function parseStashOperation(value: unknown): StashOperationMarker {
    const marker = value as Partial<StashOperationMarker> | undefined;
    if (!marker
        || marker.version !== 1
        || (marker.action !== 'stash-apply' && marker.action !== 'stash-pop')
        || typeof marker.stash !== 'string' || !HASH_PATTERN.test(marker.stash)
        || typeof marker.head !== 'string' || !HASH_PATTERN.test(marker.head)
        || !Array.isArray(marker.paths) || marker.paths.length === 0) {
        throw new Error('Stash 冲突操作记录已损坏，无法安全继续或中止。');
    }
    const paths = [...new Set(marker.paths.map(normalizeStashPath))].sort();
    return { version: 1, action: marker.action, stash: marker.stash, head: marker.head, paths };
}

async function clearStashOperation(root: vscode.Uri): Promise<void> {
    const markerPath = await stashOperationPath(root);
    await fs.unlink(markerPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    });
}

async function readStashOperation(root: vscode.Uri): Promise<StashOperationMarker | undefined> {
    const markerPath = await stashOperationPath(root);
    let contents: string;
    try {
        contents = await fs.readFile(markerPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
        throw error;
    }
    let marker: StashOperationMarker;
    try {
        marker = parseStashOperation(JSON.parse(contents));
    } catch (error) {
        throw new Error(`读取 Stash 冲突操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const currentHead = await resolveHead(root);
    if (currentHead !== marker.head) {
        await clearStashOperation(root);
        return undefined;
    }
    return marker;
}

export async function writeStashOperation(
    root: vscode.Uri,
    action: StashMergeOperation,
    stash: string,
    head: string,
    paths: readonly string[],
): Promise<void> {
    if (!HASH_PATTERN.test(stash) || !HASH_PATTERN.test(head)) {
        throw new Error('无法记录 Stash 冲突操作：缺少有效的 Stash 或 HEAD。');
    }
    const normalizedPaths = [...new Set(paths.map(normalizeStashPath))].sort();
    if (normalizedPaths.length === 0) {
        throw new Error('无法记录 Stash 冲突操作：没有受影响路径。');
    }
    const marker: StashOperationMarker = { version: 1, action, stash, head, paths: normalizedPaths };
    const markerPath = await stashOperationPath(root);
    const temporaryPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(marker, undefined, 2)}\n`, 'utf8');
        await fs.rename(temporaryPath, markerPath);
    } finally {
        await fs.unlink(temporaryPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        });
    }
}

export function describeMergeOperation(operation: MergeOperation): string {
    if (operation === 'stash-apply') { return 'Stash Apply'; }
    if (operation === 'stash-pop') { return 'Stash Pop'; }
    return operation;
}

function pathBatches(paths: readonly string[]): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let length = 0;
    for (const filePath of paths) {
        if (current.length > 0 && length + filePath.length + 1 > 12_000) {
            batches.push(current);
            current = [];
            length = 0;
        }
        current.push(filePath);
        length += filePath.length + 1;
    }
    if (current.length > 0) { batches.push(current); }
    return batches;
}

async function pathsTrackedAt(root: vscode.Uri, revision: string, paths: readonly string[]): Promise<Set<string>> {
    const tracked = new Set<string>();
    for (const batch of pathBatches(paths)) {
        const output = await runGit(root, ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', revision, '--', ...batch]);
        output.split('\0').filter(Boolean).forEach(filePath => tracked.add(filePath.replace(/\\/g, '/')));
    }
    return tracked;
}

function absoluteRepositoryPath(root: vscode.Uri, relativePath: string): string {
    const base = path.resolve(root.fsPath);
    const absolute = path.resolve(base, ...relativePath.split('/'));
    const relative = path.relative(base, absolute);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error(`拒绝在仓库外恢复路径：${relativePath}`);
    }
    return absolute;
}

async function removeStashCreatedPath(root: vscode.Uri, relativePath: string): Promise<void> {
    const absolute = absoluteRepositoryPath(root, relativePath);
    let info;
    try {
        info = await fs.lstat(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
        throw error;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) {
        try {
            await fs.rmdir(absolute);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
                throw new Error(`无法中止 Stash：${relativePath} 是本次操作创建的目录，但其中已有其他文件。`);
            }
            throw error;
        }
    } else {
        await fs.unlink(absolute);
    }
}

async function abortStashOperation(root: vscode.Uri, marker: StashOperationMarker): Promise<void> {
    const tracked = await pathsTrackedAt(root, marker.head, marker.paths);
    for (const batch of pathBatches(marker.paths)) {
        await runGit(root, ['--literal-pathspecs', 'reset', '--quiet', marker.head, '--', ...batch]);
    }
    const trackedPaths = marker.paths.filter(filePath => tracked.has(filePath));
    for (const batch of pathBatches(trackedPaths)) {
        await runGit(root, ['--literal-pathspecs', 'checkout', marker.head, '--', ...batch]);
    }
    for (const filePath of marker.paths) {
        if (!tracked.has(filePath)) { await removeStashCreatedPath(root, filePath); }
    }
}

export async function readMergeOperation(root: vscode.Uri): Promise<MergeOperation | undefined> {
    const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: root.fsPath });
    const exists = async (name: string) => fs.access(path.join(gitDir, name)).then(() => true, () => false);
    const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
        ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(exists));
    if (rebaseMerge || rebaseApply) { return 'rebase'; }
    if (merge) { return 'merge'; }
    if (cherryPick) { return 'cherry-pick'; }
    if (revert) { return 'revert'; }
    return (await readStashOperation(root))?.action;
}

/** Use Git's sequencer for native operations and a path-scoped checkpoint for Stash conflicts. */
export async function runMergeOperation(root: vscode.Uri, expected: MergeOperation, action: 'continue' | 'abort'): Promise<void> {
    if (await readMergeOperation(root) !== expected) { throw new Error('当前冲突操作已改变，请刷新后重试。'); }
    if (action === 'continue' && await invokeNativeGit<boolean>('hasConflicts', { rootPath: root.fsPath })) {
        throw new Error('请先保存并暂存所有已解决的冲突，再继续。');
    }
    if (expected === 'stash-apply' || expected === 'stash-pop') {
        const marker = await readStashOperation(root);
        if (!marker || marker.action !== expected) { throw new Error('当前 Stash 冲突操作已改变，请刷新后重试。'); }
        if (action === 'abort') {
            await abortStashOperation(root, marker);
        } else if (expected === 'stash-pop') {
            await invokeNativeGit('stashDrop', { rootPath: root.fsPath, stash: marker.stash });
        }
        await clearStashOperation(root);
        return;
    }
    await runGit(root, [expected, `--${action}`], true);
}
