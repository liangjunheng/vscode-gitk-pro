import * as vscode from 'vscode';
import type { WorkingTreeChanges } from '../types';

/** Git 工作区与对象读取边界，由 libgit2 原生后端实现。 */
export interface GitBackend extends vscode.Disposable {
    warmup(rootUri: vscode.Uri): Promise<void>;
    readObjects(rootUri: vscode.Uri, objects: readonly string[]): Promise<Map<string, string>>;
    getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getWorkingTreeStatusForPaths(rootUri: vscode.Uri, paths: readonly string[], signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>>;
    hasWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean>;
    stage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    unstage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    discardWorktree(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
}