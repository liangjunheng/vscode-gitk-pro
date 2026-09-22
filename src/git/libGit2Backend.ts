import * as vscode from 'vscode';
import { CommitFile, WorkingTreeChanges, type FileStatus } from '../types';
import type { GitBackend } from './gitBackend';
import { invokeNativeGit } from './nativeGitBinding';

interface NativeCommitFile {
    path: string;
    status: FileStatus;
    oldPath?: string | null;
    oldObjectId?: string;
    newObjectId?: string;
    oldMode?: string;
    newMode?: string;
    isGitlink?: boolean;
    isConflict?: boolean;
    isUntracked?: boolean;
}

interface NativeWorkingTreeChanges {
    staged: NativeCommitFile[];
    changes: NativeCommitFile[];
}

function toCommitFile(file: NativeCommitFile): CommitFile {
    return new CommitFile({
        ...file,
        oldPath: file.oldPath ?? undefined,
    });
}

/** 基于 napi-rs + git2-rs/libgit2 的原生 Git 后端。 */
export class LibGit2Backend implements GitBackend {
    async warmup(rootUri: vscode.Uri): Promise<void> {
        await invokeNativeGit('discover', { path: rootUri.fsPath });
    }

    async readObjects(rootUri: vscode.Uri, objects: readonly string[]): Promise<Map<string, string>> {
        if (objects.length === 0) { return new Map(); }
        const values = await invokeNativeGit<Record<string, string>>('readObjects', {
            rootPath: rootUri.fsPath,
            objects: [...new Set(objects)],
        });
        return new Map(Object.entries(values));
    }

    async getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
        return this.readStatus(rootUri, [], signal);
    }

    async getWorkingTreeStatusForPaths(rootUri: vscode.Uri, paths: readonly string[], signal?: AbortSignal): Promise<WorkingTreeChanges> {
        return this.readStatus(rootUri, paths, signal);
    }

    async getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>> {
        this.throwIfAborted(signal);
        const paths = await invokeNativeGit<string[]>('indexChangedPaths', { rootPath: rootUri.fsPath });
        this.throwIfAborted(signal);
        return new Set(paths);
    }

    async hasWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean> {
        this.throwIfAborted(signal);
        const result = await invokeNativeGit<boolean>('hasChanges', { rootPath: rootUri.fsPath });
        this.throwIfAborted(signal);
        return result;
    }

    async stage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void> {
        if (paths.length === 0) { return; }
        await invokeNativeGit('stage', { rootPath: rootUri.fsPath, paths });
    }

    async unstage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void> {
        if (paths.length === 0) { return; }
        await invokeNativeGit('unstage', { rootPath: rootUri.fsPath, paths });
    }

    async discardWorktree(rootUri: vscode.Uri, paths: readonly string[]): Promise<void> {
        if (paths.length === 0) { return; }
        await invokeNativeGit('restoreWorktree', { rootPath: rootUri.fsPath, paths });
    }

    dispose(): void {}

    private async readStatus(rootUri: vscode.Uri, paths: readonly string[], signal?: AbortSignal): Promise<WorkingTreeChanges> {
        this.throwIfAborted(signal);
        const status = await invokeNativeGit<NativeWorkingTreeChanges>('status', {
            rootPath: rootUri.fsPath,
            paths,
            recurseUntrackedDirs: true,
        });
        this.throwIfAborted(signal);
        return new WorkingTreeChanges({
            staged: status.staged.map(toCommitFile),
            changes: status.changes.map(toCommitFile),
        });
    }

    private throwIfAborted(signal?: AbortSignal): void {
        if (!signal?.aborted) { return; }
        const error = new Error('请求已取消');
        error.name = 'AbortError';
        throw error;
    }
}
