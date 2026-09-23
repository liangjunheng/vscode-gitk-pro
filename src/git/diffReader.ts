import * as vscode from 'vscode';
import * as path from 'path';
import { DiffPayload, type ChangeSetMode, type CommitFile } from '../types';
import { store } from '../state/store';
import type { GitBackend } from './gitBackend';

// libgit2 对象读取层已把内容解码为 UTF-8 字符串；二进制内容会含 NUL 字符，只探测前若干字符即可判定。
const MAX_WORKTREE_READ_CONCURRENCY = 64;

function containsNul(text: string | undefined): boolean {
    if (!text) { return false; }
    const limit = Math.min(text.length, 8000);
    for (let i = 0; i < limit; i++) {
        if (text.charCodeAt(i) === 0) { return true; }
    }
    return false;
}

/**
 * Diff 读取器: 负责从 Git 仓库读取文件内容并写入 Store (单一数据源)
 *
 * 流程:
 * 1. 通过异步 libgit2 原生后端批量读取对象
 * 2. 原生任务在线程池执行，避免阻塞扩展宿主与重复启动外部进程
 * 3. stop() 只推进代次门禁，阻止旧结果落地
 * 4. 全部完成后一次性写回 store.files 并结束 diffLoading
 */
export class DiffReader {
    private requestGeneration = 0;

    constructor(private readonly gitBackend: GitBackend) {}

    /** 使旧读取结果失效；已提交的原生任务完成后会被代次门禁丢弃。 */
    stop(): void {
        this.requestGeneration++;
    }

    dispose(): void {
        this.requestGeneration++;
    }

    /** 后台完成 libgit2 原生模块与对象库冷启动。 */
    warmup(rootUri: vscode.Uri): Promise<void> {
        return this.gitBackend.warmup(rootUri);
    }

    /** 单个长驻 git cat-file 读取整轮对象，每完成 32 个文件更新进度 */
    async prepare(rootUri: vscode.Uri, hash: string, files: CommitFile[], changeSetMode: ChangeSetMode, generation: number): Promise<void> {
        const readerGeneration = ++this.requestGeneration;
        const isCurrent = () => readerGeneration === this.requestGeneration && generation === store.getState().diffGeneration;
        const total = files.length;
        try {
            store.setState({ diffProgress: { completed: 0, total } });
            const onProgress = (completed: number) => {
                if (!isCurrent()) { return; }
                store.setState({ diffProgress: { completed, total } });
            };
            const data = changeSetMode === 'commit'
                ? await this.readCommitDiffsStreaming(rootUri, hash, files, isCurrent, onProgress)
                : await this.readWorkingTreeDiffsStreaming(rootUri, files, changeSetMode, isCurrent, onProgress);
            if (!isCurrent()) { return; }
            store.setState({ files: data, diffLoading: false });
        } catch (error) {
            if (!isCurrent()) { return; }
            const message = error instanceof Error ? error.message : String(error);
            store.setState({ diffError: message, diffLoading: false });
        }
    }

    private async readCommitDiffsStreaming(
        rootUri: vscode.Uri,
        hash: string,
        files: CommitFile[],
        isCurrent: () => boolean,
        onProgress: (completed: number) => void,
    ): Promise<DiffPayload[]> {
        const objects = files.flatMap(file => {
            if (file.isBinary || file.isGitlink) { return []; }
            const refs: string[] = [];
            if (file.status !== 'A') { refs.push(this.objectRef(file.oldObjectId, `${hash}^:${file.oldPath || file.path}`)); }
            if (file.status !== 'D') { refs.push(this.objectRef(file.newObjectId, `${hash}:${file.path}`)); }
            return refs;
        });
        const contents = await this.readGitObjectsStreaming(rootUri, objects);
        if (!isCurrent()) { return []; }
        onProgress(files.length);
        return this.createCommitPayloads(rootUri, hash, files, contents);
    }

    private async readWorkingTreeDiffsStreaming(
        rootUri: vscode.Uri,
        files: CommitFile[],
        changeSetMode: ChangeSetMode,
        isCurrent: () => boolean,
        onProgress: (completed: number) => void,
    ): Promise<DiffPayload[]> {
        const data = await this.readWorkingTreeDiffs(rootUri, files, changeSetMode, onProgress);
        if (!isCurrent()) { return []; }
        onProgress(files.length);
        return data;
    }

    /** 纯读取入口，不写 Store；以回调返回已完成文件数。 */
    async readDiffs(
        rootUri: vscode.Uri,
        hash: string,
        files: CommitFile[],
        changeSetMode: ChangeSetMode,
        indexOffset = 0,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<DiffPayload[]> {
        if (changeSetMode !== 'commit') {
            const readerGeneration = ++this.requestGeneration;
            const isCurrent = () => readerGeneration === this.requestGeneration;
            const data = await this.readWorkingTreeDiffsStreaming(
                rootUri,
                files,
                changeSetMode,
                isCurrent,
                completed => onProgress?.(completed, files.length),
            );
            if (!isCurrent()) { return []; }
            return indexOffset === 0 ? data : data.map(payload => new DiffPayload({ ...payload, index: payload.index + indexOffset }));
        }
        const readerGeneration = ++this.requestGeneration;
        const isCurrent = () => readerGeneration === this.requestGeneration;
        const data = await this.readCommitDiffsStreaming(rootUri, hash, files, isCurrent, completed => onProgress?.(completed, files.length));
        if (!isCurrent()) { return []; }
        return indexOffset === 0 ? data : data.map(payload => new DiffPayload({ ...payload, index: payload.index + indexOffset }));
    }

    /** 仅刷新已有 Diff 里的 gitlink 展示内容，不重新读取普通文件对象。 */
    updateGitlinkPayloads(diffs: readonly DiffPayload[], files: readonly CommitFile[]): DiffPayload[] {
        const filesByKey = new Map(files.map(file => [file.diffKey || file.path, file]));
        return diffs.map((diff, index) => {
            if (!diff.isGitlink) { return diff; }
            const file = filesByKey.get(diff.diffKey || diff.path);
            if (!file) { return diff; }
            const original = file.status === 'A' ? '' : this.createGitlinkText(file.oldGitlinkCommit, file.oldObjectId);
            const modified = file.status === 'D' ? '' : this.createGitlinkRangeText(file.gitlinkRangeCommits ?? [], file.newGitlinkCommit, file.newObjectId);
            return new DiffPayload({
                ...diff,
                index,
                oldObjectId: file.oldObjectId,
                newObjectId: file.newObjectId,
                oldGitlinkCommit: file.oldGitlinkCommit,
                newGitlinkCommit: file.newGitlinkCommit,
                gitlinkRangeCommits: file.gitlinkRangeCommits,
                gitlinkScanPending: file.gitlinkScanPending,
                original,
                modified,
            });
        });
    }

    private createGitlinkText(commit: CommitFile['oldGitlinkCommit'] | undefined, objectId: string | undefined): string {
        const hash = commit?.shortHash || objectId?.slice(0, 7);
        return hash ? `Submodule commit ${hash}${commit?.message ? `\n\n${commit.message}` : ''}` : '';
    }

    private createGitlinkRangeText(commits: readonly NonNullable<CommitFile['gitlinkRangeCommits']>[number][], fallback: CommitFile['newGitlinkCommit'] | undefined, objectId: string | undefined): string {
        const range = commits.length > 0 ? commits : (fallback ? [fallback] : []);
        if (range.length === 0) { return this.createGitlinkText(undefined, objectId); }
        return range.map(commit => this.createGitlinkText(commit, commit.hash)).join('\n\n');
    }

    /** 优先按不可变对象 ID 读取，避免长驻 cat-file 会话缓存旧 index 后让 `:path` 返回过期内容。 */
    private objectRef(objectId: string | undefined, fallback: string): string {
        return objectId && !/^0+$/.test(objectId) ? objectId : fallback;
    }

    private createCommitPayloads(
        rootUri: vscode.Uri,
        hash: string,
        files: CommitFile[],
        contents: Map<string, string>,
        indexOffset = 0,
    ): DiffPayload[] {
        return files.map((file, index) => {
            if (file.isGitlink) {
                return new DiffPayload({
                    index: index + indexOffset,
                    path: file.path,
                    fullPath: path.join(rootUri.fsPath, file.path),
                    oldPath: file.oldPath,
                    status: file.status,
                    oldObjectId: file.oldObjectId,
                    newObjectId: file.newObjectId,
                    oldMode: file.oldMode,
                    newMode: file.newMode,
                    isGitlink: true,
                    oldGitlinkCommit: file.oldGitlinkCommit,
                    newGitlinkCommit: file.newGitlinkCommit,
                    gitlinkRangeCommits: file.gitlinkRangeCommits,
                    gitlinkScanPending: true,
                    isUntracked: file.isUntracked,
                    isConflict: file.isConflict,
                    workingTreeKind: file.workingTreeKind,
                    diffKey: file.diffKey,
                    original: file.status === 'A' ? '' : this.createGitlinkText(file.oldGitlinkCommit, file.oldObjectId),
                    modified: file.status === 'D' ? '' : this.createGitlinkRangeText(file.gitlinkRangeCommits ?? [], file.newGitlinkCommit, file.newObjectId),
                });
            }
            const originalObject = file.isBinary || file.status === 'A'
                ? undefined
                : this.objectRef(file.oldObjectId, `${hash}^:${file.oldPath || file.path}`);
            const modifiedObject = file.isBinary || file.status === 'D'
                ? undefined
                : this.objectRef(file.newObjectId, `${hash}:${file.path}`);
            const original = originalObject ? contents.get(originalObject) : '';
            const modified = modifiedObject ? contents.get(modifiedObject) : '';
            const isBinary = file.isBinary || containsNul(original) || containsNul(modified);
            if (isBinary) {
                return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, isConflict: file.isConflict, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: true, original: '', modified: '', error: undefined });
            }
            const missing = [originalObject, modifiedObject].find(object => object && !contents.has(object));
            return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, isConflict: file.isConflict, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: false, original: original || '', modified: modified || '', error: missing ? `无法读取 Git 对象：${missing}` : undefined });
        });
    }

    private async readWorkingTreeDiffs(rootUri: vscode.Uri, files: CommitFile[], changeSetMode: ChangeSetMode, onProgress?: (completed: number) => void, indexOffset = 0): Promise<DiffPayload[]> {
        const readsIndex = (file: CommitFile) => changeSetMode === 'uncommitted' && file.workingTreeKind === 'staged';
        const originalRef = (file: CommitFile) => readsIndex(file) ? 'HEAD' : '';
        const objects: string[] = [];
        for (const file of files) {
            if (file.isBinary || file.isGitlink) { continue; }
            if (file.status !== 'A') {
                objects.push(this.objectRef(file.oldObjectId, `${originalRef(file)}:${file.oldPath || file.path}`));
            }
            if (readsIndex(file) && file.status !== 'D') {
                objects.push(this.objectRef(file.newObjectId, `:${file.path}`));
            }
        }
        const contents = await this.readGitObjects(rootUri, objects);
        const readFile = async (file: CommitFile, index: number): Promise<DiffPayload> => {
            if (file.isGitlink) {
                return new DiffPayload({
                    index: index + indexOffset,
                    path: file.path,
                    fullPath: path.join(rootUri.fsPath, file.path),
                    oldPath: file.oldPath,
                    status: file.status,
                    oldObjectId: file.oldObjectId,
                    newObjectId: file.newObjectId,
                    oldMode: file.oldMode,
                    newMode: file.newMode,
                    isGitlink: true,
                    oldGitlinkCommit: file.oldGitlinkCommit,
                    newGitlinkCommit: file.newGitlinkCommit,
                    gitlinkRangeCommits: file.gitlinkRangeCommits,
                    gitlinkScanPending: true,
                    isUntracked: file.isUntracked,
                    isConflict: file.isConflict,
                    workingTreeKind: file.workingTreeKind,
                    diffKey: file.diffKey,
                    original: file.status === 'A' ? '' : this.createGitlinkText(file.oldGitlinkCommit, file.oldObjectId),
                    modified: file.status === 'D' ? '' : this.createGitlinkRangeText(file.gitlinkRangeCommits ?? [], file.newGitlinkCommit, file.newObjectId),
                });
            }
            const fromIndex = readsIndex(file);
            const originalObject = file.isBinary || file.status === 'A'
                ? undefined
                : this.objectRef(file.oldObjectId, `${originalRef(file)}:${file.oldPath || file.path}`);
            const modifiedObject = file.isBinary || file.status === 'D' || !fromIndex
                ? undefined
                : this.objectRef(file.newObjectId, `:${file.path}`);
            const original = originalObject ? contents.get(originalObject) || '' : '';
            const workingTreeFile = file.isBinary || fromIndex || file.status === 'D'
                ? { content: '', error: undefined }
                : await this.readWorkingTreeFile(rootUri, file.path);
            const modified = fromIndex
                ? (modifiedObject ? contents.get(modifiedObject) || '' : '')
                : workingTreeFile.content;
            // 已移除 numstat, isBinary 靠内容侧 NUL 探测判定。
            const isBinary = file.isBinary || containsNul(original) || containsNul(modified);
            if (isBinary) {
                return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, isConflict: file.isConflict, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: true, original: '', modified: '', error: workingTreeFile.error });
            }
            return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, isConflict: file.isConflict, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: false, original, modified, error: workingTreeFile.error });
        };
        const results = new Array<DiffPayload>(files.length);
        let nextIndex = 0;
        let completed = 0;
        const workerCount = Math.min(MAX_WORKTREE_READ_CONCURRENCY, files.length);
        const worker = async (): Promise<void> => {
            while (true) {
                const index = nextIndex++;
                if (index >= files.length) { return; }
                results[index] = await readFile(files[index], index);
                completed++;
                onProgress?.(completed);
            }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return results;
    }

    private async readWorkingTreeFile(rootUri: vscode.Uri, filePath: string): Promise<{ content: string; error?: string }> {
        try {
            const uri = vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
            return { content: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: '', error: `无法读取工作区文件：${filePath}（${message}）` };
        }
    }

    private readGitObjects(rootUri: vscode.Uri, objects: string[]): Promise<Map<string, string>> {
        return this.readGitObjectsStreaming(rootUri, objects);
    }

    private readGitObjectsStreaming(
        rootUri: vscode.Uri,
        objects: string[],
    ): Promise<Map<string, string>> {
        return this.gitBackend.readObjects(rootUri, objects);
    }

}
