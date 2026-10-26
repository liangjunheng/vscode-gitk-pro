import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';

type IndexState = { readonly mode: string; readonly object: string } | undefined;
type WorktreeState =
    | { readonly kind: 'absent' }
    | { readonly kind: 'directory'; readonly mode: number }
    | { readonly kind: 'symlink'; readonly mode: number; readonly target: string }
    | { readonly kind: 'file'; readonly mode: number; readonly contentHash: string; readonly backup?: string };

type PathState = {
    readonly path: string;
    readonly index?: IndexState;
    readonly worktree: WorktreeState;
};

type CheckpointManifest = {
    readonly version: 1;
    readonly operationId: string;
    readonly createdAt: number;
    readonly pre: readonly PathState[];
    readonly post?: readonly PathState[];
};

const CHECKPOINT_DIRECTORY = 'fastergit-stash-checkpoints';
const OPERATION_ID_PATTERN = /^[0-9a-f-]{16,64}$/i;

function runGit(root: vscode.Uri, args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile('git', ['-C', root.fsPath, ...args], {
            windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        }, (error, stdout, stderr) => error
            ? reject(new Error([stdout, stderr].filter(Boolean).join('\n') || error.message))
            : resolve(stdout));
    });
}

function validateOperationId(operationId: string): string {
    if (!OPERATION_ID_PATTERN.test(operationId)) { throw new Error('Stash checkpoint operationId 无效。'); }
    return operationId;
}

function normalizePath(value: string): string {
    const normalized = value.replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/')
        || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Stash checkpoint 路径无效：${value}`);
    }
    return normalized;
}

export function canonicalStashPath(value: string): string {
    const normalized = normalizePath(value).normalize('NFC');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function checkpointRoot(root: vscode.Uri): Promise<string> {
    const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: root.fsPath });
    return path.join(gitDir, CHECKPOINT_DIRECTORY);
}

async function checkpointDirectory(root: vscode.Uri, operationId: string): Promise<string> {
    return path.join(await checkpointRoot(root), validateOperationId(operationId));
}

function absoluteRepositoryPath(root: vscode.Uri, relativePath: string): string {
    const base = path.resolve(root.fsPath);
    const absolute = path.resolve(base, ...normalizePath(relativePath).split('/'));
    const relative = path.relative(base, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`拒绝访问仓库外路径：${relativePath}`);
    }
    return absolute;
}

async function assertResolvedParentInsideRepository(root: vscode.Uri, absolute: string, relativePath: string): Promise<void> {
    const repositoryRealPath = await fs.realpath(root.fsPath);
    let ancestor = path.dirname(absolute);
    while (true) {
        try { ancestor = await fs.realpath(ancestor); break; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) { throw new Error(`无法验证 Stash 路径：${relativePath}`); }
            ancestor = parent;
        }
    }
    const relative = path.relative(repositoryRealPath, ancestor);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`拒绝通过 symlink/junction 访问仓库外路径：${relativePath}`);
    }
}

async function durableWrite(filePath: string, contents: string | Buffer): Promise<void> {
    const handle = await fs.open(filePath, 'w');
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
}

function backupName(filePath: string): string {
    return createHash('sha256').update(filePath).digest('hex');
}

function hashFile(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function indexStates(root: vscode.Uri, paths: readonly string[]): Promise<Map<string, IndexState>> {
    const states = new Map<string, IndexState>();
    paths.forEach(filePath => states.set(canonicalStashPath(filePath), undefined));
    if (paths.length === 0) { return states; }
    const output = await runGit(root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths]);
    for (const entry of output.split('\0').filter(Boolean)) {
        const separator = entry.indexOf('\t');
        if (separator < 0) { continue; }
        const [mode, object, stageValue] = entry.slice(0, separator).split(' ');
        if (stageValue !== '0' || !/^[0-9a-f]{40,64}$/i.test(object)) { continue; }
        states.set(canonicalStashPath(entry.slice(separator + 1)), { mode, object });
    }
    return states;
}

async function worktreeState(root: vscode.Uri, filePath: string, backupDirectory?: string): Promise<WorktreeState> {
    const absolute = absoluteRepositoryPath(root, filePath);
    let info;
    try { info = await fs.lstat(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { kind: 'absent' }; }
        throw error;
    }
    if (info.isSymbolicLink()) { return { kind: 'symlink', mode: info.mode, target: await fs.readlink(absolute) }; }
    if (info.isDirectory()) { return { kind: 'directory', mode: info.mode }; }
    if (!info.isFile()) { throw new Error(`不支持的工作区文件类型：${filePath}`); }
    if (!backupDirectory) { return { kind: 'file', mode: info.mode, contentHash: await hashFile(absolute) }; }
    const backup = backupName(filePath);
    const backupPath = path.join(backupDirectory, backup);
    await fs.copyFile(absolute, backupPath);
    const handle = await fs.open(backupPath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return { kind: 'file', mode: info.mode, contentHash: await hashFile(backupPath), backup };
}

async function captureStates(root: vscode.Uri, paths: readonly string[], backupDirectory?: string): Promise<PathState[]> {
    const normalized = [...new Map(paths.map(filePath => [canonicalStashPath(filePath), normalizePath(filePath)])).values()].sort();
    const indexes = await indexStates(root, normalized);
    const states: PathState[] = [];
    for (const filePath of normalized) {
        states.push({ path: filePath, index: indexes.get(canonicalStashPath(filePath)), worktree: await worktreeState(root, filePath, backupDirectory) });
    }
    return states;
}

async function readManifest(root: vscode.Uri, operationId: string): Promise<{ directory: string; manifest: CheckpointManifest }> {
    const directory = await checkpointDirectory(root, operationId);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as CheckpointManifest;
    if (manifest.version !== 1 || manifest.operationId !== operationId || !Array.isArray(manifest.pre)) {
        throw new Error('Stash checkpoint 已损坏。');
    }
    return { directory, manifest };
}

async function writeManifest(directory: string, manifest: CheckpointManifest): Promise<void> {
    const temporary = path.join(directory, `manifest.${process.pid}.${Date.now()}.tmp`);
    await durableWrite(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`);
    await fs.rename(temporary, path.join(directory, 'manifest.json'));
}

export async function createStashCheckpoint(root: vscode.Uri, operationId: string, paths: readonly string[]): Promise<void> {
    const rootDirectory = await checkpointRoot(root);
    await fs.mkdir(rootDirectory, { recursive: true });
    const finalDirectory = path.join(rootDirectory, validateOperationId(operationId));
    await fs.mkdir(path.join(finalDirectory, 'files'), { recursive: true });
    try {
        const pre = await captureStates(root, paths, path.join(finalDirectory, 'files'));
        const manifest: CheckpointManifest = { version: 1, operationId, createdAt: Date.now(), pre };
        // The marker is written only after this durable manifest exists, so an interrupted
        // checkpoint remains an unreachable orphan instead of an actionable partial state.
        await durableWrite(path.join(finalDirectory, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
    } catch (error) {
        await fs.rm(finalDirectory, { recursive: true, force: true });
        throw error;
    }
}

export async function captureStashCheckpointPostState(root: vscode.Uri, operationId: string, paths: readonly string[]): Promise<void> {
    const { directory, manifest } = await readManifest(root, operationId);
    const post = await captureStates(root, paths);
    await writeManifest(directory, { ...manifest, post });
}

function sameIndex(left: IndexState, right: IndexState): boolean {
    return left?.mode === right?.mode && left?.object === right?.object;
}

function sameWorktree(left: WorktreeState, right: WorktreeState): boolean {
    if (left.kind !== right.kind) { return false; }
    if (left.kind === 'file' && right.kind === 'file') { return left.contentHash === right.contentHash; }
    if (left.kind === 'symlink' && right.kind === 'symlink') { return left.target === right.target; }
    return true;
}

async function safelyRemoveCurrent(absolute: string): Promise<void> {
    let info;
    try { info = await fs.lstat(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
        throw error;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) {
        try { await fs.rmdir(absolute); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') { throw new Error(`拒绝删除非空目录：${absolute}`); }
            throw error;
        }
    } else { await fs.unlink(absolute); }
}

async function restoreWorktreeState(root: vscode.Uri, directory: string, state: PathState): Promise<void> {
    const absolute = absoluteRepositoryPath(root, state.path);
    if (state.worktree.kind === 'directory') { await fs.mkdir(absolute, { recursive: true }); return; }
    await safelyRemoveCurrent(absolute);
    if (state.worktree.kind === 'absent') { return; }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    if (state.worktree.kind === 'symlink') { await fs.symlink(state.worktree.target, absolute); return; }
    if (!state.worktree.backup) { throw new Error(`Stash checkpoint 缺少文件备份：${state.path}`); }
    const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    await fs.copyFile(path.join(directory, 'files', state.worktree.backup), temporary);
    await fs.chmod(temporary, state.worktree.mode);
    await fs.rename(temporary, absolute);
}

async function restoreIndexState(root: vscode.Uri, state: PathState): Promise<void> {
    if (state.index) {
        await runGit(root, ['update-index', '--add', '--cacheinfo', `${state.index.mode},${state.index.object},${state.path}`]);
    } else {
        await runGit(root, ['--literal-pathspecs', 'update-index', '--force-remove', '--', state.path]);
    }
}

export async function validateStashCheckpointPostState(
    root: vscode.Uri, operationId: string, paths: readonly string[], conflictPaths: readonly string[],
): Promise<void> {
    const { manifest } = await readManifest(root, operationId);
    if (!manifest.post) { return; }
    const post = new Map(manifest.post.map(state => [canonicalStashPath(state.path), state]));
    const conflicts = new Set(conflictPaths.map(canonicalStashPath));
    const current = await captureStates(root, paths);
    const changed = current.filter(state => {
        const key = canonicalStashPath(state.path);
        if (conflicts.has(key)) { return false; }
        const expected = post.get(key);
        return expected ? !sameIndex(state.index, expected.index) || !sameWorktree(state.worktree, expected.worktree) : false;
    }).map(state => state.path);
    if (changed.length > 0) { throw new Error(`中止前检测到新的本地修改，已拒绝覆盖：${changed.join('、')}`); }
}

export async function restoreStashCheckpoint(
    root: vscode.Uri, operationId: string, paths: readonly string[],
): Promise<readonly string[]> {
    const { directory, manifest } = await readManifest(root, operationId);
    const pre = new Map(manifest.pre.map(state => [canonicalStashPath(state.path), state]));
    const missing: string[] = [];
    for (const filePath of paths) {
        const state = pre.get(canonicalStashPath(filePath));
        if (!state) { missing.push(filePath); continue; }
        await restoreWorktreeState(root, directory, state);
        await restoreIndexState(root, state);
    }
    return missing;
}

export async function pruneStashCheckpoints(root: vscode.Uri, keepOperationId?: string): Promise<void> {
    const directory = await checkpointRoot(root);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
        throw error;
    }
    await Promise.all(entries
        .filter(entry => entry.isDirectory() && entry.name !== keepOperationId && OPERATION_ID_PATTERN.test(entry.name))
        .map(entry => fs.rm(path.join(directory, entry.name), { recursive: true, force: true })));
}

export async function removeStashCheckpoint(root: vscode.Uri, operationId: string): Promise<void> {
    await fs.rm(await checkpointDirectory(root, operationId), { recursive: true, force: true });
}

export async function stashCheckpointExists(root: vscode.Uri, operationId: string): Promise<boolean> {
    return fs.access(await checkpointDirectory(root, operationId)).then(() => true, () => false);
}
