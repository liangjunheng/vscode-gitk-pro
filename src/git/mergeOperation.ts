import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';
import {
    captureStashCheckpointPostState,
    createStashCheckpoint,
    pruneStashCheckpoints,
    removeStashCheckpoint,
    restoreStashCheckpoint,
    stashCheckpointExists,
    validateStashCheckpointPostState,
} from './stashOperationCheckpoint';

export type StashMergeOperation = 'stash-apply' | 'stash-pop';
export type MergeOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | StashMergeOperation;
export type StashOperationPhase = 'applying' | 'conflicted' | 'finishing' | 'aborting';

export type StashOperationHandle = {
    readonly operationId: string;
    readonly action: StashMergeOperation;
    readonly stash: string;
};

type StashOperationMarker = {
    readonly version: 3;
    readonly action: StashMergeOperation;
    readonly phase: StashOperationPhase;
    readonly stash: string;
    readonly head: string;
    readonly paths: readonly string[];
    readonly conflictPaths: readonly string[];
    readonly operationId?: string;
    readonly processId?: number;
    readonly startedAt?: number;
};

type TreeEntry = { readonly mode: string; readonly object: string };

const STASH_OPERATION_FILE = 'fastergit-stash-operation.json';
const HASH_PATTERN = /^[0-9a-f]{40,64}$/i;
const OPERATION_ID_PATTERN = /^[0-9a-f-]{16,64}$/i;

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

async function acquireStashOperationLock(root: vscode.Uri): Promise<() => Promise<void>> {
    const lockPath = `${await stashOperationPath(root)}.lock`;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8');
            await handle.sync();
            return async () => {
                await handle.close();
                await fs.unlink(lockPath).catch(error => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
                });
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            const info = await fs.stat(lockPath).catch(() => undefined);
            if (info && Date.now() - info.mtimeMs > 30_000) {
                await fs.unlink(lockPath).catch(() => undefined);
                continue;
            }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    throw new Error('另一个 FasterGit 窗口正在更新 Stash 操作状态，请稍后重试。');
}

function normalizeStashPath(value: unknown): string {
    if (typeof value !== 'string') { throw new Error(`Stash 冲突记录包含无效路径：${String(value)}`); }
    const normalized = value.replace(/\\/g, '/').normalize('NFC');
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/')
        || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Stash 冲突记录包含无效路径：${String(value)}`);
    }
    return normalized;
}

function normalizePaths(paths: readonly unknown[]): string[] {
    const values = new Map<string, string>();
    for (const value of paths) {
        const normalized = normalizeStashPath(value);
        const key = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
        if (!values.has(key)) { values.set(key, normalized); }
    }
    return [...values.values()].sort();
}

function parseStashOperation(value: unknown): StashOperationMarker {
    const marker = value as {
        readonly version?: unknown;
        readonly action?: unknown;
        readonly phase?: unknown;
        readonly stash?: unknown;
        readonly head?: unknown;
        readonly paths?: unknown;
        readonly conflictPaths?: unknown;
        readonly operationId?: unknown;
        readonly processId?: unknown;
        readonly startedAt?: unknown;
    } | undefined;
    const phase = marker?.version === 1
        ? 'conflicted'
        : (marker?.version === 2 || marker?.version === 3)
            && (marker.phase === 'applying' || marker.phase === 'conflicted'
                || marker.phase === 'finishing' || marker.phase === 'aborting')
            ? marker.phase
            : undefined;
    if (!marker
        || !phase
        || (marker.action !== 'stash-apply' && marker.action !== 'stash-pop')
        || typeof marker.stash !== 'string' || !HASH_PATTERN.test(marker.stash)
        || typeof marker.head !== 'string' || !HASH_PATTERN.test(marker.head)
        || !Array.isArray(marker.paths) || marker.paths.length === 0) {
        throw new Error('Stash 冲突操作记录已损坏，无法安全继续或中止。');
    }
    const operationId = typeof marker.operationId === 'string' && OPERATION_ID_PATTERN.test(marker.operationId)
        ? marker.operationId
        : undefined;
    const conflictPaths = Array.isArray(marker.conflictPaths) ? normalizePaths(marker.conflictPaths) : [];
    return {
        version: 3,
        action: marker.action,
        phase,
        stash: marker.stash,
        head: marker.head,
        paths: normalizePaths(marker.paths),
        conflictPaths,
        operationId,
        processId: typeof marker.processId === 'number' ? marker.processId : undefined,
        startedAt: typeof marker.startedAt === 'number' ? marker.startedAt : undefined,
    };
}

async function readMarkerFile(root: vscode.Uri): Promise<StashOperationMarker | undefined> {
    const markerPath = await stashOperationPath(root);
    let contents: string;
    try { contents = await fs.readFile(markerPath, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
        throw error;
    }
    try { return parseStashOperation(JSON.parse(contents)); } catch (error) {
        throw new Error(`读取 Stash 冲突操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

async function writeMarkerFile(root: vscode.Uri, marker: StashOperationMarker): Promise<void> {
    const markerPath = await stashOperationPath(root);
    const temporaryPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(temporaryPath, 'w');
    try { await handle.writeFile(`${JSON.stringify(marker, undefined, 2)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporaryPath, markerPath); }
    finally {
        await fs.unlink(temporaryPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        });
    }
}

async function readStashOperation(root: vscode.Uri): Promise<StashOperationMarker | undefined> {
    const marker = await readMarkerFile(root);
    if (!marker) { return undefined; }
    const currentHead = await resolveHead(root);
    if (currentHead !== marker.head) {
        if (marker.phase === 'applying' && marker.processId !== process.pid) { return marker; }
        throw new Error('Stash 冲突操作记录对应的 HEAD 已改变。恢复记录已保留，请确认当前仓库状态后再继续。');
    }
    return marker;
}

export async function clearStashOperation(root: vscode.Uri, expectedOperationId?: string): Promise<void> {
    const marker = await readMarkerFile(root);
    if (expectedOperationId && marker?.operationId !== expectedOperationId) {
        throw new Error('Stash 操作 token 已改变，拒绝清理其他操作的记录。');
    }
    const markerPath = await stashOperationPath(root);
    await fs.unlink(markerPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    });
    if (marker?.operationId) {
        await removeStashCheckpoint(root, marker.operationId).catch(() => undefined);
    }
}

export async function beginStashOperation(
    root: vscode.Uri,
    action: StashMergeOperation,
    stash: string,
    head: string,
    paths: readonly string[],
    checkpointPaths: readonly string[] = paths,
): Promise<StashOperationHandle> {
    if (!HASH_PATTERN.test(stash) || !HASH_PATTERN.test(head)) {
        throw new Error('无法记录 Stash 操作：缺少有效的 Stash 或 HEAD。');
    }
    const releaseLock = await acquireStashOperationLock(root);
    try {
        if (await readMarkerFile(root)) { throw new Error('已有 Stash 操作正在处理，请刷新后重试。'); }
        await pruneStashCheckpoints(root);
        const normalizedPaths = normalizePaths(paths);
        if (normalizedPaths.length === 0) { throw new Error('无法记录 Stash 操作：没有受影响路径。'); }
        const operationId = randomUUID();
        await createStashCheckpoint(root, operationId, normalizePaths([...checkpointPaths, ...normalizedPaths]));
        const marker: StashOperationMarker = {
            version: 3, action, phase: 'applying', stash, head, paths: normalizedPaths, conflictPaths: [],
            operationId, processId: process.pid, startedAt: Date.now(),
        };
        try { await writeMarkerFile(root, marker); }
        catch (error) { await removeStashCheckpoint(root, operationId).catch(() => undefined); throw error; }
        return { operationId, action, stash };
    } finally {
        await releaseLock();
    }
}

export async function markStashOperationConflicted(
    root: vscode.Uri,
    handle: StashOperationHandle,
    paths: readonly string[],
    conflictPaths: readonly string[],
): Promise<void> {
    const marker = await readStashOperation(root);
    if (!marker || marker.operationId !== handle.operationId || marker.action !== handle.action || marker.stash !== handle.stash) {
        throw new Error('Stash 操作 token 已改变，拒绝发布过期的冲突结果。');
    }
    const normalizedPaths = normalizePaths(paths);
    const normalizedConflicts = normalizePaths(conflictPaths);
    await captureStashCheckpointPostState(root, handle.operationId, normalizedPaths);
    await writeMarkerFile(root, { ...marker, phase: 'conflicted', paths: normalizedPaths, conflictPaths: normalizedConflicts });
}

/** Compatibility helper for tests and recovery of an old conflict that has no checkpoint. */
export async function writeStashOperation(
    root: vscode.Uri,
    action: StashMergeOperation,
    stash: string,
    head: string,
    paths: readonly string[],
    phase: 'applying' | 'conflicted' = 'conflicted',
): Promise<string> {
    if (phase === 'applying') {
        return (await beginStashOperation(root, action, stash, head, paths)).operationId;
    }
    const current = await readMarkerFile(root);
    if (current?.operationId && current.action === action && current.stash === stash && current.head === head) {
        await markStashOperationConflicted(root, { operationId: current.operationId, action, stash }, paths, []);
        return current.operationId;
    }
    if (!HASH_PATTERN.test(stash) || !HASH_PATTERN.test(head)) {
        throw new Error('无法记录 Stash 冲突操作：缺少有效的 Stash 或 HEAD。');
    }
    const operationId = randomUUID();
    await writeMarkerFile(root, {
        version: 3, action, phase: 'conflicted', stash, head,
        paths: normalizePaths(paths), conflictPaths: [], operationId,
        processId: process.pid, startedAt: Date.now(),
    });
    return operationId;
}

export type RecoveredStashConflict = {
    readonly stash: string;
    readonly conflictPaths: readonly string[];
};

function parseUnmergedPaths(output: string): Map<string, Map<number, TreeEntry>> {
    const paths = new Map<string, Map<number, TreeEntry>>();
    for (const entry of output.split('\0').filter(Boolean)) {
        const separator = entry.indexOf('\t');
        if (separator < 0) { continue; }
        const [mode, object, stageValue] = entry.slice(0, separator).split(' ');
        const stage = Number(stageValue);
        if (!mode || !HASH_PATTERN.test(object) || !Number.isInteger(stage) || stage < 1 || stage > 3) { continue; }
        const filePath = normalizeStashPath(entry.slice(separator + 1));
        const stages = paths.get(filePath) ?? new Map<number, TreeEntry>();
        stages.set(stage, { mode, object });
        paths.set(filePath, stages);
    }
    return paths;
}

async function revisionEntries(root: vscode.Uri, revision: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
    const output = await runGit(root, ['--literal-pathspecs', 'ls-tree', '-z', revision, '--', ...paths]);
    const entries = new Map<string, TreeEntry>();
    for (const entry of output.split('\0').filter(Boolean)) {
        const separator = entry.indexOf('\t');
        if (separator < 0) { continue; }
        const [mode, , object] = entry.slice(0, separator).split(' ');
        if (!HASH_PATTERN.test(object)) { continue; }
        entries.set(normalizeStashPath(entry.slice(separator + 1)), { mode, object });
    }
    return entries;
}

function sameTreeEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
    return left?.mode === right?.mode && left?.object === right?.object;
}

/** Recover an old unrecorded Stash conflict only when its index stages identify one exact stash commit. */
export async function identifyStashConflict(root: vscode.Uri, stashHashes: readonly string[]): Promise<RecoveredStashConflict | undefined> {
    const unmerged = parseUnmergedPaths(await runGit(root, ['ls-files', '-u', '-z']));
    const conflictPaths = [...unmerged.keys()].sort();
    if (conflictPaths.length === 0) { return undefined; }
    const candidates = [...new Set(stashHashes.filter(hash => HASH_PATTERN.test(hash)))];
    const matches: string[] = [];
    for (const stash of candidates) {
        try {
            const [baseEntries, stashEntries, indexEntries] = await Promise.all([
                revisionEntries(root, `${stash}^1`, conflictPaths),
                revisionEntries(root, stash, conflictPaths),
                revisionEntries(root, `${stash}^2`, conflictPaths),
            ]);
            const matchesEveryConflict = conflictPaths.every(filePath => {
                const stages = unmerged.get(filePath)!;
                if (!sameTreeEntry(stages.get(1), baseEntries.get(filePath))) { return false; }
                return sameTreeEntry(stages.get(3), stashEntries.get(filePath))
                    || sameTreeEntry(stages.get(3), indexEntries.get(filePath));
            });
            if (matchesEveryConflict) { matches.push(stash); }
        } catch { /* Ignore stale or non-stash candidates. */ }
    }
    return matches.length === 1 ? { stash: matches[0], conflictPaths } : undefined;
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
        output.split('\0').filter(Boolean).forEach(filePath => tracked.add(normalizeStashPath(filePath)));
    }
    return tracked;
}

function absoluteRepositoryPath(root: vscode.Uri, relativePath: string): string {
    const base = path.resolve(root.fsPath);
    const absolute = path.resolve(base, ...normalizeStashPath(relativePath).split('/'));
    const relative = path.relative(base, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error(`拒绝在仓库外恢复路径：${relativePath}`);
    }
    return absolute;
}

async function removeStashCreatedPath(root: vscode.Uri, relativePath: string): Promise<void> {
    const absolute = absoluteRepositoryPath(root, relativePath);
    let info;
    try { info = await fs.lstat(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
        throw error;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) {
        try { await fs.rmdir(absolute); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
                throw new Error(`无法中止 Stash：${relativePath} 是本次操作创建的目录，但其中已有其他文件。`);
            }
            throw error;
        }
    } else { await fs.unlink(absolute); }
}

async function abortPathsToHead(root: vscode.Uri, head: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) { return; }
    const tracked = await pathsTrackedAt(root, head, paths);
    for (const batch of pathBatches(paths)) {
        await runGit(root, ['--literal-pathspecs', 'reset', '--quiet', head, '--', ...batch]);
    }
    const trackedPaths = paths.filter(filePath => tracked.has(filePath));
    for (const batch of pathBatches(trackedPaths)) {
        await runGit(root, ['--literal-pathspecs', 'checkout', head, '--', ...batch]);
    }
    for (const filePath of paths) {
        if (!tracked.has(filePath)) { await removeStashCreatedPath(root, filePath); }
    }
}

async function stashExists(root: vscode.Uri, stash: string): Promise<boolean> {
    const hashes = (await runGit(root, ['stash', 'list', '--format=%H'])).split(/\r?\n/).filter(Boolean);
    return hashes.includes(stash);
}

async function transitionMarker(root: vscode.Uri, marker: StashOperationMarker, phase: StashOperationPhase): Promise<StashOperationMarker> {
    const current = await readStashOperation(root);
    if (!current || current.operationId !== marker.operationId || current.action !== marker.action || current.stash !== marker.stash) {
        throw new Error('Stash 操作 token 已改变，请刷新后重试。');
    }
    const next = { ...current, phase };
    await writeMarkerFile(root, next);
    return next;
}

export async function readMergeOperation(root: vscode.Uri, includeApplying = true): Promise<MergeOperation | undefined> {
    const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: root.fsPath });
    const exists = async (name: string) => fs.access(path.join(gitDir, name)).then(() => true, () => false);
    const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
        ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(exists));
    if (rebaseMerge || rebaseApply) { return 'rebase'; }
    if (merge) { return 'merge'; }
    if (cherryPick) { return 'cherry-pick'; }
    if (revert) { return 'revert'; }
    const stash = await readStashOperation(root);
    if (stash?.phase === 'applying' && stash.processId !== process.pid) {
        const hasConflicts = await invokeNativeGit<boolean>('hasConflicts', { rootPath: root.fsPath });
        if (!hasConflicts) {
            await clearStashOperation(root, stash.operationId);
            return undefined;
        }
    }
    return stash && (includeApplying || stash.phase !== 'applying') ? stash.action : undefined;
}

/** Use Git's sequencer for native operations and a durable path checkpoint for Stash conflicts. */
export async function runMergeOperation(root: vscode.Uri, expected: MergeOperation, action: 'continue' | 'abort'): Promise<void> {
    if (await readMergeOperation(root) !== expected) { throw new Error('当前冲突操作已改变，请刷新后重试。'); }
    if (action === 'continue' && await invokeNativeGit<boolean>('hasConflicts', { rootPath: root.fsPath })) {
        throw new Error('请先保存并暂存所有已解决的冲突，再继续。');
    }
    if (expected !== 'stash-apply' && expected !== 'stash-pop') {
        await runGit(root, [expected, `--${action}`], true);
        return;
    }
    let marker = await readStashOperation(root);
    if (!marker || marker.action !== expected) { throw new Error('当前 Stash 冲突操作已改变，请刷新后重试。'); }
    if (marker.phase === 'applying') {
        throw new Error('Stash 操作的执行结果尚未确认，不能继续或中止。请等待当前操作完成并刷新仓库状态。');
    }
    if (action === 'continue') {
        if (marker.phase === 'aborting') { throw new Error('Stash 中止操作正在恢复，不能同时完成。'); }
        if (marker.phase !== 'finishing') { marker = await transitionMarker(root, marker, 'finishing'); }
        if (expected === 'stash-pop' && await stashExists(root, marker.stash)) {
            await invokeNativeGit('stashDrop', { rootPath: root.fsPath, stash: marker.stash });
        }
        await clearStashOperation(root, marker.operationId);
        return;
    }
    if (marker.phase === 'finishing') { throw new Error('Stash 完成操作正在处理，不能同时中止。'); }
    const hasCheckpoint = marker.operationId ? await stashCheckpointExists(root, marker.operationId) : false;
    if (hasCheckpoint && marker.phase === 'conflicted') {
        await validateStashCheckpointPostState(root, marker.operationId!, marker.paths, marker.conflictPaths);
    }
    if (marker.phase !== 'aborting') { marker = await transitionMarker(root, marker, 'aborting'); }
    let fallbackPaths = marker.paths;
    if (hasCheckpoint) {
        fallbackPaths = [...await restoreStashCheckpoint(root, marker.operationId!, marker.paths)];
    }
    await abortPathsToHead(root, marker.head, fallbackPaths);
    await clearStashOperation(root, marker.operationId);
}
