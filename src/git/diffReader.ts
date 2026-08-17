import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { ChangeSetMode, CommitFile, DiffPayload } from '../types';
import { store } from '../state/store';

/**
 * Diff 读取器: 负责从 Git 仓库读取文件内容并写入 Store (单一数据源)
 *
 * 流程:
 * 1. prepare() 分批读取 (首批 128 个, 后续 128 个/批)
 * 2. 每批通过 readDiffs() 获取 DiffPayload[]
 * 3. 以完整 DiffPayload 写回 store.files，Changed Files 与 CustomDiffPanel 共用
 * 4. 完成后 store.diffLoading = false 通知渲染完毕
 */
export class DiffReader {
    private childProcess?: ChildProcess;
    private requestGeneration = 0;

    constructor() {}

    /** 终止正在运行的 git cat-file 子进程 */
    stop(): void {
        this.requestGeneration++;
        if (this.childProcess) {
            try { this.childProcess.kill(); } catch { /* 已退出 */ }
            this.childProcess = undefined;
        }
    }

    /** 分批读取 Diff 并写入 Store */
    async prepare(rootUri: vscode.Uri, hash: string, files: CommitFile[], changeSetMode: ChangeSetMode, generation: number): Promise<void> {
        const readerGeneration = ++this.requestGeneration;
        const isCurrent = () => readerGeneration === this.requestGeneration && generation === store.getState().diffGeneration;
        const batchSize = 128;
        const total = files.length;
        try {
            const data: DiffPayload[] = [];
            store.setState({ diffProgress: { completed: 0, total } });
            for (let start = 0; start < total;) {
                const batch = files.slice(start, start + batchSize);
                const diffs = await this.readDiffs(rootUri, hash, batch, changeSetMode, start);
                if (!isCurrent()) { return; }
                data.push(...diffs);
                const completed = Math.min(start + batch.length, total);
                store.setState({ diffProgress: { completed, total } });
                start += batch.length;
            }
            if (!isCurrent()) { return; }
            // 完整 Diff 就绪后一次性替换共享文件数据，避免两个视图读取不同快照。
            store.setState({ files: data, diffLoading: false });
        } catch (error) {
            if (!isCurrent()) { return; }
            const message = error instanceof Error ? error.message : String(error);
            store.setState({ diffError: message, diffLoading: false });
        }
    }

    private async readDiffs(rootUri: vscode.Uri, hash: string, files: CommitFile[], changeSetMode: ChangeSetMode, indexOffset = 0): Promise<DiffPayload[]> {
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
            const missing = [originalObject, modifiedObject].find(object => object && !contents.has(object));
            return { index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, addedLines: file.addedLines, removedLines: file.removedLines, isBinary: file.isBinary, original: original || '', modified: modified || '', error: missing ? `无法读取 Git 对象：${missing}` : undefined };
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
            return { index: index + indexOffset, path: file.path, fullPath: path.join(rootUri.fsPath, file.path), oldPath: file.oldPath, status: file.status, oldObjectId: file.oldObjectId, newObjectId: file.newObjectId, oldMode: file.oldMode, newMode: file.newMode, addedLines: file.addedLines, removedLines: file.removedLines, isBinary: file.isBinary, original, modified, error: workingTreeFile.error };
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
            this.childProcess = child;
            const chunks: Buffer[] = [];
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
            child.on('error', err => {
                if (this.childProcess === child) { this.childProcess = undefined; }
                reject(err);
            });
            child.on('close', code => {
                if (this.childProcess === child) { this.childProcess = undefined; }
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
