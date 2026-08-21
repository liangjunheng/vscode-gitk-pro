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
 * 1. prepare() 按 128 个/批切分，所有批次经 Promise.all 并发读取
 * 2. 每批通过 readDiffs() 获取 DiffPayload[]，完成即累加 diffProgress
 * 3. 全部批次结束后按 index 排序，以完整 DiffPayload 一次性写回 store.files
 * 4. 完成后 store.diffLoading = false 通知渲染完毕
 */
export class DiffReader {
    // 批次并发读取，同时可能存在多个 git cat-file 子进程。
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

    /** 分批并发读取 Diff，全部完成后一次性写入 Store */
    async prepare(rootUri: vscode.Uri, hash: string, files: CommitFile[], changeSetMode: ChangeSetMode, generation: number): Promise<void> {
        const readerGeneration = ++this.requestGeneration;
        const isCurrent = () => readerGeneration === this.requestGeneration && generation === store.getState().diffGeneration;
        const batchSize = 128;
        const total = files.length;
        try {
            store.setState({ diffProgress: { completed: 0, total } });
            // 单批（含小仓库常见情形）直接读取，避免多余的切批与并发调度开销。
            if (total <= batchSize) {
                const diffs = await this.readDiffs(rootUri, hash, files, changeSetMode, 0);
                if (!isCurrent()) { return; }
                store.setState({ diffProgress: { completed: total, total }, files: diffs, diffLoading: false });
                return;
            }
            // 多批时并发读取；每批完成即累加进度，全部结束后才一次性写回 files。
            const batches: { start: number; files: CommitFile[] }[] = [];
            for (let start = 0; start < total; start += batchSize) {
                batches.push({ start, files: files.slice(start, start + batchSize) });
            }
            let completed = 0;
            const results = await Promise.all(batches.map(async batch => {
                const diffs = await this.readDiffs(rootUri, hash, batch.files, changeSetMode, batch.start);
                if (!isCurrent()) { return diffs; }
                completed = Math.min(completed + batch.files.length, total);
                store.setState({ diffProgress: { completed, total } });
                return diffs;
            }));
            if (!isCurrent()) { return; }
            // 完整 Diff 就绪后一次性替换共享文件数据；并发完成序不定，按 index 恢复文件顺序。
            const data = results.flat().sort((left, right) => left.index - right.index);
            store.setState({ files: data, diffLoading: false });
        } catch (error) {
            if (!isCurrent()) { return; }
            const message = error instanceof Error ? error.message : String(error);
            store.setState({ diffError: message, diffLoading: false });
        }
    }

    /**
     * 纯读取: 组装 DiffPayload[] 并返回, 不写 Store 不做代次判断。
     * prepare() 在此之上加了分批/进度/写 Store, 需要副作用时才用 prepare。
     */
    async readDiffs(rootUri: vscode.Uri, hash: string, files: CommitFile[], changeSetMode: ChangeSetMode, indexOffset = 0): Promise<DiffPayload[]> {
        if (changeSetMode !== 'commit') {
            return this.readWorkingTreeDiffs(rootUri, files, changeSetMode, indexOffset);
        }
        const objects: string[] = [];
        for (const file of files) {
            if (file.isBinary) { continue; }
            if (file.status !== 'A') { objects.push(`${hash}^:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { objects.push(`${hash}:${file.path}`); }
        }
        const contents = await this.readGitObjects(rootUri, objects);
        return files.map((file, index) => {
            const originalObject = file.isBinary || file.status === 'A' ? undefined : `${hash}^:${file.oldPath || file.path}`;
            const modifiedObject = file.isBinary || file.status === 'D' ? undefined : `${hash}:${file.path}`;
            const original = originalObject ? contents.get(originalObject) : '';
            const modified = modifiedObject ? contents.get(modifiedObject) : '';
            // 已移除 numstat, isBinary 全部靠内容侧 NUL 探测判定, 避免把二进制当文本渲染。
            const isBinary = file.isBinary || containsNul(original) || containsNul(modified);
            if (isBinary) {
                return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isBinary: true, original: '', modified: '', error: undefined });
            }
            const missing = [originalObject, modifiedObject].find(object => object && !contents.has(object));
            return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isBinary: false, original: original || '', modified: modified || '', error: missing ? `无法读取 Git 对象：${missing}` : undefined });
        });
    }

    private async readWorkingTreeDiffs(rootUri: vscode.Uri, files: CommitFile[], changeSetMode: ChangeSetMode, indexOffset = 0): Promise<DiffPayload[]> {
        const originalRef = changeSetMode === 'staged' ? 'HEAD' : '';
        const objects: string[] = [];
        for (const file of files) {
            if (file.isBinary) { continue; }
            if (file.status !== 'A') { objects.push(`${originalRef}:${file.oldPath || file.path}`); }
            if (file.status !== 'D') { objects.push(`:${file.path}`); }
        }
        const contents = await this.readGitObjects(rootUri, objects);
        return Promise.all(files.map(async (file, index) => {
            const originalObject = file.isBinary || file.status === 'A' ? undefined : `${originalRef}:${file.oldPath || file.path}`;
            const modifiedObject = file.isBinary || file.status === 'D' ? undefined : `:${file.path}`;
            const original = originalObject ? contents.get(originalObject) || '' : '';
            const workingTreeFile = file.isBinary || changeSetMode === 'staged' || file.status === 'D'
                ? { content: '', error: undefined }
                : await this.readWorkingTreeFile(rootUri, file.path);
            const modified = changeSetMode === 'staged'
                ? (modifiedObject ? contents.get(modifiedObject) || '' : '')
                : workingTreeFile.content;
            // 已移除 numstat, isBinary 靠内容侧 NUL 探测判定。
            const isBinary = file.isBinary || containsNul(original) || containsNul(modified);
            if (isBinary) {
                return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isBinary: true, original: '', modified: '', error: workingTreeFile.error });
            }
            return new DiffPayload({ index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, isBinary: false, original, modified, error: workingTreeFile.error });
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
        if (objects.length === 0) { return Promise.resolve(new Map()); }
        const uniqueObjects = [...new Set(objects)];
        return new Promise((resolve, reject) => {
            const child = spawn('git', ['-C', rootUri.fsPath, 'cat-file', '--batch'], { windowsHide: true });
            this.childProcesses.add(child);
            const chunks: Buffer[] = [];
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
            child.on('error', err => {
                this.childProcesses.delete(child);
                reject(err);
            });
            child.on('close', code => {
                this.childProcesses.delete(child);
                if (code !== 0) { reject(new Error(stderr || `git cat-file 失败（退出码 ${code}）`)); return; }
                try {
                    const output = Buffer.concat(chunks);
                    const result = new Map<string, string>();
                    let offset = 0;
                    for (const object of uniqueObjects) {
                        const headerEnd = output.indexOf(0x0A, offset);
                        if (headerEnd < 0) { throw new Error('git cat-file 输出不完整'); }
                        const header = output.subarray(offset, headerEnd).toString('utf8');
                        offset = headerEnd + 1;
                        const size = Number(header.split(' ')[2]);
                        if (!Number.isFinite(size)) { continue; }
                        result.set(object, output.subarray(offset, offset + size).toString('utf8'));
                        offset += size + 1;
                    }
                    resolve(result);
                } catch (error) { reject(error); }
            });
            child.stdin.end(`${uniqueObjects.join('\n')}\n`);
        });
    }
}
