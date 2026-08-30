import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { DiffPayload, type ChangeSetMode, type CommitFile } from '../types';
import { store } from '../state/store';

// git cat-file 已把内容解码为 utf8 字符串, 二进制内容会含 NUL 字符; 只探测前若干字符即可判定。
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
 * 1. prepare() 整轮只启动一个 git cat-file --batch 子进程
 * 2. 一次写入全部对象请求并流式解析 stdout，每完成 32 个文件更新进度
 * 3. stop() 终止当前子进程，代次门禁阻止旧结果落地
 * 4. 全部完成后一次性写回 store.files 并结束 diffLoading
 */
export class DiffReader {
    // stop() 终止当前整轮唯一的 git cat-file 子进程。
    private childProcesses = new Set<ChildProcess>();
    private requestGeneration = 0;

    constructor() {}

    /** 终止所有正在运行的 git cat-file 子进程 */
    stop(): void {
        this.requestGeneration++;
        for (const child of this.childProcesses) {
            try { child.kill(); } catch { /* 已退出 */ }
        }
        this.childProcesses.clear();
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
            if (file.status !== 'A') { refs.push(`${hash}^:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { refs.push(`${hash}:${file.path}`); }
            return refs;
        });
        let nextFile = 0;
        const contents = await this.readGitObjectsStreaming(rootUri, objects, parsed => {
            if (!isCurrent()) { return; }
            while (nextFile < files.length) {
                const file = files[nextFile];
                const required = file.isBinary || file.isGitlink ? [] : [
                    ...(file.status !== 'A' ? [`${hash}^:${file.oldPath || file.path}`] : []),
                    ...(file.status !== 'D' ? [`${hash}:${file.path}`] : []),
                ];
                if (!required.every(object => parsed.has(object))) { break; }
                nextFile++;
                if (nextFile % 32 === 0 || nextFile === files.length) { onProgress(nextFile); }
            }
        });
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
        const data = await this.readWorkingTreeDiffs(rootUri, files, changeSetMode);
        if (!isCurrent()) { return []; }
        for (let completed = 32; completed < files.length; completed += 32) { onProgress(completed); }
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

    private createGitlinkText(commit: CommitFile['oldGitlinkCommit'] | undefined, objectId: string | undefined): string {
        const hash = commit?.shortHash || objectId?.slice(0, 7);
        return hash ? `Submodule commit ${hash}${commit?.message ? `\n\n${commit.message}` : ''}` : '';
    }

    private createGitlinkRangeText(commits: readonly NonNullable<CommitFile['gitlinkRangeCommits']>[number][], fallback: CommitFile['newGitlinkCommit'] | undefined, objectId: string | undefined): string {
        const range = commits.length > 0 ? commits : (fallback ? [fallback] : []);
        if (range.length === 0) { return this.createGitlinkText(undefined, objectId); }
        return range.map(commit => this.createGitlinkText(commit, commit.hash)).join('\n\n');
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
                    gitlinkScanPending: file.gitlinkScanPending,
                    isUntracked: file.isUntracked,
                    workingTreeKind: file.workingTreeKind,
                    diffKey: file.diffKey,
                    original: file.status === 'A' ? '' : this.createGitlinkText(file.oldGitlinkCommit, file.oldObjectId),
                    modified: file.status === 'D' ? '' : this.createGitlinkRangeText(file.gitlinkRangeCommits ?? [], file.newGitlinkCommit, file.newObjectId),
                });
            }
            const originalObject = file.isBinary || file.status === 'A' ? undefined : `${hash}^:${file.oldPath || file.path}`;
            const modifiedObject = file.isBinary || file.status === 'D' ? undefined : `${hash}:${file.path}`;
            const original = originalObject ? contents.get(originalObject) : '';
            const modified = modifiedObject ? contents.get(modifiedObject) : '';
            const isBinary = file.isBinary || containsNul(original) || containsNul(modified);
            if (isBinary) {
                return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: true, original: '', modified: '', error: undefined });
            }
            const missing = [originalObject, modifiedObject].find(object => object && !contents.has(object));
            return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: false, original: original || '', modified: modified || '', error: missing ? `无法读取 Git 对象：${missing}` : undefined });
        });
    }

    private async readWorkingTreeDiffs(rootUri: vscode.Uri, files: CommitFile[], changeSetMode: ChangeSetMode, indexOffset = 0): Promise<DiffPayload[]> {
        const readsIndex = (file: CommitFile) => changeSetMode === 'staged'
            || (changeSetMode === 'uncommitted' && file.workingTreeKind === 'staged');
        const originalRef = (file: CommitFile) => readsIndex(file) ? 'HEAD' : '';
        const objects: string[] = [];
        for (const file of files) {
            if (file.isBinary || file.isGitlink) { continue; }
            if (file.status !== 'A') { objects.push(`${originalRef(file)}:${file.oldPath || file.path}`); }
            if (readsIndex(file) && file.status !== 'D') { objects.push(`:${file.path}`); }
        }
        const contents = await this.readGitObjects(rootUri, objects);
        return Promise.all(files.map(async (file, index) => {
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
                    gitlinkScanPending: file.gitlinkScanPending,
                    isUntracked: file.isUntracked,
                    workingTreeKind: file.workingTreeKind,
                    diffKey: file.diffKey,
                    original: file.status === 'A' ? '' : this.createGitlinkText(file.oldGitlinkCommit, file.oldObjectId),
                    modified: file.status === 'D' ? '' : this.createGitlinkRangeText(file.gitlinkRangeCommits ?? [], file.newGitlinkCommit, file.newObjectId),
                });
            }
            const fromIndex = readsIndex(file);
            const originalObject = file.isBinary || file.status === 'A' ? undefined : `${originalRef(file)}:${file.oldPath || file.path}`;
            const modifiedObject = file.isBinary || file.status === 'D' || !fromIndex ? undefined : `:${file.path}`;
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
                return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: true, original: '', modified: '', error: workingTreeFile.error });
            }
            return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isUntracked: file.isUntracked, workingTreeKind: file.workingTreeKind, diffKey: file.diffKey, isBinary: false, original, modified, error: workingTreeFile.error });
        }));
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
        onObject?: (contents: ReadonlyMap<string, string>) => void,
    ): Promise<Map<string, string>> {
        if (objects.length === 0) { return Promise.resolve(new Map()); }
        const uniqueObjects = [...new Set(objects)];
        return new Promise((resolve, reject) => {
            const child = spawn('git', ['--no-optional-locks', '-C', rootUri.fsPath, 'cat-file', '--batch'], { windowsHide: true });
            this.childProcesses.add(child);
            const result = new Map<string, string>();
            let stderr = '';
            let buffer: Buffer = Buffer.alloc(0);
            let objectIndex = 0;
            let settled = false;
            const fail = (error: unknown) => {
                if (settled) { return; }
                settled = true;
                this.childProcesses.delete(child);
                reject(error);
            };
            const parse = () => {
                while (objectIndex < uniqueObjects.length) {
                    const headerEnd = buffer.indexOf(0x0A);
                    if (headerEnd < 0) { return; }
                    const header = buffer.subarray(0, headerEnd).toString('utf8');
                    const size = Number(header.split(' ')[2]);
                    if (!Number.isFinite(size)) {
                        buffer = buffer.subarray(headerEnd + 1);
                        objectIndex++;
                        onObject?.(result);
                        continue;
                    }
                    const contentStart = headerEnd + 1;
                    const responseEnd = contentStart + size + 1;
                    if (buffer.length < responseEnd) { return; }
                    result.set(uniqueObjects[objectIndex], buffer.subarray(contentStart, contentStart + size).toString('utf8'));
                    buffer = buffer.subarray(responseEnd);
                    objectIndex++;
                    onObject?.(result);
                }
            };
            child.stdout.on('data', (chunk: Buffer) => {
                buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
                try { parse(); } catch (error) { fail(error); }
            });
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
            child.on('error', fail);
            child.on('close', code => {
                this.childProcesses.delete(child);
                if (settled) { return; }
                if (code !== 0) { fail(new Error(stderr || `git cat-file 失败（退出码 ${code}）`)); return; }
                try { parse(); } catch (error) { fail(error); return; }
                if (objectIndex !== uniqueObjects.length) { fail(new Error('git cat-file 输出不完整')); return; }
                settled = true;
                resolve(result);
            });
            child.stdin.end(`${uniqueObjects.join('\n')}\n`);
        });
    }
}
