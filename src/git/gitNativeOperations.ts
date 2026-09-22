import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';

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
export const createBranch = (rootUri: vscode.Uri, name: string, revision: string): Promise<void> =>
    invokeNativeGit<void>('createBranch', { rootPath: rootUri.fsPath, name, revision });
export const checkout = (rootUri: vscode.Uri, revision: string, detach = false): Promise<void> =>
    invokeNativeGit<void>('checkout', { rootPath: rootUri.fsPath, revision, detach });
export const checkoutBranch = (rootUri: vscode.Uri, branch: string): Promise<void> =>
    invokeNativeGit<void>('checkoutBranch', { rootPath: rootUri.fsPath, branch });
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
export const fetchRemotes = (rootUri: vscode.Uri, remote?: string): Promise<void> =>
    invokeNativeGit<void>('fetch', { rootPath: rootUri.fsPath, remote, prune: true });
export const pull = (rootUri: vscode.Uri, remote?: string, remoteBranch?: string, localBranch?: string): Promise<NativeSyncResult> =>
    invokeNativeGit<NativeSyncResult>('pull', { rootPath: rootUri.fsPath, remote, remoteBranch, localBranch });
export const push = (rootUri: vscode.Uri, remote?: string, localBranch?: string, remoteBranch?: string): Promise<void> =>
    invokeNativeGit<void>('push', { rootPath: rootUri.fsPath, remote, localBranch, remoteBranch });
export const updateSubmodules = (rootUri: vscode.Uri, paths: readonly string[] = []): Promise<void> =>
    invokeNativeGit<void>('updateSubmodules', { rootPath: rootUri.fsPath, paths });
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
}

export async function resolveRevision(rootUri: vscode.Uri, spec: string): Promise<string | undefined> {
    const values = await invokeNativeGit<string[]>('resolveRevision', { rootPath: rootUri.fsPath, specs: [spec] });
    return values[0];
}
export const commitDetails = (rootUri: vscode.Uri, hashes: readonly string[]): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('commitDetails', { rootPath: rootUri.fsPath, hashes });
export const rangeCommits = (rootUri: vscode.Uri, from: string, to: string): Promise<NativeCommitDetails[]> =>
    invokeNativeGit<NativeCommitDetails[]>('rangeCommits', { rootPath: rootUri.fsPath, from, to });
